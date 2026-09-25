#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "git command failed").trim();
    throw new Error(`git ${args.join(" ")}: ${detail}`);
  }
  return result.stdout;
}

function gitFile(repo, commit, file) {
  return git(repo, ["show", `${commit}:${file}`]);
}

function gitFileExists(repo, commit, file) {
  const result = spawnSync("git", ["-C", repo, "cat-file", "-e", `${commit}:${file}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function stripTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    output += character;
  }
  return output;
}

function globRegex(pattern) {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
    } else if (character === "?") {
      regex += "[^/]";
    } else {
      regex += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${regex}$`);
}

function dependencyRanges(rootPackage) {
  const ranges = {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(rootPackage[field] || {})) {
      if (!(name in ranges)) ranges[name] = range;
    }
  }
  return ranges;
}

function workspaceManifest(repo, commit) {
  const rootPackage = JSON.parse(gitFile(repo, commit, "package.json"));
  const configured = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];
  const packageFiles = git(repo, ["ls-tree", "-r", "--name-only", commit])
    .split("\n")
    .filter((file) => file === "package.json" || file.endsWith("/package.json"));
  const packageDirs = new Set(
    packageFiles.filter((file) => file !== "package.json").map((file) => path.posix.dirname(file)),
  );
  const expanded = new Set();
  for (let configuredPath of configured) {
    configuredPath = String(configuredPath).replace(/^\.\//, "").replace(/\/$/, "");
    const hasGlob = /[*?[]/.test(configuredPath);
    if (!hasGlob) {
      if (packageDirs.has(configuredPath)) expanded.add(configuredPath);
      continue;
    }
    const matcher = globRegex(configuredPath);
    for (const directory of packageDirs) {
      if (matcher.test(directory)) expanded.add(directory);
    }
  }
  const directories = [...expanded].sort();
  const packages = directories.map((directory) => {
    const packageJson = JSON.parse(gitFile(repo, commit, `${directory}/package.json`));
    if (!packageJson.name) throw new Error(`workspace ${directory} has no package name`);
    return { name: packageJson.name, dir: directory, packageJson };
  });

  if (gitFileExists(repo, commit, "bun.lock")) {
    const lock = JSON.parse(stripTrailingCommas(gitFile(repo, commit, "bun.lock")));
    const lockDirectories = Object.keys(lock.workspaces || {}).filter((key) => key !== "").sort();
    if (JSON.stringify(lockDirectories) !== JSON.stringify(directories)) {
      throw new Error(
        `workspace set mismatch\n  package.json: ${JSON.stringify(directories)}\n  bun.lock: ${JSON.stringify(lockDirectories)}`,
      );
    }
    const byDirectory = new Map(packages.map((entry) => [entry.dir, entry.name]));
    const nameMismatches = lockDirectories
      .filter((directory) => lock.workspaces[directory]?.name !== byDirectory.get(directory))
      .map(
        (directory) =>
          `${directory}: package.json=${JSON.stringify(byDirectory.get(directory))}, bun.lock=${JSON.stringify(lock.workspaces[directory]?.name)}`,
      );
    if (nameMismatches.length > 0) {
      throw new Error(
        `workspace name mismatch\n  package.json: ${JSON.stringify(packages.map((entry) => ({ dir: entry.dir, name: entry.name })))}\n  bun.lock: ${JSON.stringify(lockDirectories.map((directory) => ({ dir: directory, name: lock.workspaces[directory]?.name })))}\n  ${nameMismatches.join("\n  ")}`,
      );
    }
  }

  return {
    rootPackage,
    dependencyRanges: dependencyRanges(rootPackage),
    packages,
  };
}

function atomicWriteJson(output, value) {
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, output);
}

function canonicalPath(input) {
  let absolute = path.resolve(input);
  const suffix = [];
  while (!fs.existsSync(absolute)) {
    const parent = path.dirname(absolute);
    if (parent === absolute) break;
    suffix.unshift(path.basename(absolute));
    absolute = parent;
  }
  let resolved = fs.realpathSync(absolute);
  for (const part of suffix) resolved = path.join(resolved, part);
  return resolved;
}

