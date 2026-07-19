#!/usr/bin/env node

import fs from "node:fs";

const tag = process.argv[2] || "";
const version = tag.startsWith("v") ? tag.slice(1) : "";
const root = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(
  fs.readFileSync(new URL("../server/package.json", import.meta.url), "utf8")
);
const web = JSON.parse(fs.readFileSync(new URL("../web/package.json", import.meta.url), "utf8"));

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error(`release tag must be v<semver>; received ${tag || "(empty)"}`);
if ([root.version, server.version, web.version].some((value) => value !== version))
  throw new Error(
    `release tag ${tag} does not match package versions ${root.version}, ${server.version}, ${web.version}`
  );
console.log(`Release version ${version} is consistent.`);
