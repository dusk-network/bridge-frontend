import assert from "node:assert/strict";
import test from "node:test";

import { createFormReads } from "./form-reads.js";

const DEPOSIT = { mode: "duskevm-deposit", signer: "dusk" };
const MIGRATION = { from: { id: "ethereum" }, mode: "migration", signer: "evm" };
const WITHDRAWAL = { mode: "duskevm-withdrawal", signer: "evm" };

/** Answers each call when the test says so. */
function deferred() {
  const pending = [];
  const call = (...args) =>
    new Promise((resolve) => {
      pending.push({ args, resolve });
    });
  call.pending = pending;
  return call;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a slower, older balance read never overwrites a newer one", async () => {
  const accountBalance = deferred();
  const reads = createFormReads({ services: { node: { accountBalance, gasPrice: async () => 1n } } });

  const first = reads.load({ dusk: "first-account", route: DEPOSIT });
  const second = reads.load({ dusk: "second-account", route: DEPOSIT });
  await settle();
  const [old, current] = accountBalance.pending;
  assert.deepEqual([old.args[0], current.args[0]], ["first-account", "second-account"]);

  current.resolve(2n);
  await second;
  old.resolve(1n);
  await first;
  assert.equal(reads.reads.duskBalance, 2n);
});

test("a gas estimate for an earlier amount never overwrites a later one", async () => {
  const migrationGas = deferred();
  const services = {
    evmReads: {
      migrationGas,
      migrationState: async () => ({ allowanceWei: 0n, balanceWei: 10n ** 21n, gasCoinWei: 10n ** 16n, gasPriceWei: 1n }),
    },
    node: { gasPrice: async () => 1n },
  };
  const reads = createFormReads({ services });
  const loading = reads.load({ evm: "0xowner", gas: { amountWei: 1n }, route: MIGRATION });
  await settle();
  migrationGas.pending.shift().resolve({ approve: 1n, migrate: 1n });
  await loading;

  const earlier = reads.estimate({ evm: "0xowner", gas: { amountWei: 5n }, route: MIGRATION });
  const later = reads.estimate({ evm: "0xowner", gas: { amountWei: 6n }, route: MIGRATION });
  await settle();
  const [five, six] = migrationGas.pending;
  six.resolve({ approve: 46_000n, migrate: 60_000n });
  await later;
  five.resolve({ approve: 1n, migrate: 1n });
  await earlier;
  assert.deepEqual(reads.reads.migration.gas, { approve: 46_000n, migrate: 60_000n });
});

test("a read still running when the account changes is dropped", async () => {
  const accountBalance = deferred();
  const reads = createFormReads({ services: { node: { accountBalance, gasPrice: async () => 1n } } });
  const loading = reads.load({ dusk: "old-account", route: DEPOSIT });
  await settle();
  reads.reset(["duskBalance"]);
  accountBalance.pending[0].resolve(5n);
  await loading;
  assert.equal(reads.reads.duskBalance, null);
});

test("the gas price read again draws what quotes it, where it moved", async () => {
  let drawn = 0;
  let node = 1n;
  const reads = createFormReads({ onPrice: () => (drawn += 1), services: { node: { gasPrice: async () => node } } });
  assert.equal(await reads.price(), false);
  assert.equal(drawn, 0);
  // The node's price moved: every fee the page quotes is drawn again at it.
  node = 2n;
  assert.equal(await reads.price(), true);
  assert.deepEqual([reads.reads.gasPrice, drawn], [2n, 1]);
  assert.equal(await reads.price(), false);
  assert.equal(drawn, 1);
});

