#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const suffix = `${process.pid}-${Date.now()}`;
const name = `harbor-phase4-test-${suffix}`;
const volume = `harbor-phase4-data-${suffix}`;
const suppliedImage = process.env.HARBOR_TEST_IMAGE?.trim();
const image = suppliedImage || `harbor-phase4-test:${suffix}`;
const expectedVersion =
  process.env.HARBOR_TEST_VERSION?.trim() || (suppliedImage ? undefined : "0.1.0-container-test");
const setupToken = "example-container-setup-token-at-least-32-characters";
const secret = "example-container-master-secret-at-least-32-characters";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`
    );
  }
  return result;
}

function docker(...args) {
  return run("docker", args).stdout.trim();
}

function startContainer() {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--init",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--label",
    "org.harbor.phase4-test=true",
    "-e",
    `HARBOR_SECRET=${secret}`,
    "-e",
    `HARBOR_SETUP_TOKEN=${setupToken}`,
    "-e",
    "AUTH_PROXY=false",
    "-v",
    `${volume}:/data`,
    image
  );
}

function waitReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = run(
      "docker",
      ["exec", name, "wget", "-qO-", "http://127.0.0.1:9090/api/health/ready"],
      { allowFailure: true }
    );
    if (result.status === 0) {
      const health = JSON.parse(result.stdout);
      assert.equal(health.ok, true);
      assert.equal(health.schemaVersion, 3);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`container did not become ready:\n${docker("logs", name)}`);
}

function stopCleanly() {
  docker("stop", "-t", "15", name);
  const state = docker("inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", name);
  assert.equal(state, "exited|0");
  assert.match(docker("logs", name), /graceful shutdown started/);
}

try {
  docker("version", "--format", "{{.Server.Version}}");
  if (!suppliedImage) {
    docker(
      "build",
      "--build-arg",
      "HARBOR_VERSION=0.1.0-container-test",
      "--build-arg",
      "HARBOR_REVISION=phase4-test",
      "--build-arg",
      "HARBOR_SOURCE=https://example.test/harbor",
      "--build-arg",
      `HARBOR_CREATED=${new Date().toISOString()}`,
      "-t",
      image,
      "."
    );
  }
  docker("volume", "create", volume);
  startContainer();
  waitReady();

  const hardening = docker(
    "inspect",
    "--format",
    "{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}",
    name
  );
  assert.match(hardening, /^node\|true\|\["ALL"\]\|\["no-new-privileges(?::true)?"\]$/);
  const imageVersion = docker(
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.opencontainers.image.version"}}',
    image
  );
  if (expectedVersion) assert.equal(imageVersion, expectedVersion);
  else assert.match(imageVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.notEqual(
    run("docker", ["exec", name, "sh", "-c", "command -v npm"], { allowFailure: true }).status,
    0,
    "the runtime image must not retain the npm package manager"
  );
  assert.equal(
    docker(
      "exec",
      name,
      "sh",
      "-c",
      "stat -c '%a %n' /data /data/harbor.db /data/harbor.db-wal /data/harbor.db-shm"
    ),
    "700 /data\n600 /data/harbor.db\n600 /data/harbor.db-wal\n600 /data/harbor.db-shm"
  );

  const setup = docker(
    "exec",
    name,
    "wget",
    "-qO-",
    "--header=Content-Type: application/json",
    `--post-data=${JSON.stringify({
      setupToken,
      username: "container-admin",
      email: "container-admin@example.test",
      password: "example-container-password",
    })}`,
    "http://127.0.0.1:9090/api/auth/setup"
  );
  assert.equal(JSON.parse(setup).user.username, "container-admin");
  stopCleanly();
  docker("rm", name);

  // Restart the exact image against the existing volume: schema and account
  // state must survive the upgrade/recreate pattern used by Compose.
  startContainer();
  waitReady();
  const status = JSON.parse(
    docker("exec", name, "node", "server/dist/cli.js", "status").split("\n").at(-1)
  );
  assert.deepEqual(status, { ready: true, schemaVersion: 3, users: 1 });
  stopCleanly();
  console.log(
    "Container release smoke passed: hardened runtime, setup, persistence, readiness, and SIGTERM."
  );
} finally {
  run("docker", ["rm", "-f", name], { allowFailure: true });
  run("docker", ["volume", "rm", volume], { allowFailure: true });
  if (!suppliedImage) run("docker", ["image", "rm", image], { allowFailure: true });
}
