import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = new Map([
  ["core", "arena-core"],
  ["spec", "arena-spec"],
  ["bots", "arena-bots"],
  ["runner", "arena-runner"]
]);

function fail(message) {
  process.stderr.write(`typescript build: ${message}\n`);
  process.exit(2);
}

function compile(project) {
  ensureOutputDirectories();
  const result = spawnSync("tsc", ["--project", project, "--pretty", "false"], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.error) fail(`could not start the TypeScript compiler: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensureDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`generated directory must be real: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(path);
  }
}

function ensureOutputDirectories() {
  const work = join(root, ".work");
  const build = join(work, "build");
  ensureDirectory(work);
  ensureDirectory(build);
  ensureDirectory(join(build, "tsbuildinfo"));
}

function packageManifest(name) {
  const directory = packages.get(name);
  if (!directory) fail(`unknown TypeScript package: ${name}`);
  const path = join(root, "packages", directory, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.name !== `@arena/${name}`) fail(`package name does not match its workspace path: ${path}`);
  return manifest;
}

function packageDependencies(name) {
  const dependencies = packageManifest(name).dependencies ?? {};
  return Object.keys(dependencies).filter((dependency) => {
    if (!dependency.startsWith("@arena/")) return false;
    const target = dependency.slice("@arena/".length);
    if (!packages.has(target)) fail(`unknown Arena workspace dependency: ${dependency}`);
    return true;
  }).map((dependency) => dependency.slice("@arena/".length));
}

function stagePackageAliases() {
  const buildRoot = join(root, ".work", "build");
  const nodeModules = join(buildRoot, "node_modules");
  const workspaceModules = join(root, ".work", "arena", "npm-workspace", "node_modules");
  ensureDirectory(join(buildRoot, "packages"));
  ensureDirectory(nodeModules);

  for (const [name, directory] of packages) {
    const outputDirectory = join(buildRoot, "packages", directory);
    ensureDirectory(outputDirectory);
    const manifestPath = join(root, "packages", directory, "package.json");
    packageManifest(name);
    copyFileSync(manifestPath, join(outputDirectory, "package.json"));

    const manifest = packageManifest(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const aliasPath = join(nodeModules, dependency);
      let targetDirectory;
      if (dependency.startsWith("@arena/")) {
        const packageDirectory = packages.get(dependency.slice("@arena/".length));
        if (!packageDirectory) fail(`unknown Arena workspace dependency: ${dependency}`);
        targetDirectory = join(buildRoot, "packages", packageDirectory);
      } else {
        targetDirectory = join(workspaceModules, dependency);
      }
      ensureDirectory(dirname(aliasPath));
      const target = relative(dirname(aliasPath), targetDirectory);
      try {
        const stat = lstatSync(aliasPath);
        if (!stat.isSymbolicLink() || readlinkSync(aliasPath) !== target) {
          fail(`compiled package dependency has an unexpected target: ${aliasPath}`);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        symlinkSync(target, aliasPath, "dir");
      }
    }
  }
}

function compilePackage(name, compiled, compiling) {
  if (compiled.has(name)) return;
  if (compiling.has(name)) fail(`cyclic TypeScript workspace dependency at ${name}`);
  compiling.add(name);
  for (const dependency of packageDependencies(name)) compilePackage(dependency, compiled, compiling);
  compile(join("packages", packages.get(name), "tsconfig.json"));
  compiling.delete(name);
  compiled.add(name);
}

const target = process.argv[2];
if (target === "all") {
  const compiled = new Set();
  const compiling = new Set();
  for (const name of packages.keys()) compilePackage(name, compiled, compiling);
} else if (target === "stack") {
  compile(join("tests", "tsconfig.json"));
} else if (target === "control") {
  compile(join("packages", "arena-runner", "tsconfig.control.json"));
} else if (packages.has(target)) {
  compilePackage(target, new Set(), new Set());
} else {
  fail("expected all, stack, control, core, spec, bots, or runner");
}

stagePackageAliases();
