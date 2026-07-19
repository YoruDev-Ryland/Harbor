#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["credentialed-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/gi],
  [
    "quoted-secret",
    /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|harbor_secret|password)\s*[:=]\s*["'](?!change-me|example|placeholder|<)[A-Za-z0-9_+/.=-]{20,}["']/gi,
  ],
  [
    "environment-secret",
    /^(?:[A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD|HARBOR_SECRET)[A-Z0-9_]*)=(?!\$\{|change-me|example|placeholder|<)[^\s#]{16,}$/gm,
  ],
];

const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean);

const findings = [];
let currentFilesScanned = 0;
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 5_000_000) continue;
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  currentFilesScanned += 1;
  const text = content.toString("utf8");
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line} [${rule}]`);
    }
  }
}

// Scan every unique blob reachable from every revision without checking old
// files out. Output is deliberately redacted: filenames/rules are useful;
// secret values are not.
const revisions = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const scannedBlobs = new Set();
for (const revision of revisions) {
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", revision], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (!match || scannedBlobs.has(match[1])) continue;
    scannedBlobs.add(match[1]);
    const size = Number(execFileSync("git", ["cat-file", "-s", match[1]], { encoding: "utf8" }));
    if (size > 5_000_000) continue;
    const content = execFileSync("git", ["cat-file", "blob", match[1]]);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      let finding;
      while ((finding = pattern.exec(text))) {
        const line = text.slice(0, finding.index).split("\n").length;
        findings.push(`${revision.slice(0, 12)}:${match[2]}:${line} [${rule}]`);
      }
    }
  }
}

const unique = [...new Set(findings)].sort();
if (unique.length > 0) {
  console.error("Potential secrets detected (values redacted):");
  for (const finding of unique) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Secret scan passed (${currentFilesScanned} current text files, ${revisions.length} revisions).`
);
