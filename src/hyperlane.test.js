import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sepolia } from "viem/chains";

import { loadConfig } from "./config.js";
import { driverJson, loadDataDriver, toHex } from "./data-driver.js";
import {
  HYPERLANE_EVM_ABI,
  NOT_AN_EVM_RECIPIENT,
  U64_MAX,
  approveArgs,
  carries,
  duskRecipientHash,
  evmRecipient,
  hyperlaneToken,
  readBool,
  readTransferRemoteArgs,
  readU64,
  transferRemoteArgs,
} from "./hyperlane.js";

function profile(name, extra = {}) {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: name, ...extra };
  try {
    return loadConfig();
  } finally {
    delete globalThis.__DUSK_BRIDGE_CONFIG__;
  }
}
const { hyperlane } = profile("testnet");
const bySymbol = Object.fromEntries(hyperlane.tokens.map((token) => [token.symbol, token]));

// The traffic accounts of the 18 Nov 2026 run, on Dusk and Sepolia.
const TRAFFIC = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const TRAFFIC_EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";
const EURD_ROUTE = "78ff6b1dcbccb55020655c0abccdaef3d81f97f5c376519fb3195deaa4d6aef8";

test("testnet's Hyperlane routes are the deployment's record: Dusk testnet and Sepolia, DUSK, EURd and USDd", () => {
  assert.equal(hyperlane.enabled, true);
  assert.deepEqual([hyperlane.dusk.domain, hyperlane.evm.domain], [1146442572, 11155111]);
  assert.equal(hyperlane.dusk.mailbox, "d6948f7b67469a2223e16002560ce0f90730104054fd16aced9ec8d7b1613412");
  assert.equal(hyperlane.dusk.igp, "990f30ef9747782fe40bd355d74d044cc8103d6f403267e1b1c3af7c87c22e4b");
  assert.equal(hyperlane.evm.mailbox, "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766");
  // Sepolia as viem has it, and where testnet's file has that chain.
  assert.equal(hyperlane.chain, sepolia);
  assert.equal(hyperlane.network, "ethereum");
  assert.deepEqual(
    hyperlane.tokens.map((token) => [token.symbol, token.decimals, token.native, token.dusk.route, token.dusk.token, token.evm.token]),
    [
      ["DUSK", 9, true, "979fb72774e1d45a07abd0d57479578513917ab855bb4027acdfd48ac8ee5a0b", null, "0x213Fa2a0E69624C70C23156616B813919D040A54"],
      ["EURd", 6, false, EURD_ROUTE, "1f636d4fe3c7b0692e16f1a357a54ffadd6e5496c31908a9e093ef3d712ffd1a", "0xcd283386E79006e8e03a8cb6734b14A70733aAcC"],
      ["USDd", 6, false, "5399349f33a5b119d91ded159be4d7acfbf067b10dc5590696c129f92bec0998", "670e34d05c2f52cede5791ce206d139715babb2ac4fb3cafe92e889e7f595a24", "0xc2d59C37D94Adf346faE6A4FE24f42caaFD8fcB6"],
    ],
  );
  assert.deepEqual(bySymbol.EURd.routes, { in: "sepolia-to-dusk-eurd", out: "dusk-to-sepolia-eurd" });
  assert.deepEqual(bySymbol.DUSK.routes, { in: "sepolia-to-dusk", out: "dusk-to-sepolia" });
  assert.deepEqual(hyperlaneToken(hyperlane, "sepolia-to-dusk-usdd"), { direction: "in", token: bySymbol.USDd });
  assert.equal(hyperlaneToken(hyperlane, "dusk-to-ethereum"), null);
  // The measured times, as expectations.
  assert.deepEqual(hyperlane.seconds, { in: 60, out: 20 });
});

test("a deployment runs the Hyperlane tokens it lists, or none; mainnet has no deployment yet", () => {
  assert.deepEqual(profile("testnet", { VITE_HYPERLANE_TOKENS: "eurd, DUSK" }).hyperlane.tokens.map((token) => token.symbol), ["DUSK", "EURd"]);
  const off = profile("testnet", { VITE_HYPERLANE_TOKENS: "none" }).hyperlane;
  assert.deepEqual([off.enabled, off.tokens.length], [false, 0]);
  assert.equal(profile("mainnet").hyperlane.enabled, false);
  // Not without the record's chain in the network's file, at an RPC this page reads.
  assert.equal(profile("testnet", { VITE_ETHEREUM_CHAIN_ID: "1" }).hyperlane.enabled, false);
});

test("a transfer to Sepolia carries the recipient first, then the domain and the amount, as the routes read it", () => {
  // Live transaction 86123720…: 95.085867 EURd to 0x8A51…B75d.
  const live = "0000000000000000000000008a51d0619286d937699d85c1a2c88d67a5a1b75d" + "a736aa00" + "00000000" + "2be5aa0500000000";
  const args = transferRemoteArgs({ amount: 95_085_867n, destination: 11155111, recipient: TRAFFIC_EVM });
  assert.equal(toHex(args), live);
  assert.deepEqual(readTransferRemoteArgs(live), {
    amount: 95_085_867n,
    destination: 11155111,
    recipient: TRAFFIC_EVM,
    recipient32: `0x${live.slice(0, 64)}`,
  });
  // The lower-case address the same.
  assert.equal(toHex(transferRemoteArgs({ amount: 95_085_867n, destination: 11155111, recipient: TRAFFIC_EVM.toLowerCase() })), live);
  // A recipient that isn't an EVM address's reads as none.
  assert.equal(readTransferRemoteArgs(`${"11".repeat(32)}${live.slice(64)}`).recipient, null);
  assert.equal(readTransferRemoteArgs("00"), null);
});

