import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase58 } from "@dusk-network/networks/account";
import { resolveAccounts } from "@duskdomains/sdk/accounts";
import { releaseFor } from "@duskdomains/sdk/releases";

import { createDuskNames } from "./dusk-names.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const ACCOUNT_BYTES = decodeBase58(ACCOUNT);

test("the connected account's verified primary name is read through the lens, once", async () => {
  const reads = [];
  let fail = true;
  const names = createDuskNames({
    chainId: "dusk:2",
    load: async () => ({
      createLensReader: async (release, options) => {
        // Testnet's pinned release, its lens driver from its own site.
        assert.equal(release, releaseFor("dusk:2"));
        assert.equal(options.artifactBaseUrl, "https://testnet.dusk.domains/");
        assert.equal(options.nodeUrl, "https://node.example");
        return {
          verifyPrimary: async (endpoint) => {
            reads.push(endpoint.length);
            if (fail) throw Object.assign(new Error("read"), { reason: "read" });
            return { primary: { spelling: "wallet-both.dusk" } };
          },
        };
      },
      releaseFor,
    }),
    // The check of a name's account isn't needed for a primary name.
    loadAccounts: async () => assert.fail("loaded the account check"),
    nodeUrl: "https://node.example",
  });
  // A failed read isn't kept: the next lookup reads again.
  await assert.rejects(names.primaryName(ACCOUNT));
  fail = false;
  assert.equal(await names.primaryName(ACCOUNT), "wallet-both.dusk");
  assert.equal(await names.primaryName(ACCOUNT), "wallet-both.dusk");
  assert.deepEqual(reads, [96, 96]);
  assert.equal(await names.primaryName("not an account"), "");

  // A network without a Dusk Domains release has no names to read.
  const none = createDuskNames({ chainId: "dusk:9", load: async () => ({ createLensReader: async () => assert.fail(), releaseFor }), nodeUrl: "x" });
  assert.equal(await none.primaryName(ACCOUNT), "");
});

test("a .dusk name's public account is read through the lens, checked as a key, and kept a minute", async () => {
  const asked = [];
  let fail = true;
  // What each name's records hold: carol.dusk's isn't a valid key.
  const records = { "alice.dusk": [...ACCOUNT_BYTES], "carol.dusk": Array(96).fill(0xff) };
  const names = createDuskNames({
    chainId: "dusk:2",
    load: async () => ({
      createLensReader: async () => ({
        resolve: async (name, keys) => {
          asked.push(name);
          if (fail) throw Object.assign(new Error("read"), { reason: "read" });
          const value = records[name];
          return value
            ? { height: 7n, records: keys.map((k) => (k === "moonlight_address" ? { key: k, value } : null)), status: "Active" }
            : { height: 7n, records: keys.map(() => null), status: "Expired" };
        },
      }),
      releaseFor,
    }),
    loadAccounts: async () => ({ resolveAccounts }),
    nodeUrl: "https://node.example",
  });
  await assert.rejects(names.resolveName("Alice.dusk", { now: 0 }));
  fail = false;
  assert.deepEqual(await names.resolveName("Alice.dusk", { now: 1 }), { account: ACCOUNT });
  assert.deepEqual(await names.resolveName("alice.dusk", { now: 59_000 }), { account: ACCOUNT });
  assert.deepEqual(await names.resolveName("bob.dusk", { now: 2 }), { status: "Expired" });
  // An active name whose record isn't a valid key names no account.
  assert.deepEqual(await names.resolveName("carol.dusk", { now: 3 }), { status: "Active" });
  assert.deepEqual(asked, ["alice.dusk", "alice.dusk", "bob.dusk", "carol.dusk"]);
  // A minute on, the name is read again: it may point elsewhere by now.
  await names.resolveName("alice.dusk", { now: 61_001 });
  assert.equal(asked.length, 5);
});
