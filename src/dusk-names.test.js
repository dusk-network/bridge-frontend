import assert from "node:assert/strict";
import test from "node:test";

import { createDuskNames } from "./dusk-names.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

test("the connected account's verified primary name is read through the lens, once", async () => {
  const reads = [];
  let fail = true;
  const names = createDuskNames({
    chainId: "dusk:2",
    load: async () => ({
      createLensReader: async (release, options) => {
        assert.equal(release.chainId, "dusk:2");
        assert.equal(options.nodeUrl, "https://node.example");
        return {
          verifyPrimary: async (endpoint) => {
            reads.push(endpoint.length);
            if (fail) throw Object.assign(new Error("read"), { reason: "read" });
            return { primary: { spelling: "wallet-both.dusk" } };
          },
        };
      },
      releases: { testnet: { artifactBaseUrl: "https://example/", chainId: "dusk:2" } },
    }),
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
  const releases = { testnet: { artifactBaseUrl: "https://example/", chainId: "dusk:2" } };
  const none = createDuskNames({ chainId: "dusk:9", load: async () => ({ createLensReader: async () => assert.fail(), releases }), nodeUrl: "x" });
  assert.equal(await none.primaryName(ACCOUNT), "");
});
