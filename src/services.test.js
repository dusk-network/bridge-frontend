import assert from "node:assert/strict";
import test from "node:test";

import { createRpcBatch } from "./services.js";

test("a batch keeps a call that wasn't answered apart from one that found nothing", async () => {
  const bodies = [];
  const rpcBatch = createRpcBatch({ ethereum: "https://rpc.example" }, async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify([
        { id: 0, jsonrpc: "2.0", result: null },
        { error: { code: -32005, message: "limit exceeded" }, id: 1, jsonrpc: "2.0" },
        { id: 2, jsonrpc: "2.0", result: { to: "0x01" } },
      ]),
    );
  });
  const results = await rpcBatch("ethereum", [
    { method: "eth_getTransactionByHash", params: ["0xaa"] },
    { method: "eth_getTransactionByHash", params: ["0xbb"] },
    { method: "eth_getTransactionByHash", params: ["0xcc"] },
    { method: "eth_getTransactionByHash", params: ["0xdd"] },
  ]);
  // Not found is null; an error, or no answer at all, is undefined.
  assert.deepEqual(results, [null, undefined, { to: "0x01" }, undefined]);
  assert.equal(bodies[0].length, 4);
});