function pickSpecifier(workspace) {
  const exportsMap = workspace.packageJson.exports;
  if (exportsMap && typeof exportsMap === "object" && !Array.isArray(exportsMap)) {
    if (Object.prototype.hasOwnProperty.call(exportsMap, ".")) return workspace.name;
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (typeof target === "string") {
        const suffix = subpath.replace(/^\.\//, "");
        return suffix ? `${workspace.name}/${suffix}` : workspace.name;
      }
    }
  }
  return workspace.name;
}

function nearestPackageRoot(resolvedFile, packageName) {
  let current = fs.statSync(resolvedFile).isDirectory() ? resolvedFile : path.dirname(resolvedFile);
  while (true) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      try {
        if (JSON.parse(fs.readFileSync(packageJson, "utf8")).name === packageName) {
          return fs.realpathSync(current);
        }
      } catch {
        // Keep walking: an unrelated malformed package.json is not the package root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function viteResolve(worktree, specifier) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ombl-vite-"));
  let server;
  try {
    const requireFromWorktree = createRequire(path.join(worktree, "package.json"));
    const viteEntry = requireFromWorktree.resolve("vite");
    const vite = await import(pathToFileURL(viteEntry).href);
    const importerCandidates = [
      "src/main.tsx",
      "src/main.ts",
      "src/index.tsx",
      "index.html",
    ];
    const importerRelative = importerCandidates.find((candidate) => fs.existsSync(path.join(worktree, candidate)));
    if (!importerRelative) throw new Error("no supported importer exists in the worktree");
    const configPath = path.join(worktree, "vite.config.ts");
    server = await vite.createServer({
      root: worktree,
      configFile: fs.existsSync(configPath) ? configPath : false,
      configLoader: "runner",
      cacheDir,
      logLevel: "error",
      clearScreen: false,
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: null,
        preTransformRequests: false,
      },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    const resolution = await server.pluginContainer.resolveId(
      specifier,
      path.join(worktree, importerRelative),
    );
    const rawId = typeof resolution === "string" ? resolution : resolution?.id;
    if (!rawId) throw new Error("Vite returned no resolution");
    const cleaned = rawId.replace(/^\0/, "").replace(/\?.*$/, "");
    const resolvedFile = fs.realpathSync(cleaned);
    return { resolvedFile, packageRoot: null, insideWorktree: false, error: null };
  } catch (error) {
    return {
      resolvedFile: null,
      packageRoot: null,
      insideWorktree: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (server) {
      try {
        await server.close();
      } catch {
        // The resolution verdict is more useful than a close error.
      }
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function nodeResolve(worktree, specifier) {
  try {
    const requireFromWorktree = createRequire(path.join(worktree, "package.json"));
    const resolvedFile = fs.realpathSync(requireFromWorktree.resolve(specifier));
    return { resolvedFile, packageRoot: null, insideWorktree: false, error: null };
  } catch (error) {
    return {
      resolvedFile: null,
      packageRoot: null,
      insideWorktree: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function treeEntries(worktree, commit, directory) {
  const output = git(worktree, ["ls-tree", "-r", "-z", commit, "--", directory], {
    encoding: "buffer",
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const header = record.slice(0, tab).split(" ");
      return { mode: header[0], oid: header[2], path: record.slice(tab + 1) };
    })
    .filter((entry) => entry.mode === "100644" || entry.mode === "100755" || entry.mode === "120000");
}

function hashLink(worktree, linkText) {
  return git(worktree, ["hash-object", "--stdin"], { input: linkText }).trim();
}

function compareTree(worktree, commit, workspace, packageRoot) {
  const entries = treeEntries(worktree, commit, workspace.dir);
  const mismatches = new Set();
  if (!packageRoot) {
    for (const entry of entries) mismatches.add(entry.path.slice(workspace.dir.length + 1));
    return {
      root: null,
      files: entries.length,
      mismatches: mismatches.size,
      firstMismatches: [...mismatches].slice(0, 10),
    };
  }

  const regular = [];
  for (const entry of entries) {
    const relative = entry.path.slice(workspace.dir.length + 1);
    const installed = path.join(packageRoot, relative);
    if (entry.mode === "120000") {
      try {
        const stat = fs.lstatSync(installed);
        if (!stat.isSymbolicLink() || hashLink(worktree, fs.readlinkSync(installed)) !== entry.oid) {
          mismatches.add(relative);
        }
      } catch {
        mismatches.add(relative);
      }
      continue;
    }
    try {
      if (!fs.lstatSync(installed).isFile()) {
        mismatches.add(relative);
      } else {
        regular.push({ entry, relative, installed });
      }
    } catch {
      mismatches.add(relative);
    }
  }

  if (regular.length > 0) {
    const hashResult = spawnSync(
      "git",
      ["-C", worktree, "hash-object", "--no-filters", "--stdin-paths"],
      {
        encoding: "utf8",
        input: `${regular.map((item) => item.installed).join("\n")}\n`,
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    if (hashResult.status !== 0) {
      for (const item of regular) mismatches.add(item.relative);
    } else {
      const hashes = hashResult.stdout.trim().split("\n");
      regular.forEach((item, index) => {
        if (hashes[index] !== item.entry.oid) mismatches.add(item.relative);
      });
    }
  }

  return {
    root: packageRoot,
    files: entries.length,
    mismatches: mismatches.size,
    firstMismatches: [...mismatches].slice(0, 10),
  };
}

function externalOpenmarketPackages(worktree, manifest) {
  const scope = path.join(worktree, "node_modules", "@openmarket");
  const workspaceNames = new Set(manifest.packages.map((entry) => entry.name));
  let children = [];
  try {
    children = fs.readdirSync(scope).sort();
  } catch {
    return [];
  }
  return children
    .map((child) => `@openmarket/${child}`)
    .filter((name) => !workspaceNames.has(name))
    .map((name) => {
      const installed = path.join(worktree, "node_modules", name);
      let realpath = null;
      let version = null;
      try {
        realpath = fs.realpathSync(installed);
        version = JSON.parse(fs.readFileSync(path.join(realpath, "package.json"), "utf8")).version ?? null;
      } catch {
        // Informational entries remain useful even when dangling or malformed.
      }
      return {
        name,
        realpath,
        version,
        pinned: manifest.dependencyRanges[name] ?? null,
      };
    });
}

async function runAssertion(worktreeInput, commit, jsonOutput) {
  const worktree = canonicalPath(worktreeInput);
  const result = {
    schema: 1,
    commit,
    worktree,
    nodeModulesIsLocalDir: false,
    workspacePackages: [],
    externalOpenmarketPackages: [],
    status: "fail",
  };
  try {
    const manifest = workspaceManifest(worktree, commit);
    const nodeModules = path.join(worktree, "node_modules");
    try {
      const stat = fs.lstatSync(nodeModules);
      result.nodeModulesIsLocalDir =
        stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(nodeModules) === nodeModules;
    } catch {
      result.nodeModulesIsLocalDir = false;
    }
    result.externalOpenmarketPackages = externalOpenmarketPackages(worktree, manifest);
    const dependedWorkspaces = manifest.packages.filter((workspace) =>
      Object.prototype.hasOwnProperty.call(manifest.dependencyRanges, workspace.name),
    );
    const skipVite = process.env.OMBL_ASSERT_SKIP_VITE === "1";
    for (const workspace of dependedWorkspaces) {
      const expectedRoot = fs.realpathSync(path.join(worktree, workspace.dir));
      const specifier = pickSpecifier(workspace);
      const vite = skipVite ? { skipped: true } : await viteResolve(worktree, specifier);
      if (!skipVite && vite.resolvedFile) {
        try {
          vite.packageRoot = nearestPackageRoot(vite.resolvedFile, workspace.name);
          vite.insideWorktree = vite.packageRoot === expectedRoot;
          if (!vite.packageRoot) vite.error = `could not find package root for ${workspace.name}`;
        } catch (error) {
          vite.error = error instanceof Error ? error.message : String(error);
        }
      }
      const node = nodeResolve(worktree, specifier);
      if (node.resolvedFile) {
        try {
          node.packageRoot = nearestPackageRoot(node.resolvedFile, workspace.name);
          node.insideWorktree = node.packageRoot === expectedRoot;
          if (!node.packageRoot) node.error = `could not find package root for ${workspace.name}`;
        } catch (error) {
          node.error = error instanceof Error ? error.message : String(error);
        }
      }
      const treeRoot = !skipVite && vite.packageRoot ? vite.packageRoot : node.packageRoot;
      const tree = compareTree(worktree, commit, workspace, treeRoot);
      const vitePass = skipVite || (vite.error === null && vite.insideWorktree === true);
      const nodePass = node.error === null && node.insideWorktree === true;
      const status = vitePass && nodePass && tree.mismatches === 0 ? "pass" : "fail";
      result.workspacePackages.push({
        name: workspace.name,
        dir: workspace.dir,
        spec: specifier,
        vite,
        node,
        tree,
        status,
      });
    }
    const checksPass =
      result.nodeModulesIsLocalDir && result.workspacePackages.every((entry) => entry.status === "pass");
    result.status = checksPass ? (skipVite ? "pass-no-vite" : "pass") : "fail";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.status = "fail";
  }

  if (jsonOutput) atomicWriteJson(jsonOutput, result);
  console.error(
    `assert: ${result.status === "fail" ? "FAIL" : "PASS"} commit=${commit} node_modules_local=${result.nodeModulesIsLocalDir}`,
  );
  for (const workspace of result.workspacePackages) {
    const viteRoot = workspace.vite.skipped ? "skipped" : workspace.vite.packageRoot || workspace.vite.error;
    console.error(
      `assert: ${workspace.name} ${workspace.status.toUpperCase()} vite=${viteRoot} node=${workspace.node.packageRoot || workspace.node.error} mismatches=${workspace.tree.mismatches}/${workspace.tree.files}`,
    );
    if (workspace.tree.firstMismatches.length > 0) {
      console.error(`assert: first mismatches: ${workspace.tree.firstMismatches.join(", ")}`);
    }
  }
  if (result.error) console.error(`assert: ${result.error}`);
  return result.status === "fail" ? 3 : 0;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") {
    const [repo, commit, output] = args;
    atomicWriteJson(output, workspaceManifest(repo, commit));
    return;
  }
  if (command === "workspace-lines") {
    const manifest = JSON.parse(fs.readFileSync(args[0], "utf8"));
    for (const workspace of manifest.packages) console.log(`${workspace.name}\t${workspace.dir}`);
    return;
  }
  if (command === "canonical") {
    console.log(canonicalPath(args[0]));
    return;
  }
  if (command === "relative") {
    console.log(path.relative(args[0], args[1]) || ".");
    return;
  }
  if (command === "cache-valid") {
    const [file, commit] = args;
    try {
      const info = JSON.parse(fs.readFileSync(file, "utf8"));
      process.exitCode =
        info.schema === 1 && info.commit === commit && info.assertion?.status === "pass" ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "assert") {
    const [worktree, commit, jsonFlag, jsonOutput] = args;
    if (jsonFlag && jsonFlag !== "--json") throw new Error(`unknown assert option: ${jsonFlag}`);
    process.exitCode = await runAssertion(worktree, commit, jsonFlag ? jsonOutput : null);
    return;
  }
  if (command === "build-info") {
    const [output, commit, builtAt, builtAtEpoch, buildSeconds, host, sharedNodeModules, worktree, assertionFile] = args;
    const assertion = JSON.parse(fs.readFileSync(assertionFile, "utf8"));
    const chatUi = assertion.workspacePackages.find((entry) => entry.name === "@openmarket/chat-ui");
    fs.writeFileSync(
      output,
      `${JSON.stringify(
        {
          schema: 1,
          commit,
          builtAt,
          builtAtEpoch: Number(builtAtEpoch),
          buildSeconds: Number(buildSeconds),
          host,
          builder: "arm-build.sh base-dist",
          sharedNodeModules,
          worktreeAtBuild: worktree,
          chatUiRealpath: chatUi?.vite?.packageRoot ?? null,
          assertion,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  throw new Error(`unknown helper command: ${command || "<none>"}`);
}

main().catch((error) => {
  console.error(`arm-build-helper: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
