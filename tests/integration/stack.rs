use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVER_START_LIMIT: Duration = Duration::from_secs(180);
const SMOKE_LIMIT: Duration = Duration::from_secs(90);
const SERVER_STOP_LIMIT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[test]
fn stack() {
    let mut run = RunDirectory::create().expect("create the disposable stack world");
    if let Err(error) = run_stack(&run) {
        run.retain = true;
        panic!("{error}; retained smoke evidence at {}", run.path.display());
    }
}

fn run_stack(run: &RunDirectory) -> Result<(), String> {
    let root = repo_root()?;
    let (paper_jar, expected_sha) = paper_identity(&root)?;
    let paper_jar = owned_file(&root, &paper_jar, "download the exact Paper artifact under .work/arena/downloads")?;
    verify_sha256(&paper_jar, &expected_sha)?;

    let plugin_jar = owned_file(
        &root,
        &root.join(".work/arena/gradle-build/libs/arena-plugin-0.1.0.jar"),
        "build the locked Paper plugin with ./arena test",
    )?;

    let server_port = free_loopback_port()?;
    prepare_world(run, &plugin_jar, server_port)?;

    let java = project_java(&root)?;
    let log_path = run.path.join("paper.log");
    let mut paper = PaperProcess::start(&java, &paper_jar, &run.path, &log_path)?;
    paper.wait_ready(server_port)?;
    reject_wrong_protocol(server_port).map_err(|error| paper.error_context(error))?;

    let client_log = run.path.join("clients.log");
    let client_bin = PathBuf::from(env!("CARGO_BIN_EXE_arena-smoke-client"));
    let mut clients = ClientProcess::start(&client_bin, server_port, &client_log)?;
    clients.wait_success(SMOKE_LIMIT, &paper)?;
    let client_output = fs::read_to_string(&client_log)
        .map_err(|error| format!("read smoke client output: {error}"))?;
    if !client_output.contains("ARENA_CLIENT_OK|spawn=2|chunks=2|move=1|chest=1|attack=1|disconnect=2") {
        return Err(format!(
            "smoke clients did not report the full protocol sequence; output:\n{client_output}"
        ));
    }

    paper.wait_for_markers(
        &[
            "ARENA_JOIN|ArenaOne",
            "ARENA_JOIN|ArenaTwo",
            "ARENA_MOVE|ArenaOne",
            "ARENA_CHEST_OPEN|ArenaOne",
            "ARENA_CHEST_CLICK|ArenaOne|0",
            "ARENA_TRANSFER|ArenaOne|diamonds=2",
            "ARENA_DAMAGE|ArenaOne|ArenaTwo|amount=",
            "ARENA_QUIT|ArenaOne",
            "ARENA_QUIT|ArenaTwo",
        ],
        Duration::from_secs(20),
    )?;
    paper.stop()?;
    Ok(())
}

struct RunDirectory {
    path: PathBuf,
    retain: bool,
}

impl RunDirectory {
    fn create() -> Result<Self, String> {
        let root = repo_root()?;
        let work = root.join(".work");
        let arena = work.join("arena");
        let runs = arena.join("runs");
        ensure_directory(&work, "working directory")?;
        ensure_directory(&arena, "artifact directory")?;
        ensure_directory(&runs, "stack run directory")?;
        let arena = arena
            .canonicalize()
            .map_err(|error| format!("resolve artifact directory: {error}"))?;
        let runs = runs
            .canonicalize()
            .map_err(|error| format!("resolve stack run directory: {error}"))?;
        if !runs.starts_with(&arena) {
            return Err(format!("stack run directory escaped {}", arena.display()));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("read system clock for run directory: {error}"))?;
        let path = runs.join(format!("stack-{}-{}", std::process::id(), now.as_nanos()));
        fs::create_dir(&path).map_err(|error| format!("create stack run directory: {error}"))?;
        Ok(Self { path, retain: false })
    }
}

impl Drop for RunDirectory {
    fn drop(&mut self) {
        if !self.retain {
            if let Err(error) = fs::remove_dir_all(&self.path) {
                eprintln!("could not remove stack run directory {}: {error}", self.path.display());
            }
        }
    }
}

struct PaperProcess {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    log: PathBuf,
    stopped: bool,
}

