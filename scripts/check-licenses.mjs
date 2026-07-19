#!/usr/bin/env node

import fs from "node:fs";

const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const allowed = new Set([
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT OR WTFPL)",
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
]);

const missing = [];
const unreviewed = [];
let count = 0;
for (const [location, pkg] of Object.entries(lock.packages ?? {})) {
  if (!location.includes("node_modules/")) continue;
  if (location === "node_modules/@harbor/server" || location === "node_modules/@harbor/web")
    continue;
  count += 1;
  if (!pkg.license) missing.push(location);
  else if (!allowed.has(pkg.license)) unreviewed.push(`${location}: ${pkg.license}`);
}

if (missing.length || unreviewed.length) {
  if (missing.length)
    console.error(`Dependencies without a declared license:\n${missing.join("\n")}`);
  if (unreviewed.length)
    console.error(`Dependencies with an unreviewed license:\n${unreviewed.join("\n")}`);
  process.exit(1);
}

console.log(`License policy passed for ${count} locked dependency packages.`);
