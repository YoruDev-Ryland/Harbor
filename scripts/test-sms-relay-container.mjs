#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const suffix = `${process.pid}-${Date.now()}`;
const suppliedImage = process.env.HARBOR_SMS_RELAY_TEST_IMAGE?.trim();
const image = suppliedImage || `harbor-sms-relay-test:${suffix}`;
const name = `harbor-sms-relay-test-${suffix}`;
const apiKey = "example-relay-api-key-at-least-32-characters";

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

function request(path, options = {}) {
  const source = `
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:8080${path}`)}, ${JSON.stringify(options)});
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `;
  return JSON.parse(docker("exec", name, "node", "--input-type=module", "-e", source));
}

try {
  if (!suppliedImage) docker("build", "-t", image, "examples/notifications/sms-relay");
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--init",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=8m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "-e",
    "SIGNALWIRE_SPACE=example.signalwire.com",
    "-e",
    "SIGNALWIRE_PROJECT_ID=example_project",
    "-e",
    "SIGNALWIRE_API_TOKEN=example-provider-token-at-least-20-characters",
    "-e",
    "SIGNALWIRE_FROM_NUMBER=+15550100001",
    "-e",
    `RELAY_API_KEY=${apiKey}`,
    "-e",
    "SMS_ALLOWED_RECIPIENTS=+15550100002",
    image
  );

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (
      run("docker", ["exec", name, "wget", "-qO-", "http://127.0.0.1:8080/health"], {
        allowFailure: true,
      }).status === 0
    )
      break;
    if (attempt === 39)
      throw new Error(`SMS relay did not become healthy:\n${docker("logs", name)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }

  assert.deepEqual(request("/health"), { status: 200, body: { ok: true } });
  assert.equal(
    request("/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "+15550100002", message: "test" }),
    }).status,
    401
  );
  assert.equal(
    request("/send", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "+15550100003", message: "test" }),
    }).status,
    403
  );

  assert.match(
    docker(
      "inspect",
      "--format",
      "{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}",
      name
    ),
    /^node\|true\|\["ALL"\]\|\["no-new-privileges(?::true)?"\]$/
  );
  assert.notEqual(
    run("docker", ["exec", name, "sh", "-c", "command -v npm"], { allowFailure: true }).status,
    0
  );

  docker("stop", "-t", "10", name);
  assert.equal(
    docker("inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", name),
    "exited|0"
  );
  assert.match(docker("logs", name), /"event":"shutdown","signal":"SIGTERM"/);
  console.log("SMS relay helper smoke passed: auth, allowlist, hardening, health, and SIGTERM.");
} finally {
  run("docker", ["rm", "-f", name], { allowFailure: true });
  if (!suppliedImage) run("docker", ["image", "rm", image], { allowFailure: true });
}