test("the form reads whether the network is busy with its gas price, and draws again when that changes", async () => {
  let drawn = 0;
  let gas = { busy: false, price: 5n };
  const accountBalance = async () => 10n;
  const reads = createFormReads({ onPrice: () => (drawn += 1), services: { node: { accountBalance, networkGas: async () => gas } } });
  await reads.load({ dusk: "a", route: { mode: "duskevm-deposit", signer: "dusk" } });
  assert.deepEqual([reads.reads.gasPrice, reads.reads.networkBusy], [5n, false]);
  // What waits now asks more than 5 Lux: the price stays, the network is busy, and what says so is drawn again.
  gas = { busy: true, price: 5n };
  assert.equal(await reads.price(), true);
  assert.deepEqual([reads.reads.gasPrice, reads.reads.networkBusy, drawn], [5n, true, 1]);
  assert.equal(await reads.price(), false);
  // A node that only gives its price isn't busy.
  const plain = createFormReads({ services: { node: { accountBalance, gasPrice: async () => 2n } } });
  await plain.load({ dusk: "a", route: { mode: "duskevm-deposit", signer: "dusk" } });
  assert.deepEqual([plain.reads.gasPrice, plain.reads.networkBusy], [2n, false]);
});

test("a Hyperlane route's form reads its quote and a token's balance and allowance, and what the routes hold for the account", async () => {
  const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
  const token = { native: false, symbol: "EURd" };
  const asked = [];
  const hyperlane = {
    allowance: async (_token, account) => (asked.push(["allowance", account]), 7n),
    dispatchFee: async (_token, args) => (asked.push(["fee", args]), 16_876_000_000n),
    escrow: async (hash, tokens) => (asked.push(["escrow", hash, tokens?.length ?? "all"]), [{ pending: 10n, registered: false, token }]),
    evmState: async (_token, owner) => (asked.push(["evm", owner]), { balance: 5n, deliveryFeeWei: 132n, gasCoinWei: 9n, gasPriceWei: 2n }),
    tokenBalance: async (_token, account) => (asked.push(["balance", account]), 49n),
    transferGas: async (_token, { value }) => (asked.push(["gas", value]), 250_000n),
  };
  const services = { hyperlane, node: { accountBalance: async () => 20n, gasPrice: async () => 1n } };
  const reads = createFormReads({ services });
  const out = { hyperlane: token, mode: "hyperlane", signer: "dusk" };
  await reads.load({ dusk: ACCOUNT, gas: { amount: 3n, recipient: "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d" }, route: out });
  await settle();
  assert.deepEqual(reads.reads.hyperlane, { allowance: 7n, fee: 16_876_000_000n, tokenBalance: 49n });
  assert.equal(reads.reads.duskBalance, 20n);
  // The route's quote takes the transfer's own amount and recipient.
  assert.deepEqual(asked.find(([kind]) => kind === "fee")[1], { amount: 3n, recipient: "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d" });
  // Every route's escrow for the connected account, by its hash, and, with something held, its DUSK for a claim's fee.
  assert.deepEqual(reads.reads.escrow, { account: ACCOUNT, balance: 20n, held: [{ pending: 10n, registered: false, token }] });
  assert.deepEqual(asked.find(([kind]) => kind === "escrow"), ["escrow", "0x2acf0348cca26cf2d0a4ecbddde6e7abd3d54b2e581a73a7741301e1b411b69b", "all"]);

  // Back to Dusk: the EVM side, the transfer's gas with the delivery fee as its value, and whether the route pays the recipient yet.
  asked.length = 0;
  const back = { hyperlane: token, mode: "hyperlane", signer: "evm" };
  await reads.load({ evm: "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d", gas: { amount: 3n, recipientHash: "0x2acf" }, route: back });
  assert.deepEqual(reads.reads.hyperlane, { evm: { balance: 5n, deliveryFeeWei: 132n, gasCoinWei: 9n, gasPriceWei: 2n }, gas: 250_000n, registered: false });
  assert.deepEqual(asked.find(([kind]) => kind === "gas"), ["gas", 132n]);
});

test("on the way into Dusk, the escrow read is the typed recipient's, which anyone can claim for", async () => {
  const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
  const hashes = [];
  const hyperlane = {
    escrow: async (hash) => (hashes.push(hash), [{ pending: 0n, registered: true, token: {} }]),
    evmState: async () => ({ balance: 0n, deliveryFeeWei: null, gasCoinWei: 0n, gasPriceWei: 1n }),
  };
  const reads = createFormReads({ services: { hyperlane, node: { accountBalance: async () => 0n, gasPrice: async () => 1n } } });
  const back = { hyperlane: { native: true }, mode: "hyperlane", signer: "evm" };
  await reads.load({ dusk: "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9", escrowFor: OTHER, evm: "0x1", route: back });
  await settle();
  assert.equal(reads.reads.escrow.account, OTHER);
  // Nothing held: its balance isn't asked.
  assert.equal(reads.reads.escrow.balance, null);
  assert.equal(hashes.length, 1);
});

