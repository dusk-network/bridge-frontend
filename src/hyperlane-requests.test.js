import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decodeBase58 } from "@dusk-network/networks/account";

import { loadConfig } from "./config.js";
import { createDriverLoader, toHex } from "./data-driver.js";
import { sendDuskContractCall, useDuskWallet } from "./dusk-wallet.js";
import { NOT_AN_EVM_RECIPIENT, U64_MAX, duskRecipientHash } from "./hyperlane.js";
import { NOTHING_TO_CLAIM, NOT_CARRIED, approveRequest, claimRequest, transferRemoteRequest } from "./hyperlane-requests.js";
import { MAILBOX_FULL, ROUTE_NOT_AS_BOOKED } from "./hyperlane-reads.js";
import { duskCallLines, transferRemoteLines } from "./wallet-lines.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const T = Object.fromEntries(cfg.hyperlane.tokens.map((token) => [token.symbol, token]));
const loadDriver = createDriverLoader({ fetch: async (url) => new Response(await readFile(new URL(`../public${url}`, import.meta.url))) });

const DUSK = 1_000_000_000n;
const FEE = 16_876_000_000n;
const SENDER = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";

/** The node and the routes as a transfer finds them, each read counted. */
function chain(patch = {}) {
  const state = { allowance: 0n, balance: 100n * DUSK, fee: FEE, held: 50n * 1_000_000n, paused: false, pending: 0n, ...patch };
  const read = [];
  const reads = {
    allowance: async () => (read.push("allowance"), state.allowance),
    checkMailbox: async () => (read.push("mailbox"), state.mailbox ? Promise.reject(new Error(state.mailbox)) : undefined),
    checkRoute: async () => (read.push("route"), state.route ? Promise.reject(new Error(state.route)) : undefined),
    dispatchFee: async (_token, args = {}) => (read.push("fee"), (state.feeAsked = args), state.fee),
    driver: () => loadDriver(cfg.hyperlane.driver.url, cfg.hyperlane.driver.sha256),
    escrow: async (hash, tokens) => tokens.map((token) => ({ hash, pending: state.pending, registered: false, token })),
    paused: async () => (read.push("paused"), state.paused),
    tokenBalance: async () => (read.push("balance"), state.held),
  };
  const node = { accountBalance: async () => state.balance, gasPrice: async () => 3n };
  return { node, read, reads, state };
}

const transfer = (token, patch, request = {}) => {
  const { node, reads } = chain(patch);
  return transferRemoteRequest({ amount: 10_000_000n, cfg, gasPrice: 1n, node, reads, recipient: EVM, sender: SENDER, token, ...request });
};

test("DUSK to Sepolia deposits the amount and the route's quote, read as the request is built, to the route", async () => {
  const request = await transfer(T.DUSK, {}, { amount: DUSK });
  assert.deepEqual(
    { ...request, fnArgs: toHex(request.fnArgs) },
    {
      contractId: T.DUSK.dusk.route,
      depositLux: DUSK + FEE,
      display: { label: "Bridge 1 DUSK to Sepolia", recipient: EVM },
      fee: FEE,
      fnArgs: `${"00".repeat(12)}${EVM.slice(2).toLowerCase()}a736aa0000000000${"00ca9a3b00000000"}`,
      fnName: "transfer_remote",
      gas: { limit: "5000000", price: "1" },
    },
  );
  // At the node's price where the page quoted none.
  assert.equal((await transfer(T.DUSK, {}, { gasPrice: null })).gas.price, "3");
});

test("EURd to Sepolia deposits only the route's quote, and goes out only once the route may take it", async () => {
  const request = await transfer(T.EURd, { allowance: 10_000_000n });
  assert.deepEqual([request.contractId, request.depositLux, request.display.label], [T.EURd.dusk.route, FEE, "Bridge 10 EURd to Sepolia"]);
  await assert.rejects(transfer(T.EURd, { allowance: 9_999_999n }), { message: "The route may take 9.999999 EURd of yours, less than this transfer. Approve it first." });
  await assert.rejects(transfer(T.EURd, { allowance: 10_000_000n, held: 1n }), { message: "You have 0.000001 EURd, less than this transfer. Nothing was sent." });
  await assert.rejects(transfer(T.EURd, { allowance: 10_000_000n, paused: true }), { message: "EURd is paused on Dusk, so nothing was sent." });
  // The fee and the network fee at its limit are DUSK.
  await assert.rejects(transfer(T.EURd, { allowance: 10_000_000n, balance: FEE + 4_999_999n }), { message: "It needs 16.881 DUSK, with its fees, and you have 16.880999999 DUSK. Nothing was sent." });
  await transfer(T.EURd, { allowance: 10_000_000n, balance: FEE + 5_000_000n });
});

