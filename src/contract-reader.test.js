import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { contractFacade, createContractReader } from "./contract-reader.js";
import { driverJson, fromHex, loadDataDriver, toHex } from "./data-driver.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A data driver whose "rkyv" is JSON text, enough to follow the bytes. */
const jsonDriver = {
  decodeOutputFn: (_fn, bytes) => JSON.parse(decoder.decode(bytes)),
  encodeInputFn: (fn, json) => encoder.encode(`${fn}:${json}`),
};
const contract = (id) => ({ driver: async () => jsonDriver, id });
const PORTAL = contract("aa".repeat(32));
const FACTORY = contract("bb".repeat(32));
const MULTICALL = contract("93".repeat(32));

/** A node that answers direct reads and Multicall `aggregate` queries. */
function fakeNode(answer, { aggregateFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async contractCall(id, fnName, bytes) {
      calls.push({ fnName, id });
      if (id === MULTICALL.id) {
        if (aggregateFails) throw new Error("HTTP 500");
        const [, json] = decoder.decode(bytes).split(/:(.*)/su);
        const results = JSON.parse(json).map((call) => {
          const [fn] = decoder.decode(fromHex(call.fn_args)).split(":");
          const value = answer(call.contract, fn);
          return value instanceof Error
            ? { Err: { Panic: value.message } }
            : { Ok: toHex(encoder.encode(JSON.stringify(value))) };
        });
        return encoder.encode(JSON.stringify({ height: "7", results }));
      }
      const [fn] = decoder.decode(bytes).split(":");
      const value = answer(id, fn);
      if (value instanceof Error) throw value;
      return encoder.encode(JSON.stringify(value));
    },
  };
}

const answers = (id, fn) =>
  ({
    [`${PORTAL.id}:finalizedWithdrawals`]: false,
    [`${PORTAL.id}:checkWithdrawal`]: new Error("OptimismPortal2: withdrawal not proven"),
    [`${PORTAL.id}:respectedGameType`]: 8,
    [`${FACTORY.id}:gameCount`]: [0, 15, 9],
  })[`${id}:${fn}`];

test("reads made together go to the node as one multicall", async () => {
  const node = fakeNode(answers);
  const reader = createContractReader({ multicall: MULTICALL, node });
  const portal = contractFacade(reader, PORTAL);
  const factory = contractFacade(reader, FACTORY);

  const [finalized, gameType, count, check] = await Promise.all([
    portal.call.finalizedWithdrawals([1]),
    portal.call.respectedGameType(),
    factory.call.gameCount(),
    portal.call.checkWithdrawal([[1], [2]]).catch((error) => error.message),
  ]);

  assert.deepEqual(node.calls, [{ fnName: "aggregate", id: MULTICALL.id }]);
  assert.equal(finalized, false);
  assert.equal(gameType, 8);
  assert.deepEqual(count, [0, 15, 9]);
  // A call that panics fails alone, with the contract's own message.
  assert.equal(check, "OptimismPortal2: withdrawal not proven");
});

test("a lone read goes through the multicall too, so a panic is an answer, not an HTTP error", async () => {
  const node = fakeNode(answers);
  const reader = createContractReader({ multicall: MULTICALL, node });
  const portal = contractFacade(reader, PORTAL);

  assert.equal(await portal.call.respectedGameType(), 8);
  assert.deepEqual(node.calls, [{ fnName: "aggregate", id: MULTICALL.id }]);
  await assert.rejects(portal.call.checkWithdrawal([[1], [2]]), /^Error: OptimismPortal2: withdrawal not proven$/u);
  assert.deepEqual(node.calls.map(({ fnName }) => fnName), ["aggregate", "aggregate"]);
});

test("reads fall back to one query each when the multicall fails", async () => {
  const node = fakeNode(answers, { aggregateFails: true });
  const reader = createContractReader({ multicall: MULTICALL, node });
  const portal = contractFacade(reader, PORTAL);

  const values = await Promise.all([
    portal.call.respectedGameType(),
    portal.call.finalizedWithdrawals([1]),
  ]);

  assert.deepEqual(values, [8, false]);
  assert.deepEqual(
    node.calls.map(({ fnName }) => fnName),
    ["aggregate", "respectedGameType", "finalizedWithdrawals"],
  );
});

test("without a multicall every read is its own query", async () => {
  const node = fakeNode(answers);
  const reader = createContractReader({ multicall: null, node });
  const portal = contractFacade(reader, PORTAL);

  await Promise.all([portal.call.respectedGameType(), portal.call.finalizedWithdrawals([1])]);
  assert.equal(node.calls.length, 2);
});

test("the multicall driver accepts the envelope the reader builds", async () => {
  const driver = await loadDataDriver(
    await readFile(new URL("../public/drivers/dusk_multicall_driver.wasm", import.meta.url)),
  );
  const calls = [
    { contract: "14".repeat(32), fn_args: "0707", fn_name: "finalizedWithdrawals", gas_limit: "0" },
    { contract: "3b".repeat(32), fn_args: "", fn_name: "gameCount", gas_limit: "0" },
  ];
  const envelope = driver.encodeInputFn("aggregate", driverJson(calls));

  assert.deepEqual(driver.decodeInputFn("aggregate", envelope), calls);
});