impl PaperProcess {
    fn start(java: &Path, jar: &Path, working_directory: &Path, log: &Path) -> Result<Self, String> {
        let output = File::create(log).map_err(|error| format!("create Paper log: {error}"))?;
        let error_output = output
            .try_clone()
            .map_err(|error| format!("clone Paper log handle: {error}"))?;
        let mut child = Command::new(java)
            .arg("-Xms512m")
            .arg("-Xmx2g")
            .arg("-Dterminal.jline=false")
            .arg("-Dterminal.ansi=false")
            .arg("-jar")
            .arg(jar)
            .arg("--nogui")
            .current_dir(working_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(output))
            .stderr(Stdio::from(error_output))
            .spawn()
            .map_err(|error| format!("start Paper server: {error}"))?;
        let stdin = child.stdin.take();
        Ok(Self { child, stdin, log: log.to_owned(), stopped: false })
    }

    fn wait_ready(&mut self, port: u16) -> Result<(), String> {
        let deadline = Instant::now() + SERVER_START_LIMIT;
        loop {
            if let Some(status) = self.child.try_wait().map_err(|error| self.error_context(format!("poll Paper startup: {error}")))? {
                return Err(self.error_context(format!("Paper exited before readiness with {status:?}")));
            }
            let log = read_log(&self.log)?;
            if log.contains("ARENA_READY|protocol=776|port=") && can_connect_loopback(port) {
                let expected_bind = format!("127.0.0.1:{port}");
                if !log
                    .lines()
                    .any(|line| line.contains("Starting Minecraft server on") && line.contains(&expected_bind))
                {
                    return Err(self.error_context(format!(
                        "Paper did not report a loopback-only bind at {expected_bind}"
                    )));
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(self.error_context("Paper did not become ready within 180 seconds".into()));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn wait_for_markers(&mut self, markers: &[&str], limit: Duration) -> Result<(), String> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.child.try_wait().map_err(|error| self.error_context(format!("poll Paper process: {error}")))? {
                return Err(self.error_context(format!("Paper exited before all smoke events with {status:?}")));
            }
            let log = read_log(&self.log)?;
            if markers.iter().all(|marker| log.contains(marker)) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                let missing = markers.iter().copied().filter(|marker| !log.contains(marker)).collect::<Vec<_>>();
                return Err(self.error_context(format!("timed out waiting for Paper events: {missing:?}")));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        if let Some(mut stdin) = self.stdin.take() {
            stdin
                .write_all(b"stop\n")
                .and_then(|()| stdin.flush())
                .map_err(|error| self.error_context(format!("request graceful Paper shutdown: {error}")))?;
        }
        let deadline = Instant::now() + SERVER_STOP_LIMIT;
        loop {
            if let Some(status) = self.child.try_wait().map_err(|error| self.error_context(format!("poll Paper shutdown: {error}")))? {
                self.stopped = true;
                if status.success() {
                    return Ok(());
                }
                return Err(self.error_context(format!("Paper stopped with {status:?}")));
            }
            if Instant::now() >= deadline {
                self.child
                    .kill()
                    .map_err(|error| self.error_context(format!("kill Paper after graceful shutdown deadline: {error}")))?;
                let status = self.child.wait().map_err(|error| self.error_context(format!("reap Paper after kill: {error}")))?;
                self.stopped = true;
                return Err(self.error_context(format!("Paper exceeded the 15 second graceful shutdown limit and was killed ({status:?})")));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn error_context(&self, message: String) -> String {
        match read_log(&self.log) {
            Ok(log) => format!("{message}; Paper log:\n{}", tail(&log, 80)),
            Err(error) => format!("{message}; could not read Paper log: {error}"),
        }
    }
}

impl Drop for PaperProcess {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        if let Some(mut stdin) = self.stdin.take() {
            if let Err(error) = stdin.write_all(b"stop\n").and_then(|()| stdin.flush()) {
                eprintln!("could not request graceful Paper shutdown during cleanup: {error}");
            }
        }
        let deadline = Instant::now() + SERVER_STOP_LIMIT;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => {
                    self.stopped = true;
                    return;
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
                Ok(None) => {
                    if let Err(error) = self.child.kill() {
                        eprintln!("could not kill Paper during cleanup: {error}");
                    }
                    if let Err(error) = self.child.wait() {
                        eprintln!("could not reap Paper during cleanup: {error}");
                    }
                    self.stopped = true;
                    return;
                }
                Err(error) => {
                    eprintln!("could not poll Paper during cleanup: {error}");
                    if let Err(error) = self.child.kill() {
                        eprintln!("could not kill Paper after poll failure: {error}");
                    }
                    if let Err(error) = self.child.wait() {
                        eprintln!("could not reap Paper after poll failure: {error}");
                    }
                    self.stopped = true;
                    return;
                }
            }
        }
    }
}

struct ClientProcess {
    child: Child,
    log: PathBuf,
    reaped: bool,
}

impl ClientProcess {
    fn start(binary: &Path, port: u16, log: &Path) -> Result<Self, String> {
        let output = File::create(log).map_err(|error| format!("create smoke client log: {error}"))?;
        let error_output = output
            .try_clone()
            .map_err(|error| format!("clone smoke client log handle: {error}"))?;
        let child = Command::new(binary)
            .arg("127.0.0.1")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(output))
            .stderr(Stdio::from(error_output))
            .spawn()
            .map_err(|error| format!("start Azalea smoke clients: {error}"))?;
        Ok(Self { child, log: log.to_owned(), reaped: false })
    }

    fn wait_success(&mut self, limit: Duration, server: &PaperProcess) -> Result<(), String> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.child.try_wait().map_err(|error| format!("poll Azalea clients: {error}"))? {
                self.reaped = true;
                if status.success() {
                    return Ok(());
                }
                return Err(format!(
                    "Azalea clients exited with {status:?}; client log:\n{}; Paper log:\n{}",
                    tail(&read_log(&self.log)?, 80),
                    server.error_context("client process failed".into())
                ));
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Azalea clients exceeded the 90 second smoke limit; client log:\n{}; Paper log:\n{}",
                    tail(&read_log(&self.log)?, 80),
                    server.error_context("client process timed out".into())
                ));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl Drop for ClientProcess {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        if let Err(error) = self.child.kill() {
            eprintln!("could not stop Azalea smoke clients during cleanup: {error}");
        }
        if let Err(error) = self.child.wait() {
            eprintln!("could not reap Azalea smoke clients during cleanup: {error}");
        }
        self.reaped = true;
    }
}

fn prepare_world(run: &RunDirectory, plugin_jar: &Path, port: u16) -> Result<(), String> {
    let plugins = run.path.join("plugins");
    fs::create_dir(&plugins).map_err(|error| format!("create Paper plugin directory: {error}"))?;
    fs::copy(plugin_jar, plugins.join("ArenaFoundation.jar"))
        .map_err(|error| format!("install the built Arena plugin into the disposable world: {error}"))?;
    fs::write(run.path.join("eula.txt"), "eula=true\n")
        .map_err(|error| format!("write explicit local Minecraft EULA acceptance: {error}"))?;
    let properties = format!(
        "server-ip=127.0.0.1\nserver-port={port}\nonline-mode=false\nenforce-secure-profile=false\nwhite-list=false\npvp=true\ngamemode=survival\ndifficulty=easy\nspawn-protection=0\nspawn-radius=0\nmax-players=4\nview-distance=2\nsimulation-distance=2\nlevel-type=minecraft:flat\nspawn-monsters=false\nspawn-animals=false\nenable-query=false\nenable-rcon=false\nmotd=Arena local stack smoke\n"
    );
    fs::write(run.path.join("server.properties"), properties)
        .map_err(|error| format!("write loopback-only Paper properties: {error}"))
}

fn project_java(root: &Path) -> Result<PathBuf, String> {
    let lock = fs::read_to_string(root.join("versions.lock.toml"))
        .map_err(|error| format!("read versions.lock.toml for the JDK: {error}"))?;
    let (platform, java_relative_path) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("macos_arm64", Path::new("Contents/Home/bin/java")),
        ("linux", "x86_64") => ("linux_x86_64", Path::new("bin/java")),
        _ => return Err("stack smoke supports macOS arm64 and Linux x86_64".into()),
    };
    let java_metadata = lock_section(&lock, "java")?;
    let platform_metadata = lock_section(&lock, &format!("java.{platform}"))?;
    let archive_root = toml_value(platform_metadata, "archive_root")?;
    if Path::new(&archive_root).file_name().and_then(|name| name.to_str()) != Some(archive_root.as_str()) {
        return Err("JDK archive root in versions.lock.toml must be a single path component".into());
    }
    let expected_version = toml_value(java_metadata, "version")?;
    let expected_runtime_build = toml_value(java_metadata, "runtime_build")?;
    let toolchain = root
        .join(".work/arena/toolchains")
        .join(archive_root);
    let java = toolchain.join(java_relative_path);
    let arena = root
        .join(".work/arena")
        .canonicalize()
        .map_err(|error| format!("resolve artifact directory for JDK: {error}"))?;
    let toolchain = toolchain
        .canonicalize()
        .map_err(|error| format!("resolve project-local JDK: {error}"))?;
    if !toolchain.starts_with(&arena) {
        return Err(format!("project-local JDK escaped {}", arena.display()));
    }
    let java = java
        .canonicalize()
        .map_err(|error| format!("resolve project-local Java executable: {error}"))?;
    if !java.starts_with(&toolchain) {
        return Err(format!("project-local Java executable escaped {}", toolchain.display()));
    }
    let output = Command::new(&java)
        .arg("-version")
        .output()
        .map_err(|error| format!("inspect project-local JDK: {error}"))?;
    let version = String::from_utf8_lossy(&output.stderr);
    if !output.status.success()
        || !version.contains(&format!("\"{expected_version}\""))
        || !version.contains(&format!("build {expected_runtime_build}"))
    {
        return Err(format!("project-local JDK has unexpected identity: {version}"));
    }
    Ok(java)
}

fn paper_identity(root: &Path) -> Result<(PathBuf, String), String> {
    let lock = fs::read_to_string(root.join("versions.lock.toml"))
        .map_err(|error| format!("read versions.lock.toml: {error}"))?;
    let rest = lock
        .split_once("[paper]")
        .map(|(_, rest)| rest)
        .ok_or_else(|| "versions.lock.toml lacks [paper]".to_owned())?;
    let paper = rest.split('\n').take_while(|line| !line.trim_start().starts_with('[')).collect::<Vec<_>>().join("\n");
    let file = toml_value(&paper, "server_file")?;
    if Path::new(&file).file_name().and_then(|name| name.to_str()) != Some(file.as_str()) {
        return Err("Paper filename in versions.lock.toml must be a single path component".into());
    }
    let sha = toml_value(&paper, "server_sha256")?;
    if sha.len() != 64 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Paper SHA-256 lock must contain exactly 64 hexadecimal characters".into());
    }
    Ok((root.join(".work/arena/downloads").join(file), sha))
}

