import assert from "node:assert/strict";
import test from "node:test";

import { createDuskNode, parseJsonExact } from "./dusk-node.js";

const NODE = "https://testnet.nodes.example";

/**
 * Answers like Rusk's GraphQL endpoint: the body is the query text itself. A
 * JSON body fails to parse ("expected selection"), as the live node answers.
 */
function ruskLike(answers) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ body: init.body, headers: init.headers, url });
    if (url.endsWith("/on/graphql/query")) {
      const body = String(init.body);
      const match = /^query \{ (.*) \}$/su.exec(body);
      if (!match)
        return new Response(
          JSON.stringify({ data: null, errors: [{ message: " --> 1:2\n  = expected selection" }] }),
        );
      const answer = answers.graphql(match[1]);
      // Text as the node writes it, for numbers JSON.stringify can't keep.
      return new Response(typeof answer === "string" ? answer : JSON.stringify(answer));
    }
    if (url.endsWith("/on/blocks/gas-price"))
      return answers.gasPrice?.() ?? new Response(JSON.stringify({ median: 3 }));
    return answers.contract(url, init);
  };
  return { fetch, requests };
}

test("node queries send the GraphQL text itself, which Rusk parses", async () => {
  const rusk = ruskLike({
    graphql: (selection) => {
      assert.equal(selection, "block(height: -1) { header { height timestamp } }");
      return { block: { header: { height: 4_704_959, timestamp: 1_793_156_989 } } };
    },
  });
  const node = createDuskNode({ fetch: rusk.fetch, url: `${NODE}/` });

  assert.deepEqual({ ...(await node.latestBlock()) }, { height: 4_704_959n, timestamp: 1_793_156_989n });
  assert.equal(rusk.requests[0].url, `${NODE}/on/graphql/query`);
  assert.equal(
    rusk.requests[0].body,
    "query { block(height: -1) { header { height timestamp } } }",
  );
});

test("a node error comes back as the node's message", async () => {
  const node = createDuskNode({
    fetch: async () =>
      new Response(JSON.stringify({ data: null, errors: [{ message: "Unknown field" }] })),
    url: NODE,
  });
  await assert.rejects(node.query("nope"), /Unknown field/u);
});

test("transaction lookups in one tick share one query", async () => {
  const rusk = ruskLike({
    graphql: (selection) => {
      assert.match(selection, /^t0: tx\(hash: "a{64}"\).* t1: tx\(hash: "b{64}"\)/su);
      return {
        t0: {
          blockHeight: 10,
          blockTimestamp: 1_792_980_999,
          err: null,
          id: "a".repeat(64),
          tx: {
            callData: { contractId: "11".repeat(32), data: "00", fnName: "f" },
            json: JSON.stringify({ sender: "S", value: 5 }),
            memo: null,
          },
        },
        t1: null,
      };
    },
  });
  const node = createDuskNode({ fetch: rusk.fetch, url: NODE });

  const [found, missing] = await Promise.all([
    node.transaction("A".repeat(64)),
    node.transaction(`0x${"b".repeat(64)}`),
  ]);

  assert.equal(rusk.requests.length, 1);
  assert.equal(found.blockHeight, 10n);
  assert.equal(found.blockTimestamp, 1_792_980_999n);
  assert.equal(found.callData.fnName, "f");
  assert.equal(found.json.sender, "S");
  assert.equal(missing, null);
  assert.throws(() => node.transaction("not-a-hash"), /invalid/u);
});

test("contract queries post rkyv bytes to the configured node", async () => {
  const rusk = ruskLike({
    contract: async (url, init) => {
      assert.equal(url, `${NODE}/on/contracts:${"ab".repeat(32)}/gameCount`);
      assert.equal(init.headers["content-type"], "application/octet-stream");
      assert.deepEqual([...init.body], [1, 2]);
      return new Response(new Uint8Array([9]));
    },
  });
  const node = createDuskNode({ fetch: rusk.fetch, url: NODE });

  assert.deepEqual([...(await node.contractCall(`0x${"AB".repeat(32)}`, "gameCount", new Uint8Array([1, 2])))], [9]);
});

// Dusk Wallet's own check of a site's gas price (src/ui/notification/app.js
// on dusk-network/wallet main): "This site chose a high fee" from twice the
// price it starts from itself, by app-core's defaultGasPrice.
const walletWarns = (asked, walletPrice) => asked >= walletPrice * 2n;

