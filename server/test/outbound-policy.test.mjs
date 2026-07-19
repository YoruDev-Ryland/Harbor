import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-outbound-test-"));
process.env.HARBOR_DATA = dataDir;
process.env.HARBOR_SECRET = "example-outbound-test-secret-that-is-at-least-32-characters";
process.env.AUTH_PROXY = "false";

const { assertResolvedAddressAllowed, parseOutboundUrl, readLimitedBody } =
  await import("../dist/lib/outbound.js");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("default outbound policy permits private integrations but blocks special-use addresses", () => {
  for (const address of [
    "0.0.0.0",
    "127.0.0.1",
    "169.254.169.254",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])
    assert.throws(
      () => assertResolvedAddressAllowed("blocked.test", address),
      /blocked special-use/
    );
  for (const address of ["10.20.30.40", "172.18.0.8", "192.168.60.1", "100.64.10.2", "fd00::20"])
    assert.doesNotThrow(() => assertResolvedAddressAllowed("service.internal", address));
  assert.doesNotThrow(() => assertResolvedAddressAllowed("public.example", "93.184.216.34"));
  assert.doesNotThrow(() => parseOutboundUrl("http://192.168.60.1:8989/api"));
  assert.throws(() => parseOutboundUrl("http://127.0.0.1/private"), /blocked/);
  assert.throws(
    () => parseOutboundUrl(["https://user", "pass@example.test"].join(":")),
    /credential-free/
  );
  assert.throws(() => parseOutboundUrl("https://example.test/#fragment"), /credential-free/);
});

test("decompressed upstream bodies are rejected at the byte ceiling", async () => {
  const response = new Response("x".repeat(101));
  await assert.rejects(() => readLimitedBody(response, 100), /exceeds 100 bytes/);
  const allowed = await readLimitedBody(new Response("small"), 100);
  assert.equal(Buffer.from(allowed).toString(), "small");
});
