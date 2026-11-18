import assert from "node:assert/strict";
import test from "node:test";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const { loadConfig } = await import("../src/config.js");
const { backLine } = await import("./hyperlane-live-lines.mjs");
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const eurd = cfg.hyperlane.tokens.find((token) => token.symbol === "EURd");

test("what Sepolia didn't answer is said as unknown, never as 0, and nothing is weighed against it", () => {
  const unread = backLine({ amount: 1_000_000n, evm: { balance: null, deliveryFeeWei: null, gasCoinWei: null, gasPriceWei: null }, gas: null, token: eurd });
  assert.match(unread, /bridge fee unknown/u);
  assert.match(unread, /gas unknown/u);
  assert.match(unread, /holds an unknown amount of EURd and unknown ETH/u);
  assert.doesNotMatch(unread, /\b0 ETH|send it there first|too little ETH/u);
  // Read: said, and what's short.
  const read = backLine({ amount: 1_000_000n, evm: { balance: 0n, deliveryFeeWei: 132_000_000_001n, gasCoinWei: 10n ** 16n, gasPriceWei: 21n }, gas: 250_000n, token: eurd });
  assert.match(read, /bridge fee 0\.000000132000000001 ETH, gas about 0\.00000000000525 ETH; the address holds 0 EURd and 0\.01 ETH \(send it there first\)\./u);
});