test("the gas price is the one Dusk Wallet starts from, so its window doesn't call the bridge's fee high", async () => {
  // One transaction waits, at 2,000 Lux: the node's median says 2,000, which
  // the bridge used to ask. The wallet starts from 1 Lux, the network's
  // minimum, while what waits fits in the next block.
  const waiting = (mempoolTxs) =>
    createDuskNode({
      fetch: ruskLike({
        gasPrice: () => new Response(JSON.stringify({ average: 2000, max: 2000, median: 2000, min: 2000 })),
        graphql: (selection) => {
          assert.equal(selection, "mempoolTxs { gasPrice gasLimit }");
          return { mempoolTxs };
        },
      }).fetch,
      url: NODE,
    });
  const quiet = await waiting([{ gasLimit: 2_500_000, gasPrice: 2_000 }]).gasPrice();
  assert.equal(quiet, 1n);
  assert.equal(walletWarns(quiet, 1n), false);
  // What the node's median would have asked: 2,000 times the wallet's price.
  assert.equal(walletWarns(2_000n, 1n), true);
  assert.equal(await waiting([]).gasPrice(), 1n);

  // Once more waits than a block takes, the mempool's median, as the wallet starts from it too, up to 5 times the minimum.
  const full = (gasPrice, count = 1_000) => Array.from({ length: count }, () => ({ gasLimit: 2_500_000, gasPrice }));
  assert.equal(await waiting(full(3)).gasPrice(), 3n);
  assert.equal(await waiting(full(2_000)).gasPrice(), 5n);
  // Or more gas than a block takes (3,000,000,000), however few they are; the two middle prices' mean, rounded down.
  assert.equal(await waiting([{ gasLimit: "2000000000", gasPrice: "2" }, { gasLimit: "2000000000", gasPrice: "5" }]).gasPrice(), 3n);

  // A node that can't say what waits, or none at all: the minimum, as the wallet falls back to.
  assert.equal(await waiting(null).gasPrice(), 1n);
  const down = createDuskNode({
    fetch: async () => {
      throw new Error("offline");
    },
    url: NODE,
  });
  assert.equal(await down.gasPrice(), 1n);
});

test("amounts past 2^53 Lux keep every digit, in transactions and in query answers", async () => {
  // Rusk writes a transfer's value and deposit as bare numbers; its fees as text.
  const inner = '{"type":"moonlight","value":18446744073709551615,"nonce":19,"deposit":9007199254740993,"fee":{"gas_limit":"5000000","gas_price":"1"},"memo":"12345678901234567890"}';
  const rusk = ruskLike({
    graphql: (selection) =>
      selection.startsWith("t0:")
        ? JSON.stringify({ t0: { blockHeight: 10, blockTimestamp: 1_792_980_999, err: null, gasSpent: 1_986_533, id: "a".repeat(64), tx: { json: inner } } })
        : '{"h":{"json":[{"block_height":4688278,"events":[{"topic":"moonlight","data":{"value":12345678901234567891,"memo":"0x"}}]}]}}',
  });
  const node = createDuskNode({ fetch: rusk.fetch, url: NODE });

  const tx = await node.transaction("a".repeat(64));
  assert.equal(BigInt(tx.json.value), 18_446_744_073_709_551_615n);
  assert.equal(BigInt(tx.json.deposit), 9_007_199_254_740_993n);
  assert.equal(tx.json.nonce, 19);
  assert.equal(tx.json.memo, "12345678901234567890");
  assert.equal(tx.gasSpent, 1_986_533);

  const history = await node.query("h: moonlightHistory(sender: \"x\", fromBlock: 0) { json }");
  assert.equal(BigInt(history.h.json[0].events[0].data.value), 12_345_678_901_234_567_891n);
  assert.equal(history.h.json[0].block_height, 4_688_278);

  // Only whole numbers that can pass 2^53 change; text, decimals and exponents stay.
  assert.deepEqual(parseJsonExact('{"s":"12345678901234567890 \\" 1","d":0.12345678901234567890,"e":1.5e300,"n":-12345678901234567890,"k":[9007199254740991]}'), {
    d: 0.12345678901234568,
    e: 1.5e300,
    k: [9_007_199_254_740_991],
    n: "-12345678901234567890",
    s: '12345678901234567890 " 1',
  });
});

test("a public balance is read from the node as Lux, without losing digits", async () => {
  const calls = [];
  const node = createDuskNode({
    fetch: async (url, init) => {
      calls.push([url, init.method]);
      return new Response('{"balance":18446744073709551615,"next_nonce":19,"nonce":18}');
    },
    url: "https://node.example",
  });
  const account = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
  assert.equal(await node.accountBalance(account), 18_446_744_073_709_551_615n);
  assert.deepEqual(calls, [[`https://node.example/on/account:${account}/status`, "POST"]]);
  await assert.rejects(node.accountBalance("not base58 0OIl"), /base58/u);
});
