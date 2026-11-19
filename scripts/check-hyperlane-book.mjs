#!/usr/bin/env node
// Checks the Hyperlane address book against a deployment's record: every
// value in src/hyperlane-<network>.json, but its `source`, must be the
// record's at the same path, addresses compared without their case.
//
//   node scripts/check-hyperlane-book.mjs <deployment.json> [testnet]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [recordPath, network = "testnet"] = process.argv.slice(2);
if (!recordPath) {
  console.error("Usage: node scripts/check-hyperlane-book.mjs <deployment.json> [testnet]");
  process.exit(2);
}

const raw = readFileSync(recordPath);
const record = JSON.parse(raw.toString("utf8"));
const { source, ...book } = JSON.parse(readFileSync(new URL(`../src/hyperlane-${network}.json`, import.meta.url), "utf8"));

const differences = [];
function compare(expected, actual, path) {
  if (expected && typeof expected === "object") {
    for (const [key, value] of Object.entries(expected)) compare(value, actual?.[key], `${path}.${key}`);
    return;
  }
  const same = typeof expected === "string" && typeof actual === "string" ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
  if (!same) differences.push(`${path}: the book has ${JSON.stringify(expected)}, the record ${JSON.stringify(actual)}`);
}
compare(book, record, "");

const sha256 = createHash("sha256").update(raw).digest("hex");
if (sha256 !== source.sha256) console.log(`The record has changed since the book was read (${source.read}): sha256 ${sha256}.`);
if (differences.length) {
  console.error(differences.join("\n"));
  process.exit(1);
}
console.log(`Every value in the ${network} book is the record's.`);
