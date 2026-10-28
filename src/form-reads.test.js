import assert from "node:assert/strict";
import test from "node:test";

import { createFormReads } from "./form-reads.js";

const DEPOSIT = { mode: "duskevm-deposit", signer: "dusk" };
const MIGRATION = { from: { id: "ethereum" }, mode: "migration", signer: "evm" };

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
