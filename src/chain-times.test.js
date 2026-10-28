import assert from "node:assert/strict";
import test from "node:test";

import { createChainTimes, readDepositLag } from "./chain-times.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("a deposit's lag is DuskEVM's latest block against Dusk's own time for the block it took in", async () => {
  const asked = [];
  const lag = await readDepositLag({
    // The L1Block predeploy, as DuskEVM's network file lists it.
    l1Block: "0x4200000000000000000000000000000000000015",
    node: {
      async query(selection) {
        asked.push(selection);
        // Dusk's time for block 4,698,838; DuskEVM's L1Block keeps one 126 s behind it.
        return { block: { header: { timestamp: 1_793_095_779 } } };
      },
    },
    rpcBatch: async (network, calls) => {
      assert.equal(network, "dusk-evm");
      assert.deepEqual(calls.map((call) => call.method), ["eth_getBlockByNumber", "eth_call"]);
      assert.deepEqual(calls[1].params[0], { data: "0x8381f58a", to: "0x4200000000000000000000000000000000000015" });
      return [{ timestamp: `0x${(1_793_095_813).toString(16)}` }, `0x${(4_698_838).toString(16).padStart(64, "0")}`];
    },
  });
  assert.equal(lag, 34);
  assert.deepEqual(asked, ["block(height: 4698838) { header { timestamp } }"]);
  // An answer without the block DuskEVM is on is no lag at all.
  await assert.rejects(readDepositLag({ node: { query: async () => ({}) }, rpcBatch: async () => [{ timestamp: "0x1" }, "0x"] }));
});

test("the chains' times are read at most every 10 minutes, kept a day, and kept per network", async () => {
  let now = Date.UTC(2026, 9, 27, 10);
  const storage = memoryStorage();
  const reads = { deposit: 0, withdrawal: 0 };
  let lag = 35;
  const read = {
    deposit: async () => {
      reads.deposit += 1;
      return lag;
    },
    withdrawal: async () => {
      reads.withdrawal += 1;
      return { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 };
    },
  };
  const times = createChainTimes({ key: "times:testnet", now: () => now, read, storage });
  assert.equal(times.get(), null);
  assert.equal(await times.refresh(), true);
  assert.deepEqual(times.get().deposit, { at: now, lagSeconds: 35 });
  assert.equal(times.get().withdrawal.outputSeconds, 1_700);
  // Asked again within 10 minutes: nothing is read, nothing moved.
  now += 5 * 60_000;
  assert.equal(await times.refresh(), false);
  assert.deepEqual(reads, { deposit: 1, withdrawal: 1 });
  // Later, both again; one that fails keeps what was read before.
  now += 10 * 60_000;
  lag = 40;
  read.withdrawal = async () => {
    throw new Error("node down");
  };
  assert.equal(await times.refresh(), true);
  assert.equal(times.get().deposit.lagSeconds, 40);
  assert.equal(times.get().withdrawal.maturitySeconds, 604_800);
  // The next visit shows what was read at once, for this network only, and not past a day.
  const again = createChainTimes({ key: "times:testnet", now: () => now, read, storage });
  assert.equal(again.get().deposit.lagSeconds, 40);
  assert.equal(createChainTimes({ key: "times:mainnet", now: () => now, read, storage }).get(), null);
  now += 86_400_000;
  assert.equal(again.get(), null);
});