test("the routes' quote takes the transfer's own arguments, as the Hyperlane driver writes them", async () => {
  const driver = await loadDataDriver(readFileSync(new URL("../public/drivers/hyperlane_dusk_data_driver.wasm", import.meta.url)));
  const args = transferRemoteArgs({ amount: 95_085_867n, destination: 11155111, recipient: TRAFFIC_EVM });
  const quote = driver.encodeInputFn("quote_transfer_remote", driverJson([11155111, [...args.slice(0, 32)], 95_085_867n]));
  assert.equal(toHex(quote), toHex(args));
});

test("only a 20-byte EVM address can be a recipient on Sepolia, and only an amount a u64 carries", () => {
  for (const recipient of [`0x${"11".repeat(32)}`, "0x0000000000000000000000000000000000000000", TRAFFIC, "0x8a51d0619286d937699d85c1a2c88d67a5a1b7", "", null])
    assert.throws(() => transferRemoteArgs({ amount: 1n, destination: 11155111, recipient }), { message: NOT_AN_EVM_RECIPIENT }, String(recipient));
  assert.equal(evmRecipient(TRAFFIC_EVM).length, 32);
  for (const amount of [0n, -1n, U64_MAX + 1n, 1])
    assert.throws(() => transferRemoteArgs({ amount, destination: 11155111, recipient: TRAFFIC_EVM }), /above 0 and fit a u64/u, String(amount));
  assert.equal(readTransferRemoteArgs(transferRemoteArgs({ amount: U64_MAX, destination: 11155111, recipient: TRAFFIC_EVM })).amount, U64_MAX);
  assert.deepEqual([carries(1n), carries(U64_MAX), carries(0n), carries(U64_MAX + 1n), carries(1)], [true, true, false, false, false]);
});

test("an approval names the route as a contract spender, in the 208 bytes the canonical DRC20 reads", () => {
  // Live transaction fdec0ef0…: 1e12 units of EURd for its route.
  const live = `0010a5d4e8000000` + `02` + EURD_ROUTE + "00".repeat(208 - 41);
  assert.equal(toHex(approveArgs({ amount: 1_000_000_000_000n, spender: EURD_ROUTE })), live);
  assert.equal(approveArgs({ amount: 0n, spender: EURD_ROUTE })[8], 2);
  assert.throws(() => approveArgs({ amount: U64_MAX + 1n, spender: EURD_ROUTE }), /fit a u64/u);
  assert.throws(() => approveArgs({ amount: 1n, spender: TRAFFIC }), /contract ID/u);
});

test("a Dusk account is paid by the keccak256 of its 96-byte key", () => {
  // As dusk-tx account prints it for the traffic account.
  assert.equal(duskRecipientHash(TRAFFIC), "0x2acf0348cca26cf2d0a4ecbddde6e7abd3d54b2e581a73a7741301e1b411b69b");
  assert.equal(duskRecipientHash(` ${TRAFFIC} `), duskRecipientHash(TRAFFIC));
  // A typo isn't a key: it has no hash a route pays.
  assert.equal(duskRecipientHash(`${TRAFFIC.slice(0, -1)}A`), null);
  assert.equal(duskRecipientHash(TRAFFIC_EVM), null);
});

test("queries answer a u64 in 8 little-endian bytes and a bool in one", () => {
  assert.equal(readU64(Uint8Array.from([0x00, 0x53, 0xe3, 0xed, 0x03, 0, 0, 0])), 16_876_000_000n);
  assert.equal(readBool(Uint8Array.of(1)), true);
  assert.equal(readBool(Uint8Array.of(0)), false);
  assert.throws(() => readBool(Uint8Array.of(2)));
  assert.throws(() => readU64(Uint8Array.of(1, 2, 3)));
});

test("every EVM contract in the book stays known, whichever tokens a deployment runs: none of them can be a recipient", () => {
  const book = profile("testnet").hyperlane.evmContracts;
  const duskOnly = profile("testnet", { VITE_HYPERLANE_TOKENS: "dusk" }).hyperlane;
  const none = profile("testnet", { VITE_HYPERLANE_TOKENS: "none" }).hyperlane;
  assert.deepEqual(book, [
    "0x213Fa2a0E69624C70C23156616B813919D040A54",
    "0xcd283386E79006e8e03a8cb6734b14A70733aAcC",
    "0xc2d59C37D94Adf346faE6A4FE24f42caaFD8fcB6",
    "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766",
  ]);
  assert.deepEqual([duskOnly.tokens.length, duskOnly.evmContracts], [1, book]);
  assert.deepEqual(none.evmContracts, book);
});

test("the Sepolia token reads its enrolled Dusk router and the whole charge of a transfer, as HypERC20 12.3.0 does", () => {
  const names = HYPERLANE_EVM_ABI.filter((item) => item.type === "function").map((item) => item.name);
  assert.ok(names.includes("routers") && names.includes("quoteTransferRemote"), names.join());
  const quote = HYPERLANE_EVM_ABI.find((item) => item.name === "quoteTransferRemote");
  assert.deepEqual(quote.outputs[0].components.map((each) => `${each.type} ${each.name}`), ["address token", "uint256 amount"]);
});
