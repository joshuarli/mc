import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const code = String.fromCharCode(96);

function fail(message) {
  process.stderr.write("compatibility check: " + message + "\n");
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

const lockText = readFileSync(join(root, "versions.lock.toml"), "utf8");
function lockedValue(section, key) {
  const sectionHeader = "[" + section + "]";
  const lines = lockText.split(/\r?\n/);
  let active = false;
  let sectionCount = 0;
  const values = [];
  for (const line of lines) {
    if (line.startsWith("[")) {
      active = line === sectionHeader;
      if (active) sectionCount += 1;
      continue;
    }
    if (active) {
      const match = line.match(new RegExp("^" + key + " = (.+)$"));
      if (match) values.push(match[1]);
    }
  }
  if (sectionCount !== 1 || values.length !== 1) fail("versions.lock.toml must define one " + section + "." + key);
  const raw = values[0];
  if (raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw);
  if (/^(0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
  fail("versions.lock.toml " + section + "." + key + " is not a supported scalar");
}

function packageVersion(manifest, name, field) {
  const version = manifest[field]?.[name];
  if (typeof version !== "string" || !version) fail(manifest.name + " must pin " + field + "." + name);
  return version;
}

const rootManifest = readJson("package.json");
const lockfile = readJson("package-lock.json");
const botsManifest = readJson("packages/arena-bots/package.json");
const docs = readFileSync(join(root, "docs/compatibility.md"), "utf8");
const minecraftVersion = lockedValue("minecraft", "version");
const minecraftProtocol = lockedValue("minecraft", "protocol");
const nodeVersion = lockedValue("node", "version");
const npmVersion = lockedValue("node", "npm_version");
const typescriptVersion = packageVersion(rootManifest, "typescript", "devDependencies");
const mineflayerVersion = packageVersion(botsManifest, "mineflayer", "dependencies");
const pathfinderVersion = packageVersion(botsManifest, "mineflayer-pathfinder", "dependencies");
const protocolPackageVersion = lockfile.packages["node_modules/minecraft-protocol"]?.version;

if (lockfile.packages["node_modules/typescript"]?.version !== typescriptVersion) {
  fail("package-lock.json does not resolve the pinned TypeScript version");
}
if (lockfile.packages["node_modules/mineflayer"]?.version !== mineflayerVersion) {
  fail("package-lock.json does not resolve the pinned Mineflayer version");
}
if (lockfile.packages["node_modules/mineflayer-pathfinder"]?.version !== pathfinderVersion) {
  fail("package-lock.json does not resolve the pinned mineflayer-pathfinder version");
}
if (typeof protocolPackageVersion !== "string") {
  fail("package-lock.json does not resolve minecraft-protocol");
}

const javaVersion = lockedValue("java", "distribution") + " JDK " + lockedValue("java", "build") + "; runtime build " + code + lockedValue("java", "runtime_build") + code;
const javaRelease = lockedValue("java", "version");
if (!javaVersion.includes(javaRelease)) fail("Java runtime build does not match its release version");
const gradleVersion = lockedValue("gradle", "version");
const paperVersion = lockedValue("paper", "version");
const minecraftMinor = minecraftVersion.split(".").slice(0, 2).join(".");
const paperChannel = lockedValue("paper", "channel").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
const rows = [
  "| Minecraft | " + minecraftVersion + ", protocol " + minecraftProtocol + " |",
  "| Node.js and npm | Node.js " + nodeVersion + ", npm " + npmVersion + " |",
  "| TypeScript | " + typescriptVersion + " |",
  "| Mineflayer | " + mineflayerVersion + " with mineflayer-pathfinder " + pathfinderVersion + "; its published version list includes Minecraft " + minecraftMinor + " |",
  "| Paper server | " + paperChannel + " " + paperVersion + " build " + lockedValue("paper", "server_build") + ", " + code + lockedValue("paper", "server_file") + code + " |",
  "| Paper API | " + code + lockedValue("paper", "api_group") + ":" + lockedValue("paper", "api_artifact") + ":" + lockedValue("paper", "api_version") + code + ", plugin API version " + code + lockedValue("paper", "plugin_api_version") + code + " |",
  "| Java | " + javaVersion + " |",
  "| Gradle | " + gradleVersion + " wrapper; wrapper JAR and distribution SHA-256 are checked against " + code + "versions.lock.toml" + code + " |"
];

for (const row of rows) {
  const count = docs.split(/\r?\n/).filter((line) => line === row).length;
  if (count !== 1) fail("docs/compatibility.md must contain exactly one current matrix row: " + row);
}

if (!docs.includes("and " + code + "minecraft-protocol" + code + " " + protocolPackageVersion + " advertise Minecraft " + minecraftMinor + " support")) {
  fail("docs/compatibility.md must describe the pinned protocol support evidence");
}
