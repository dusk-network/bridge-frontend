import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash, parseLocation, quotesOn, receiptUrl, transferHref } from "./permalink.js";

const DUSK = "3835e0".padEnd(64, "a");
const EVM = `0x${"Ab".repeat(32)}`;

test("a receipt link names the transfer by its source hash", () => {
  assert.equal(transferHref(DUSK), `#/transfer/${DUSK}`);
  assert.equal(transferHref(EVM), `#/transfer/0x${"ab".repeat(32)}`);
  assert.equal(
    receiptUrl(DUSK, { origin: "https://bridge.example.org", pathname: "/" }),
    `https://bridge.example.org/#/transfer/${DUSK}`,
  );
  assert.equal(canonicalHash("nope"), null);
});

test("every page reads back from its link", () => {
  assert.deepEqual(parseLocation(""), { page: "home" });
  assert.deepEqual(parseLocation("#/"), { page: "home" });
  assert.deepEqual(parseLocation("#/move/to-duskevm"), { page: "move", task: "to-duskevm" });
  assert.deepEqual(parseLocation("#/transfers"), { page: "transfers" });
  assert.deepEqual(parseLocation(transferHref(DUSK)), { hash: DUSK, page: "transfer" });
  assert.deepEqual(parseLocation(`#/transfer/${EVM.toUpperCase().replace("0X", "0x")}/`), {
    hash: `0x${"ab".repeat(32)}`,
    page: "transfer",
  });
  // Not a hash: offered as a lookup instead of a broken receipt.
  assert.deepEqual(parseLocation("#/transfer/0x1234"), { page: "lookup", query: "0x1234" });
  assert.deepEqual(parseLocation("#/somewhere/else"), { page: "home" });
});

test("a malformed link opens a page instead of failing", () => {
  assert.deepEqual(parseLocation("#/lookup/%"), { page: "lookup", query: "%" });
  assert.deepEqual(parseLocation("#/transfer/%E0%A4%A"), { page: "lookup", query: "%E0%A4%A" });
  assert.deepEqual(parseLocation("#/%"), { page: "home" });
});

test("look up quotes no fee or time, so nothing draws it again while a hash is typed", () => {
  for (const hash of ["#/lookup", "#/lookup/0xab", "#/transfer/not-a-hash"]) assert.equal(quotesOn(parseLocation(hash)), false, hash);
  for (const hash of ["#/", "#/move/migrate", `#/transfer/${"ab".repeat(32)}`, "#/transfers"]) assert.equal(quotesOn(parseLocation(hash)), true, hash);
});