test("a Hyperlane form's load that answers after a newer estimate doesn't put back its older quote", async () => {
  const dispatchFee = deferred();
  const hyperlane = { allowance: async () => 0n, dispatchFee, escrow: async () => [], tokenBalance: async () => 0n };
  const reads = createFormReads({ services: { hyperlane, node: { accountBalance: async () => 0n, gasPrice: async () => 1n } } });
  const out = { hyperlane: { native: false, symbol: "EURd" }, mode: "hyperlane", signer: "dusk" };
  // The card loads for the route; then the amount is typed, and its estimate answers first.
  const loading = reads.load({ dusk: "account", gas: {}, route: out });
  await settle();
  const typed = reads.estimate({ gas: { amount: 5n, dusk: "account", recipient: "0x1" }, route: out });
  await settle();
  const [old, current] = dispatchFee.pending;
  assert.deepEqual([old.args[1], current.args[1]], [{}, { amount: 5n, recipient: "0x1" }]);
  current.resolve(2n);
  await typed;
  old.resolve(1n);
  await loading;
  assert.equal(reads.reads.hyperlane.fee, 2n);
  // A reset drops both.
  const again = reads.estimate({ gas: { amount: 6n, dusk: "account", recipient: "0x1" }, route: out });
  await settle();
  reads.reset(["hyperlane"]);
  dispatchFee.pending.at(-1).resolve(3n);
  await again;
  assert.equal(reads.reads.hyperlane, null);
});

test("what the routes hold is read again on its own, and an older read that answers late doesn't put back what it found", async () => {
  const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
  const escrow = deferred();
  const reads = createFormReads({ services: { hyperlane: { escrow }, node: { accountBalance: async () => 5n, gasPrice: async () => 1n } } });
  const first = reads.escrow(ACCOUNT);
  const second = reads.escrow(ACCOUNT);
  await settle();
  const [old, current] = escrow.pending;
  // The newer read finds the transfer delivered into escrow; the older one, from before, nothing.
  current.resolve([{ pending: 7n, registered: false, token: {} }]);
  await second;
  old.resolve([{ pending: 0n, registered: false, token: {} }]);
  await first;
  assert.deepEqual([reads.reads.escrow.account, reads.reads.escrow.held.map((each) => each.pending), reads.reads.escrow.balance], [ACCOUNT, [7n], 5n]);
});

test("an allowance that couldn't be read says so, not that nothing is approved", async () => {
  const hyperlane = {
    allowance: async () => {
      throw new Error("node down");
    },
    dispatchFee: async () => 1n,
    escrow: async () => [],
    tokenBalance: async () => 5n,
  };
  const reads = createFormReads({ services: { hyperlane, node: { accountBalance: async () => 0n, gasPrice: async () => 1n } } });
  await reads.load({ dusk: "account", gas: {}, route: { hyperlane: { native: false, symbol: "EURd" }, mode: "hyperlane", signer: "dusk" } });
  assert.deepEqual(reads.reads.hyperlane, { allowance: null, allowanceFailed: true, fee: 1n, tokenBalance: 5n });
});