fn toml_value(section: &str, key: &str) -> Result<String, String> {
    let prefix = format!("{key} = \"");
    let mut values = section
        .lines()
        .filter_map(|line| line.trim().strip_prefix(&prefix).and_then(|value| value.strip_suffix('"')));
    let value = values.next().ok_or_else(|| format!("missing locked value {key}"))?;
    if values.next().is_some() {
        return Err(format!("duplicate locked Paper value {key}"));
    }
    Ok(value.to_owned())
}

fn lock_section<'a>(lock: &'a str, name: &str) -> Result<&'a str, String> {
    let header = format!("[{name}]");
    let (_, section) = lock
        .split_once(&header)
        .ok_or_else(|| format!("versions.lock.toml lacks {header}"))?;
    let end = section.find("\n[").unwrap_or(section.len());
    Ok(&section[..end])
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    require_file(path, "download the exact Paper artifact under .work/arena/downloads")?;
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("shasum", vec!["-a", "256"])
    } else {
        ("sha256sum", vec![])
    };
    let output = Command::new(program)
        .args(args)
        .arg(path)
        .output()
        .map_err(|error| format!("run {program} to verify Paper: {error}"))?;
    if !output.status.success() {
        return Err(format!("{program} failed while verifying Paper"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let actual = stdout
        .split_whitespace()
        .next()
        .ok_or_else(|| format!("{program} produced no digest"))?;
    if actual != expected {
        return Err(format!("Paper SHA-256 mismatch: expected {expected}, got {actual}"));
    }
    Ok(())
}

fn reject_wrong_protocol(port: u16) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("connect wrong-version control to loopback: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("set wrong-version read deadline: {error}"))?;
    let mut handshake = Vec::new();
    write_varint(&mut handshake, 0);
    write_varint(&mut handshake, 775);
    write_string(&mut handshake, "127.0.0.1")?;
    handshake.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut handshake, 2);
    let mut frame = Vec::new();
    write_varint(&mut frame, handshake.len() as i32);
    frame.extend_from_slice(&handshake);
    stream
        .write_all(&frame)
        .map_err(|error| format!("send protocol 775 handshake: {error}"))?;

    let response = read_packet(&mut stream)?;
    let mut cursor = 0;
    let packet_id = read_varint(&response, &mut cursor)?;
    if packet_id != 0 {
        return Err(format!("wrong-version login received unexpected packet id {packet_id}"));
    }
    let message = read_string(&response, &mut cursor)?.to_lowercase();
    if !message.contains("26.2") || !(message.contains("client") || message.contains("version")) {
        return Err(format!("wrong-version login rejection did not identify protocol 26.2: {message}"));
    }
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}

fn read_packet(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut length = 0usize;
    let mut shift = 0;
    loop {
        if shift >= 35 {
            return Err("server packet length used an oversized VarInt".into());
        }
        let mut byte = [0u8; 1];
        stream
            .read_exact(&mut byte)
            .map_err(|error| format!("read wrong-version server response: {error}"))?;
        length |= ((byte[0] & 0x7f) as usize) << shift;
        if byte[0] & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    if length == 0 || length > 1_048_576 {
        return Err(format!("wrong-version response has invalid packet length {length}"));
    }
    let mut response = vec![0; length];
    stream
        .read_exact(&mut response)
        .map_err(|error| format!("read wrong-version response packet: {error}"))?;
    Ok(response)
}

fn write_string(output: &mut Vec<u8>, value: &str) -> Result<(), String> {
    let length = i32::try_from(value.len()).map_err(|error| format!("Minecraft string too long: {error}"))?;
    write_varint(output, length);
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn read_string(input: &[u8], cursor: &mut usize) -> Result<String, String> {
    let length = usize::try_from(read_varint(input, cursor)?)
        .map_err(|error| format!("negative Minecraft string length: {error}"))?;
    let end = (*cursor).checked_add(length).ok_or_else(|| "Minecraft string length overflow".to_owned())?;
    let bytes = input.get(*cursor..end).ok_or_else(|| "truncated Minecraft string".to_owned())?;
    *cursor = end;
    String::from_utf8(bytes.to_vec()).map_err(|error| format!("server sent invalid UTF-8: {error}"))
}

fn read_varint(input: &[u8], cursor: &mut usize) -> Result<i32, String> {
    let mut result = 0u32;
    let mut shift = 0;
    loop {
        if shift >= 35 {
            return Err("server sent an oversized VarInt".into());
        }
        let byte = *input.get(*cursor).ok_or_else(|| "truncated VarInt".to_owned())?;
        *cursor += 1;
        result |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            return Ok(result as i32);
        }
        shift += 7;
    }
}

fn write_varint(output: &mut Vec<u8>, mut value: i32) {
    loop {
        if value & !0x7f == 0 {
            output.push(value as u8);
            return;
        }
        output.push(((value & 0x7f) | 0x80) as u8);
        value = ((value as u32) >> 7) as i32;
    }
}

fn free_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("reserve an available loopback port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("read reserved loopback port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn can_connect_loopback(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(100),
    ).is_ok()
}

fn read_log(path: &Path) -> Result<String, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| format!("open smoke log {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("seek smoke log {}: {error}", path.display()))?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|error| format!("read smoke log {}: {error}", path.display()))?;
    Ok(contents)
}

fn tail(log: &str, lines: usize) -> String {
    log.lines().rev().take(lines).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}

fn repo_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .join("../..")
        .canonicalize()
        .map_err(|error| format!("resolve repository root from {}: {error}", manifest.display()))
}

fn require_file(path: &Path, remedy: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(format!("required file {} is not a regular file; {remedy}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("required file {} is missing; {remedy}", path.display()))
        }
        Err(error) => Err(format!("inspect required file {}: {error}", path.display())),
    }
}

fn owned_file(root: &Path, path: &Path, remedy: &str) -> Result<PathBuf, String> {
    require_file(path, remedy)?;
    let arena = root
        .join(".work/arena")
        .canonicalize()
        .map_err(|error| format!("resolve artifact directory: {error}"))?;
    let file = path
        .canonicalize()
        .map_err(|error| format!("resolve required artifact {}: {error}", path.display()))?;
    if !file.starts_with(&arena) {
        return Err(format!("required artifact escaped {}", arena.display()));
    }
    Ok(file)
}

fn ensure_directory(path: &Path, name: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(format!("{name} {} must be a real directory, not a symlink", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Err(error) = fs::create_dir(path) {
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!("create {name} {}: {error}", path.display()));
                }
            }
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
                Ok(_) => Err(format!("{name} {} became a symlink", path.display())),
                Err(error) => Err(format!("inspect {name} {} after creation: {error}", path.display())),
            }
        }
        Err(error) => Err(format!("inspect {name} {}: {error}", path.display())),
    }
}
