import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-e2e-"));
process.env.NODE_ENV = "test";
process.env.HARBOR_DATA = dataDir;
process.env.HARBOR_SECRET = "example-playwright-master-secret-at-least-32-characters";
process.env.HARBOR_SETUP_TOKEN = "example-playwright-setup-token-at-least-32-characters";
process.env.AUTH_PROXY = "false";
process.env.HOST = "127.0.0.1";
process.env.PORT = process.env.PORT || "4173";
process.env.HARBOR_VERSION = "0.1.0-e2e";

process.once("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
await import("../server/dist/index.js");