test("nothing is built for a transfer the chain would refuse: no amount, too much, a recipient that isn't 20 bytes, a route not as booked, a fee that moved", async () => {
  for (const amount of [0n, U64_MAX + 1n]) await assert.rejects(transfer(T.DUSK, {}, { amount }), { message: NOT_CARRIED });
  for (const recipient of [`0x${"11".repeat(32)}`, "0x0000000000000000000000000000000000000000", SENDER])
    await assert.rejects(transfer(T.DUSK, {}, { recipient }), { message: NOT_AN_EVM_RECIPIENT }, recipient);
  const { node, read, reads } = chain({ route: ROUTE_NOT_AS_BOOKED });
  await assert.rejects(transferRemoteRequest({ amount: DUSK, cfg, node, reads, recipient: EVM, sender: SENDER, token: T.DUSK }), { message: ROUTE_NOT_AS_BOOKED });
  assert.deepEqual(read, ["route"]);
  // The fee the review showed is the one sent, or nothing is.
  await assert.rejects(transfer(T.DUSK, { fee: FEE + 1n }, { reviewedFee: FEE }), { code: "FEE_CHANGED", fee: FEE + 1n, message: "The bridge fee is now 16.876000001 DUSK. Check the review again." });
  await transfer(T.DUSK, {}, { reviewedFee: FEE });
  // Not enough DUSK for what it deposits and the network fee.
  await assert.rejects(transfer(T.DUSK, { balance: FEE + DUSK }, { amount: DUSK }), { message: /^It needs 17\.881 DUSK, with its fees, and you have 17\.876 DUSK\./u });
});

test("an approval lets the route take exactly the amount, and only where the transfer after it can be paid", async () => {
  const { node, reads } = chain();
  const request = await approveRequest({ amount: 25_000_000n, cfg, gasPrice: 1n, node, reads, recipient: EVM, sender: SENDER, token: T.EURd });
  assert.equal(toHex(request.fnArgs), `40787d0100000000` + `02` + T.EURd.dusk.route + "00".repeat(208 - 41));
  // The bridge fee the transfer after it will pay, read with it: its review shows it.
  assert.equal(request.fee, FEE);
  assert.deepEqual([request.contractId, request.fnName, request.gas.limit, "depositLux" in request], [T.EURd.dusk.token, "approve", "3000000", false]);
  // The approval, the transfer and the route's fee, at their limits.
  const approve = (patch, amount = 25_000_000n) => approveRequest({ amount, cfg, gasPrice: 1n, ...chain(patch), recipient: EVM, sender: SENDER, token: T.EURd });
  await assert.rejects(approve({ balance: FEE + 7_999_999n }), { message: /^It needs 16\.884 DUSK, with its fees/u });
  await assert.rejects(approve({ paused: true }), /paused/u);
  await assert.rejects(approve({}, 0n), { message: NOT_CARRIED });
});

test("an account claims its own escrow with claim_pending, and another claims it for it with claim_pending_for and its key", async () => {
  const own = await claimRequest({ account: SENDER, gasPrice: 1n, ...chain({ pending: 10_000_000n }), signer: SENDER, token: T.EURd });
  assert.deepEqual([own.contractId, own.fnName, own.fnArgs.length, own.gas.limit, own.pending], [T.EURd.dusk.route, "claim_pending", 0, "3000000", 10_000_000n]);
  assert.equal(own.display.label, "Claim 10 EURd from the bridge");
  const forIt = await claimRequest({ account: SENDER, gasPrice: 1n, ...chain({ pending: 10_000_000n }), signer: OTHER, token: T.EURd });
  assert.deepEqual([forIt.fnName, forIt.gas.limit], ["claim_pending_for", "80000000"]);
  // The key as the route decodes it, written by the Hyperlane driver.
  const driver = await loadDriver(cfg.hyperlane.driver.url, cfg.hyperlane.driver.sha256);
  assert.deepEqual(driver.decodeInputFn("claim_pending_for", forIt.fnArgs), { account: [...decodeBase58(SENDER)] });
  await assert.rejects(claimRequest({ account: SENDER, gasPrice: 1n, ...chain(), signer: SENDER, token: T.EURd }), { message: NOTHING_TO_CLAIM });
  // Without DUSK for the fee, another account can claim it.
  await assert.rejects(claimRequest({ account: SENDER, gasPrice: 1n, ...chain({ balance: 0n, pending: 1n }), signer: SENDER, token: T.EURd }), {
    message: "Your account has 0 DUSK, and the claim's fee can be up to 0.003 DUSK. Another Dusk account can claim it for you.",
  });
});

test("Dusk Wallet gets the request the review showed, with its deposit, and shows it as a call to the route", async () => {
  const sent = [];
  useDuskWallet({
    async connect() {},
    async refresh() {},
    async sendContractCall(params) {
      sent.push(params);
      return { hash: "c".repeat(64) };
    },
    state: { authorized: true, chainId: "dusk:2", selectedProfile: { account: SENDER } },
    async switchChain() {},
  });
  const request = await transfer(T.DUSK, {}, { amount: DUSK });
  await sendDuskContractCall(request, { account: SENDER });
  assert.deepEqual(sent, [
    {
      contractId: `0x${T.DUSK.dusk.route}`,
      deposit: (DUSK + FEE).toString(),
      display: { label: "Bridge 1 DUSK to Sepolia", recipient: EVM },
      fnArgs: `0x${toHex(request.fnArgs)}`,
      fnName: "transfer_remote",
      gas: { limit: "5000000", price: "1" },
      privacy: "public",
    },
  ]);
  const lines = await duskCallLines({ ...request, chainId: cfg.dusk.chainId, from: SENDER, note: "The DUSK route to Sepolia, on Dusk." });
  assert.deepEqual(
    lines.filter((line) => !line.fold && line.kind !== "head").map((line) => [line.label, line.value]),
    [
      ["From", "xGX8tZ…zQjkw9"],
      ["Contract", "979fb7…ee5a0b"],
      ["Deposit", "17.876 DUSK"],
      ["Network fee", "up to 0.005 DUSK"],
      ["Total", "up to 17.881 DUSK"],
    ],
  );
});

