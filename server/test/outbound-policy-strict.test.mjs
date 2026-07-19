import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-outbound-strict-test-"));
process.env.HARBOR_DATA = dataDir;
process.env.HARBOR_SECRET = "example-outbound-strict-secret-that-is-at-least-32-characters";
process.env.AUTH_PROXY = "false";
process.env.HARBOR_OUTBOUND_STRICT_PRIVATE = "true";
process.env.HARBOR_OUTBOUND_ALLOW_CIDRS = "192.168.50.0/24,127.0.0.0/8";
process.env.HARBOR_OUTBOUND_ALLOW_HOSTS = "allowed.internal,localhost";

const { assertResolvedAddressAllowed, parseOutboundUrl } = await import("../dist/lib/outbound.js");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("strict private mode requires narrow grants and never grants special-use addresses", () => {
  assert.throws(
    () => assertResolvedAddressAllowed("other.internal", "192.168.60.1"),
    /strict outbound allow-list/
  );
  assert.doesNotThrow(() => assertResolvedAddressAllowed("cidr.internal", "192.168.50.20"));
  assert.doesNotThrow(() => assertResolvedAddressAllowed("allowed.internal", "10.20.30.40"));
  assert.throws(
    () => parseOutboundUrl("http://192.168.60.1:8989/api"),
    /strict outbound allow-list/
  );
  assert.throws(
    () => assertResolvedAddressAllowed("localhost", "127.0.0.1"),
    /blocked special-use/
  );
});