test("a withdrawal's state lands with the call it was read for, and one that couldn't be read says only that", async () => {
  let down = false;
  const withdrawalState = async () => {
    if (down) throw new Error("node down");
    return { balanceWei: 5n, estimated: true, gas: 138_439n };
  };
  const reads = createFormReads({ services: { evmReads: { withdrawalState }, node: { gasPrice: async () => 1n } } });
  const gas = { amountWei: 10n ** 18n, duskAccount: "dusk-account" };
  await reads.load({ evm: "0xowner", gas, route: WITHDRAWAL });
  assert.deepEqual(reads.reads.l2, { balanceWei: 5n, call: { ...gas, owner: "0xowner" }, estimated: true, gas: 138_439n });
  // Not read, as the amount's estimate or on a load: no estimate for that call, and nothing else.
  down = true;
  const more = { amountWei: 2n * 10n ** 18n, duskAccount: "dusk-account" };
  await reads.estimate({ evm: "0xowner", gas: more, route: WITHDRAWAL });
  assert.deepEqual(reads.reads.l2, { call: { ...more, owner: "0xowner" }, estimated: false });
  await reads.load({ evm: "0xowner", gas: {}, route: WITHDRAWAL });
  assert.deepEqual(reads.reads.l2, { call: null, estimated: false });
});

test("a withdrawal's read that answers after a newer one started, for an amount since typed, doesn't put back its older state", async () => {
  const withdrawalState = deferred();
  const reads = createFormReads({ services: { evmReads: { withdrawalState }, node: { gasPrice: async () => 1n } } });
  // Read with the amount blank, answering late; meanwhile the amount typed, and its call's estimate.
  const loading = reads.load({ evm: "0xowner", gas: {}, route: WITHDRAWAL });
  await settle();
  const typed = { amountWei: 10n ** 18n, duskAccount: "dusk-account" };
  const estimating = reads.estimate({ evm: "0xowner", gas: typed, route: WITHDRAWAL });
  await settle();
  const [blank, exact] = withdrawalState.pending;
  exact.resolve({ estimated: true, gas: 138_439n });
  await estimating;
  blank.resolve({ estimated: false, gas: 140_000n });
  await loading;
  assert.deepEqual(reads.reads.l2, { call: { ...typed, owner: "0xowner" }, estimated: true, gas: 138_439n });
});

test("an older load whose gas price answers late starts no reads of its own, and never leaves the card without the newer load's", async () => {
  const gasPrice = deferred();
  const dispatchFee = deferred();
  const hyperlane = { allowance: async () => 9n, dispatchFee, escrow: async () => [], tokenBalance: async () => 5n };
  const reads = createFormReads({ services: { hyperlane, node: { accountBalance: async () => 0n, gasPrice } } });
  const route = { hyperlane: { native: false, symbol: "EURd" }, mode: "hyperlane", signer: "dusk" };
  const older = reads.load({ dusk: "account", gas: {}, route });
  const newer = reads.load({ dusk: "account", gas: {}, route });
  await settle();
  const [oldPrice, newPrice] = gasPrice.pending;
  // The newer load reads the route; then the older one's gas price comes in.
  newPrice.resolve(1n);
  await settle();
  oldPrice.resolve(2n);
  await settle();
  assert.equal(dispatchFee.pending.length, 1);
  for (const each of dispatchFee.pending) each.resolve(16_876_000_000n);
  await Promise.all([older, newer]);
  assert.deepEqual(reads.reads.hyperlane, { allowance: 9n, fee: 16_876_000_000n, tokenBalance: 5n });
});

test("a load whose gas price answers after a newer estimate started doesn't put back its older quote", async () => {
  const gasPrice = deferred();
  const dispatchFee = deferred();
  const hyperlane = { allowance: async () => 0n, dispatchFee, escrow: async () => [], tokenBalance: async () => 0n };
  const reads = createFormReads({ services: { hyperlane, node: { accountBalance: async () => 0n, gasPrice } } });
  const out = { hyperlane: { native: false, symbol: "EURd" }, mode: "hyperlane", signer: "dusk" };
  const loading = reads.load({ dusk: "account", gas: {}, route: out });
  await settle();
  // The amount is typed while the load still waits for the gas price, and its estimate answers.
  const typed = reads.estimate({ gas: { amount: 5n, dusk: "account", recipient: "0x1" }, route: out });
  await settle();
  dispatchFee.pending[0].resolve(2n);
  await typed;
  // Then the load's gas price comes in, and the route read after it.
  gasPrice.pending[0].resolve(1n);
  await settle();
  for (const each of dispatchFee.pending.slice(1)) each.resolve(1n);
  await loading;
  assert.equal(reads.reads.hyperlane.fee, 2n);
});
