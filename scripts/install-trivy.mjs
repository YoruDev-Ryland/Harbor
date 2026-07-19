#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const version = "0.72.0";
const artifacts = {
  x64: {
    name: `trivy_${version}_Linux-64bit.tar.gz`,
    sha256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea",
  },
  arm64: {
    name: `trivy_${version}_Linux-ARM64.tar.gz`,
    sha256: "2ca2c023109c2db6b2b77366b6717291452d4531167377d95c79547f0c8e3467",
  },
};

const artifact = artifacts[process.arch];
const destination = process.argv[2];

if (process.platform !== "linux" || !artifact)
  throw new Error(`unsupported Trivy installer platform: ${process.platform}/${process.arch}`);
if (!destination) throw new Error("usage: node scripts/install-trivy.mjs <destination-directory>");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-trivy-"));
const archive = path.join(temporaryDirectory, artifact.name);

try {
  const response = await fetch(
    `https://github.com/aquasecurity/trivy/releases/download/v${version}/${artifact.name}`
  );
  if (!response.ok) throw new Error(`Trivy download failed with HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256)
    throw new Error(
      `Trivy archive checksum mismatch: expected ${artifact.sha256}, received ${actual}`
    );

  fs.writeFileSync(archive, bytes, { mode: 0o600 });
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination, "trivy"], { stdio: "inherit" });
  fs.chmodSync(path.join(destination, "trivy"), 0o755);
  console.log(`Installed checksum-verified Trivy ${version} for ${process.arch}.`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