test("an EVM wallet's lines for a transfer back to Dusk name the token, Dusk's domain, the account's hash and the fee as its value", () => {
  const lines = transferRemoteLines({ amount: 32_156_353n, cfg, fee: 552_474_000_000_000n, recipient: SENDER, recipientHash: duskRecipientHash(SENDER), token: T.USDd, value: 132_000_000_001n });
  assert.deepEqual(
    lines.map((line) => [line.label, line.value ?? line.address]),
    [
      ["Network", "Sepolia, chain 11155111"],
      ["Interacting with", "USDd on Sepolia"],
      ["Method", "transferRemote"],
      ["destination", "1146442572"],
      ["recipient", "0x2acf0348cca26cf2d0a4ecbddde6e7abd3d54b2e581a73a7741301e1b411b69b"],
      ["Pays on Dusk", SENDER],
      ["amount", "32156353"],
      ["Value", "0.000000132000000001 ETH"],
      ["Network fee", "about 0.00055 ETH"],
    ],
  );
  assert.equal(lines[1].address, T.USDd.evm.token);
  assert.equal(lines[6].note, "= 32.156353 USDd. Wallets show the token's smallest unit.");
});

test("an approval is asked for only once the transfer after it could go: the recipient, the route as booked, and the Mailbox's room", async () => {
  const approve = (patch, request = {}) => {
    const world = chain(patch);
    return { request: approveRequest({ amount: 25_000_000n, cfg, gasPrice: 1n, ...world, recipient: EVM, sender: SENDER, token: T.EURd, ...request }), world };
  };
  const notBooked = approve({ route: ROUTE_NOT_AS_BOOKED });
  await assert.rejects(notBooked.request, { message: ROUTE_NOT_AS_BOOKED });
  assert.deepEqual(notBooked.world.read, ["route"]);
  await assert.rejects(approve({ mailbox: MAILBOX_FULL }).request, { message: MAILBOX_FULL });
  await assert.rejects(approve({}, { recipient: `0x${"11".repeat(32)}` }).request, { message: NOT_AN_EVM_RECIPIENT });
  // The route is quoted for the transfer itself.
  const fine = approve({});
  await fine.request;
  assert.deepEqual(fine.world.state.feeAsked, { amount: 25_000_000n, recipient: EVM });
});

test("a claim of EURd or USDd isn't built while the token is paused: the route can't pay it out", async () => {
  await assert.rejects(claimRequest({ account: SENDER, cfg, gasPrice: 1n, ...chain({ paused: true, pending: 10_000_000n }), signer: OTHER, token: T.EURd }), {
    message: "EURd is paused on Dusk, so nothing was sent.",
  });
  // DUSK's route pays out DUSK itself.
  await claimRequest({ account: SENDER, cfg, gasPrice: 1n, ...chain({ paused: true, pending: 1n }), signer: SENDER, token: T.DUSK });
});

test("no Hyperlane request asks the wallet for more gas than the deployment allows", async () => {
  const capped = (limit) => ({ ...cfg, gasLimitUpper: limit });
  // A claim for another account takes 80M: not under a 50M ceiling. One's own, 3M, is.
  await assert.rejects(claimRequest({ account: SENDER, cfg: capped(50_000_000n), gasPrice: 1n, ...chain({ pending: 1n }), signer: OTHER, token: T.EURd }), {
    message: "This claim needs more gas than the wallet allows, so it wasn't sent.",
  });
  await claimRequest({ account: SENDER, cfg: capped(50_000_000n), gasPrice: 1n, ...chain({ pending: 1n }), signer: SENDER, token: T.EURd });
  await assert.rejects(transfer(T.DUSK, {}, { cfg: capped(4_999_999n) }), { message: "This transfer needs more gas than the wallet allows, so it wasn't sent." });
  await assert.rejects(approveRequest({ amount: 1n, cfg: capped(2_000_000n), gasPrice: 1n, ...chain(), recipient: EVM, sender: SENDER, token: T.EURd }), {
    message: "This approval needs more gas than the wallet allows, so it wasn't sent.",
  });
  // The approval is within it, but the transfer after it isn't: no approval for a transfer that couldn't follow.
  await assert.rejects(approveRequest({ amount: 1n, cfg: capped(4_000_000n), gasPrice: 1n, ...chain(), recipient: EVM, sender: SENDER, token: T.EURd }), {
    message: "This transfer needs more gas than the wallet allows, so it wasn't sent.",
  });
});
