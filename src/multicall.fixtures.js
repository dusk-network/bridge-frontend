// A node that answers Multicall for Dusk's `aggregate` as the contract does,
// for the tests that count which reads go to the node together: each query's
// calls are read from its envelope, and their answers written into a reply as
// rkyv 0.7 writes it (as @hdauven/dusk-multicall's own tests do). Not a test
// itself; only the tests import it.

import { MULTICALL_CONTRACT_ID, createMulticallFetch } from "@hdauven/dusk-multicall";

import { MAX_BATCH } from "./contract-reader.js";
import { createDuskNode } from "./dusk-node.js";

const NODE = "https://node.example";
const utf8 = new TextEncoder();
const text = new TextDecoder();
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const align = (n, to) => Math.ceil(n / to) * to;

/** The calls in an `aggregate` envelope: each one's contract, function and argument. */
function aggregateCalls(body) {
  const u8 = new Uint8Array(body);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const root = u8.length - 8;
  const array = root + view.getInt32(root, true);
  return Array.from({ length: view.getUint32(root + 4, true) }, (_, index) => {
    const slot = array + 56 * index;
    const inline = u8[slot + 39] <= 7;
    const name = inline ? slot + 32 : slot + 32 + view.getInt32(slot + 36, true);
    const length = inline ? u8[slot + 39] : view.getUint32(slot + 32, true);
    const args = slot + 40 + view.getInt32(slot + 40, true);
    return {
      args: u8.slice(args, args + view.getUint32(slot + 44, true)),
      contract: hex(u8.subarray(slot, slot + 32)),
      fnName: text.decode(u8.subarray(name, name + length)),
    };
  });
}

/**
 * An `aggregate` reply: the bytes of each answer and of each panic message
 * too long to sit inline, in call order, then one 16-byte slot per result,
 * then the root.
 */
function aggregateReply(results, height = 7n) {
  const outOfLine = results.map((result) => {
    if (result.Ok) return result.Ok;
    const message = utf8.encode(result.Err.Panic);
    return message.length > 7 ? message : null;
  });
  const slots = align(outOfLine.reduce((n, bytes) => n + (bytes?.length ?? 0), 0), 4);
  const root = align(slots + 16 * results.length, 8);
  const out = new Uint8Array(root + 16);
  const view = new DataView(out.buffer);
  let at = 0;
  results.forEach((result, index) => {
    const slot = slots + 16 * index;
    const extra = outOfLine[index];
    if (extra) out.set(extra, at);
    if (result.Ok) {
      view.setInt32(slot + 4, at - (slot + 4), true);
      view.setUint32(slot + 8, result.Ok.length, true);
    } else {
      out[slot] = 1;
      const message = utf8.encode(result.Err.Panic);
      if (extra) {
        view.setUint32(slot + 8, message.length, true);
        view.setInt32(slot + 12, at - (slot + 8), true);
      } else {
        out.set(message, slot + 8);
        out[slot + 15] = message.length;
      }
    }
    at += extra?.length ?? 0;
  });
  view.setBigUint64(root, height, true);
  view.setInt32(root + 8, slots - (root + 8), true);
  view.setUint32(root + 12, results.length, true);
  return out;
}

/**
 * The bridge's Dusk node, batching through Multicall for Dusk as the page
 * does, in front of a node that answers each read with `answer({ contract,
 * fnName, args })`: its reply's bytes, or `{ Panic }` for a call that
 * panics. `queries` keeps the functions of each query the node got, a read
 * sent alone as a query of one.
 */
export function batchingNode(answer) {
  const queries = [];
  const settle = (call) => {
    const value = answer(call);
    return value?.Panic ? { Err: value } : { Ok: value };
  };
  const fetch = async (url, init) => {
    const [, contract, fnName] = /\/on\/contracts:([0-9a-f]{64})\/(\w+)$/u.exec(String(url)) ?? [];
    if (!contract) return new Response("Not found", { status: 404 });
    if (contract === MULTICALL_CONTRACT_ID && fnName === "aggregate") {
      const calls = aggregateCalls(init.body);
      queries.push(calls.map((call) => call.fnName));
      return new Response(aggregateReply(calls.map(settle)));
    }
    queries.push([fnName]);
    const result = settle({ args: new Uint8Array(init.body), contract, fnName });
    return result.Ok ? new Response(result.Ok) : new Response(result.Err.Panic, { status: 500 });
  };
  const node = createDuskNode({ fetch: createMulticallFetch({ fetch, maxBatch: MAX_BATCH, multicallId: MULTICALL_CONTRACT_ID, nodeUrl: NODE }), url: NODE });
  return { node, queries };
}
