import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, createWriteStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createBot, type Bot } from "mineflayer";
import { test } from "node:test";

const root = process.cwd();
const startupLimitMs = 180_000;
const shutdownLimitMs = 15_000;
const maxLogLines = 4_096;
const maxLogLineCharacters = 1_024;
const maxPacketBytes = 1_048_581;

interface BotSession {
  bot: Bot;
  errors: Error[];
  endSignal: Promise<void>;
  ended: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function lockedValue(section: string, key: string): string {
  const lines = readFileSync(join(root, "versions.lock.toml"), "utf8").split(/\r?\n/);
  let active = false;
  const values: string[] = [];
  for (const line of lines) {
    if (line.startsWith("[")) {
      active = line === `[${section}]`;
      continue;
    }
    if (active && line.startsWith(`${key} = `)) values.push(line.slice(key.length + 3).trim());
  }
  if (values.length !== 1) fail(`versions.lock.toml must define one ${section}.${key}`);
  const value = values.at(0);
  if (value === undefined) return fail(`versions.lock.toml must define one ${section}.${key}`);
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (/^(0|[1-9][0-9]*)$/.test(value)) return value;
  return fail(`versions.lock.toml ${section}.${key} is not a supported string or integer`);
}

function lockedInteger(section: string, key: string): number {
  const value = Number(lockedValue(section, key));
  if (!Number.isSafeInteger(value) || value < 0) fail(`versions.lock.toml ${section}.${key} must be a nonnegative safe integer`);
  return value;
}

function ensureRealDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`working directory must be a real directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path);
  }
}

function createRunDirectory(): string {
  const runs = join(root, ".work", "arena", "runs");
  ensureRealDirectory(runs);
  return mkdtempSync(join(runs, "stack-"));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} exceeded ${milliseconds} ms`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function freeLoopbackPort(): Promise<number> {
  const listener = createServer();
  let port: number | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (address === null || typeof address === "string") fail("could not read an available loopback port");
    port = address.port;
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  if (listener.listening) {
    try {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    } catch (cleanupError) {
      if (!hasPrimaryError) throw cleanupError;
      process.stderr.write(`stack smoke port reservation cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    }
  }
  if (hasPrimaryError) throw primaryError;
  if (port === undefined) return fail("could not read an available loopback port");
  return port;
}

class PaperServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  private readonly log: WriteStream;
  private readonly remainders = new Map<string, string>();
  private childError: Error | undefined;
  private inputError: Error | undefined;
  private logError: Error | undefined;
  private stopped = false;
  private processClosed = false;

  constructor(java: string, paperJar: string, runDirectory: string, logPath: string, javaTmpDir: string) {
    this.log = createWriteStream(logPath, { flags: "wx" });
    this.log.on("error", (error) => { this.logError = error; });
    this.child = spawn(java, [
      "-Xms512m",
      "-Xmx2g",
      `-Djava.io.tmpdir=${javaTmpDir}`,
      "-Darena.test-fixture=true",
      "-Dterminal.jline=false",
      "-Dterminal.ansi=false",
      "-jar",
      paperJar,
      "--nogui"
    ], { cwd: runDirectory, stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", (error) => { this.childError = error; });
    this.child.once("close", () => { this.processClosed = true; });
    this.child.stdin.on("error", (error) => { this.inputError = error; });
    this.capture(this.child.stdout, "stdout");
    this.capture(this.child.stderr, "stderr");
  }

  hasLine(fragment: string): boolean {
    return this.lines.some((line) => line.includes(fragment));
  }

  tail(): string {
    return this.lines.slice(-80).join("\n");
  }

  private appendLines(lines: string[]): void {
    this.lines.push(...lines.map((line) => line.slice(-maxLogLineCharacters)));
    if (this.lines.length > maxLogLines) this.lines.splice(0, this.lines.length - maxLogLines);
  }

  async waitReady(port: number, protocol: number): Promise<void> {
    const ready = `ARENA_READY|protocol=${protocol}|port=${port}`;
    await this.waitFor(() => this.hasLine(ready), startupLimitMs, "Paper readiness marker");
    if (!this.lines.some((line) => line.includes("Starting Minecraft server on") && line.includes(`127.0.0.1:${port}`))) {
      throw new Error(`Paper did not confirm loopback-only binding at 127.0.0.1:${port}\n${this.tail()}`);
    }
    await waitForLoopback(port);
  }

  async waitForMarkers(markers: string[], timeoutMs: number): Promise<void> {
    await this.waitFor(() => markers.every((marker) => this.hasLine(marker)), timeoutMs, `Paper events: ${markers.join(", ")}`);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.write("stop\n");
      this.child.stdin.end();
      const stopped = await this.waitForExit(shutdownLimitMs);
      if (!stopped) {
        this.child.kill("SIGKILL");
        const killed = await this.waitForExit(shutdownLimitMs);
        this.stopped = true;
        if (killed) await this.finishLog();
        else this.log.destroy();
        throw new Error(killed
          ? `Paper exceeded the ${shutdownLimitMs} ms graceful shutdown limit and was killed\n${this.tail()}`
          : `Paper did not exit after SIGKILL\n${this.tail()}`);
      }
    }
    this.stopped = true;
    await this.finishLog();
    if (this.childError) throw new Error(`Paper process failed: ${this.childError.message}\n${this.tail()}`);
    if (this.inputError) throw new Error(`could not send stop command to Paper: ${this.inputError.message}\n${this.tail()}`);
    if (this.logError) throw new Error(`could not write Paper log: ${this.logError.message}`);
    if (this.child.exitCode !== 0) throw new Error(`Paper exited with code ${this.child.exitCode}\n${this.tail()}`);
  }

  private capture(stream: NodeJS.ReadableStream, name: string): void {
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk: Buffer) => {
      if (!this.log.write(chunk)) {
        stream.pause();
        this.log.once("drain", () => stream.resume());
      }
      const text = this.remainders.get(name) ?? "";
      const parts = (text + decoder.write(chunk)).split(/\r?\n/);
      const remainder = parts.pop() ?? "";
      this.remainders.set(name, remainder.slice(-maxLogLineCharacters));
      this.appendLines(parts);
    });
    stream.on("end", () => {
      const tail = (this.remainders.get(name) ?? "") + decoder.end();
      if (tail) this.appendLines([tail]);
    });
  }

  private async waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (this.childError) throw new Error(`Paper process failed: ${this.childError.message}\n${this.tail()}`);
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`Paper exited before ${description} (code ${this.child.exitCode}, signal ${this.child.signalCode})\n${this.tail()}`);
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}\n${this.tail()}`);
      await delay(50);
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.processClosed) return true;
    return Promise.race([
      new Promise<boolean>((resolve) => this.child.once("close", () => resolve(true))),
      delay(timeoutMs).then(() => false)
    ]);
  }

  private async finishLog(): Promise<void> {
    if (this.log.writableFinished) return;
    await new Promise<void>((resolve, reject) => {
      this.log.once("error", reject);
      this.log.once("finish", resolve);
      this.log.end();
    });
  }
}

async function waitForLoopback(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(1_000, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (connected) return;
    await delay(50);
  }
  throw new Error(`Paper did not accept a loopback connection on port ${port}`);
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while ((remaining & ~0x7f) !== 0) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function encodeProtocolString(value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([encodeVarInt(content.length), content]);
}

function readVarInt(input: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (shift < 35) {
    if (cursor >= input.length) fail("truncated Minecraft VarInt");
    const byte = input[cursor++];
    if (byte === undefined) fail("truncated Minecraft VarInt");
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  return fail("Minecraft VarInt exceeded five bytes");
}

function readProtocolString(input: Buffer, offset: number): { value: string; next: number } {
  const length = readVarInt(input, offset);
  if (length.value < 0 || length.value > 1_048_576) fail(`invalid Minecraft string length ${length.value}`);
  const end = length.next + length.value;
  if (end > input.length) fail("truncated Minecraft string");
  return { value: input.subarray(length.next, end).toString("utf8"), next: end };
}

async function rejectWrongProtocol(port: number, wrongProtocol: number): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }), 5_000, "wrong-version loopback connection");

    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port);
    const body = Buffer.concat([
      encodeVarInt(0),
      encodeVarInt(wrongProtocol),
      encodeProtocolString("127.0.0.1"),
      portBytes,
      encodeVarInt(2)
    ]);
    socket.write(Buffer.concat([encodeVarInt(body.length), body]));
    const packet = await readPacket(socket, 5_000);
    const packetId = readVarInt(packet, 0);
    assert.equal(packetId.value, 0, "wrong protocol should receive a login disconnect packet");
    const reason = readProtocolString(packet, packetId.next).value;
    const diagnostic = JSON.parse(reason) as unknown;
    assert.match(JSON.stringify(diagnostic).toLowerCase(), /outdated|version|protocol/);
  } finally {
    socket.destroy();
  }
}

