#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-clean-tree-"));
const checkout = path.join(temporaryRoot, "checkout");

function run(command, args, cwd = checkout) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

try {
  fs.mkdirSync(checkout);
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root }
  )
    .toString()
    .split("\0")
    .filter(Boolean);

  for (const relativePath of listed) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const target = path.join(checkout, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode);
  }

  run("git", ["init", "--quiet"]);
  run("git", ["add", "--all"]);
  run("git", [
    "-c",
    "user.name=Harbor Release Test",
    "-c",
    "user.email=release-test@example.test",
    "commit",
    "--quiet",
    "-m",
    "release candidate",
  ]);
  run("npm", ["ci"]);
  run("npm", ["run", "ci"]);
  run("npm", ["run", "secrets:scan"]);
  console.log("Clean-tree source and history gates passed.");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