async function readPacket(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return withTimeout(new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      if (chunk.length > maxPacketBytes - buffered.length) {
        finish(new Error(`server packet exceeded ${maxPacketBytes} bytes`));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      let length: { value: number; next: number };
      try {
        length = readVarInt(buffered, 0);
      } catch (error) {
        if (error instanceof Error && error.message === "truncated Minecraft VarInt") return;
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (length.value <= 0 || length.value > 1_048_576) {
        finish(new Error(`invalid server packet length ${length.value}`));
        return;
      }
      if (buffered.length >= length.next + length.value) {
        finish(undefined, buffered.subarray(length.next, length.next + length.value));
      }
    };
    const onClose = (): void => finish(new Error("server closed wrong-version socket without a login rejection"));
    const onError = (error: Error): void => finish(error);
    const finish = (error?: Error, packet?: Buffer): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(packet!);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  }), timeoutMs, "wrong-version login rejection");
}

function waitForSpawn(bot: Bot): Promise<void> {
  return withTimeout(new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onEnd = (reason: string): void => finish(new Error(`client disconnected before spawn: ${reason}`));
    const finish = (error?: Error): void => {
      bot.off("spawn", onSpawn);
      bot.off("error", onError);
      bot.off("end", onEnd);
      if (error) reject(error);
      else resolve();
    };
    bot.once("spawn", onSpawn);
    bot.once("error", onError);
    bot.once("end", onEnd);
  }), 45_000, `Mineflayer login for ${bot.username}`);
}

async function connectBot(username: string, port: number, version: string): Promise<BotSession> {
  const bot = createBot({ host: "127.0.0.1", port, username, version, viewDistance: "tiny" });
  const errors: Error[] = [];
  let resolveEnd!: () => void;
  const session: BotSession = {
    bot,
    errors,
    endSignal: new Promise<void>((resolve) => { resolveEnd = resolve; }),
    ended: false
  };
  bot.on("error", (error) => { if (errors.length === 0) errors.push(error); });
  bot.once("end", () => {
    session.ended = true;
    resolveEnd();
  });
  try {
    await waitForSpawn(bot);
    await withTimeout(bot.waitForChunksToLoad(), 20_000, `chunk receipt for ${username}`);
  } catch (error) {
    try {
      bot.end("stack smoke setup failed");
      await withTimeout(session.endSignal, 5_000, `cleanup failed Mineflayer setup for ${username}`);
    } catch (cleanupError) {
      process.stderr.write(`stack smoke Mineflayer setup cleanup failed for ${username}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    }
    throw error;
  }
  return session;
}

function assertClientsHealthy(sessions: BotSession[]): void {
  for (const session of sessions) {
    const error = session.errors.at(0);
    if (error) throw new Error(`${session.bot.username} client error: ${error.message}`);
    if (session.ended) throw new Error(`${session.bot.username} disconnected unexpectedly`);
  }
}

async function waitFor(predicate: () => boolean, sessions: BotSession[], description: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assertClientsHealthy(sessions);
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(50);
  }
}

async function moveBot(session: BotSession): Promise<void> {
  const { bot } = session;
  const initial = bot.entity.position.clone();
  await bot.lookAt(initial.offset(0, 0, 4), true);
  bot.setControlState("forward", true);
  try {
    await delay(600);
  } finally {
    bot.setControlState("forward", false);
  }
  await waitFor(() => bot.entity.position.distanceTo(initial) > 0.25, [session], `${bot.username} movement`, 5_000);
}

async function transferChestItems(session: BotSession, server: PaperServer): Promise<void> {
  const { bot } = session;
  const chestPosition = bot.entity.position.floored().offset(2, 0, 0);
  const chestBlock = bot.blockAt(chestPosition);
  assert.equal(chestBlock?.name, "chest", "Mineflayer must observe the fixture chest in its loaded world");
  assert.ok(chestBlock);
  const diamond = bot.registry.itemsByName.diamond;
  assert.ok(diamond, "Mineflayer registry must contain diamond for the pinned protocol");
  const container = await withTimeout(bot.openContainer(chestBlock), 10_000, "open fixture chest");
  try {
    await withTimeout(container.withdraw(diamond.id, null, 2), 10_000, "withdraw fixture diamonds");
  } finally {
    await container.close();
  }
  await waitFor(() => bot.inventory.items().filter((item) => item.type === diamond.id).reduce((count, item) => count + item.count, 0) === 2,
    [session], "two diamonds in Mineflayer inventory", 5_000);
  await server.waitForMarkers([
    `ARENA_CHEST_OPEN|${bot.username}`,
    `ARENA_CHEST_CLICK|${bot.username}|0`,
    `ARENA_TRANSFER|${bot.username}|diamonds=2`
  ], 10_000);
}

async function attackBot(attacker: BotSession, target: BotSession, server: PaperServer): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!server.hasLine(`ARENA_DAMAGE|${attacker.bot.username}|${target.bot.username}|`)) {
    assertClientsHealthy([attacker, target]);
    if (Date.now() >= deadline) throw new Error(`Paper did not observe a damage event from ${attacker.bot.username}`);
    const entity = attacker.bot.players[target.bot.username]?.entity;
    if (entity) {
      await attacker.bot.lookAt(entity.position.offset(0, 0.9, 0), true);
      if (attacker.bot.entity.position.distanceTo(entity.position) <= 3) {
        attacker.bot.attack(entity);
        await attacker.bot.waitForTicks(8);
      } else {
        attacker.bot.setControlState("forward", true);
        try {
          await delay(250);
        } finally {
          attacker.bot.setControlState("forward", false);
        }
      }
    } else {
      await delay(50);
    }
  }
  assert.ok(server.hasLine(`ARENA_SWING|${attacker.bot.username}`), "Paper must observe the ordinary arm swing");
}

async function disconnectBot(session: BotSession): Promise<void> {
  if (session.ended) return;
  session.bot.quit("stack smoke complete");
  await withTimeout(session.endSignal, 5_000, `disconnect ${session.bot.username}`);
}

function writeServerFiles(runDirectory: string, port: number, pluginJar: string): void {
  const plugins = join(runDirectory, "plugins");
  mkdirSync(plugins);
  copyFileSync(pluginJar, join(plugins, "arena-plugin.jar"));
  writeFileSync(join(runDirectory, "eula.txt"), "eula=true\n", { flag: "wx" });
  writeFileSync(join(runDirectory, "server.properties"), [
    "server-ip=127.0.0.1",
    `server-port=${port}`,
    "online-mode=false",
    "enforce-secure-profile=false",
    "white-list=false",
    "pvp=true",
    "gamemode=survival",
    "difficulty=easy",
    "spawn-protection=0",
    "max-players=4",
    "view-distance=2",
    "simulation-distance=2",
    "level-type=minecraft:flat",
    "spawn-monsters=false",
    "spawn-animals=false",
    "enable-query=false",
    "enable-rcon=false",
    "motd=Arena local Mineflayer stack smoke",
    ""
  ].join("\n"), { flag: "wx" });
}

async function runStack(): Promise<void> {
  const runDirectory = createRunDirectory();
  let server: PaperServer | undefined;
  const clients: BotSession[] = [];
  let passed = false;
  let hasPrimaryError = false;
  try {
    const paperFile = lockedValue("paper", "server_file");
    const protocol = lockedInteger("minecraft", "protocol");
    const minecraftVersion = lockedValue("minecraft", "version");
    const mineflayerVersion = minecraftVersion.split(".").slice(0, 2).join(".");
    const paperJar = join(root, ".work", "arena", "downloads", paperFile);
    const pluginJar = join(root, ".work", "arena", "gradle-build", "libs", "arena-plugin-0.1.0.jar");
    const javaHome = process.env.JAVA_HOME;
    if (!javaHome) fail("pinned JDK is unavailable; run the arena test selector so prepare_jdk can configure JAVA_HOME");
    const java = join(javaHome, "bin", "java");
    const javaTmpDir = join(root, ".work", "tmp");
    ensureRealDirectory(javaTmpDir);
    for (const path of [paperJar, pluginJar, java, javaTmpDir]) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (path === javaTmpDir ? !stat.isDirectory() : !stat.isFile())) {
        fail(`required stack path is unavailable or linked: ${path}`);
      }
    }

    const port = await freeLoopbackPort();
    writeServerFiles(runDirectory, port, pluginJar);
    server = new PaperServer(java, paperJar, runDirectory, join(runDirectory, "paper.log"), javaTmpDir);
    await server.waitReady(port, protocol);
    await rejectWrongProtocol(port, protocol + 1);

    const first = await connectBot("ArenaOne", port, mineflayerVersion);
    clients.push(first);
    const second = await connectBot("ArenaTwo", port, mineflayerVersion);
    clients.push(second);
    await waitFor(() => first.bot.blockAt(first.bot.entity.position.floored().offset(0, -1, 0))?.name === "stone"
      && second.bot.blockAt(second.bot.entity.position.floored().offset(0, -1, 0))?.name === "stone",
    clients, "both Mineflayer clients receiving fixture chunks", 10_000);

    await moveBot(second);
    await server.waitForMarkers(["ARENA_JOIN|ArenaOne", "ARENA_JOIN|ArenaTwo", "ARENA_MOVE|ArenaTwo"], 10_000);
    await transferChestItems(first, server);
    await attackBot(first, second, server);
    await Promise.all(clients.map(disconnectBot));
    await server.waitForMarkers(["ARENA_QUIT|ArenaOne", "ARENA_QUIT|ArenaTwo"], 10_000);
    await server.stop();
    passed = true;
  } catch (error) {
    hasPrimaryError = true;
    throw error;
  } finally {
    for (const client of clients) {
      if (!client.ended) {
        try {
          await disconnectBot(client);
        } catch (error) {
          process.stderr.write(`stack smoke client cleanup failed for ${client.bot.username}: ${error instanceof Error ? error.message : String(error)}\n`);
          try {
            client.bot.end("stack smoke cleanup");
            await withTimeout(client.endSignal, 5_000, `force disconnect ${client.bot.username}`);
          } catch (forceError) {
            process.stderr.write(`stack smoke forced client cleanup failed for ${client.bot.username}: ${forceError instanceof Error ? forceError.message : String(forceError)}\n`);
          }
        }
      }
    }
    if (server) {
      try {
        await server.stop();
      } catch (error) {
        if (passed || !hasPrimaryError) throw error;
        process.stderr.write(`stack smoke Paper cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (passed) rmSync(runDirectory, { recursive: true });
    else process.stderr.write(`stack smoke failed; disposable evidence retained at ${runDirectory}\n`);
  }
}

test("stack", { timeout: 480_000 }, async () => {
  await runStack();
});
