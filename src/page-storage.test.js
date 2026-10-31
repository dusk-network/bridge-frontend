import assert from "node:assert/strict";
import test from "node:test";

// The browser denies this page Web Storage: reading `localStorage` itself
// throws, as in Chrome with site data blocked.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  get() {
    throw new DOMException("Failed to read the 'localStorage' property from 'Window': Access is denied for this document.", "SecurityError");
  },
});
globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const { config } = await import("./config.js");
const { entryId, readActivity, recordActivity, updateActivity, useActivityNetwork } = await import("./activity.js");
const { createChainTimes } = await import("./chain-times.js");
const { createDuskConnection } = await import("./dusk-wallet.js");
const { createServices } = await import("./services.js");
const { readWatched, saveWatched } = await import("./watched-account.js");

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const EVM = "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d";

// DuskEVM's RPC, with no withdrawals: which block windows My transfers reads.
const HEAD = 3_905_000;
const windows = [];
globalThis.fetch = async (_url, { body }) => {
  const { id, method, params } = JSON.parse(body);
  if (method === "eth_getLogs") windows.push([Number(params[0].fromBlock), Number(params[0].toBlock)]);
  return Response.json({ id, jsonrpc: "2.0", result: method === "eth_getBlockByNumber" ? { number: `0x${HEAD.toString(16)}` } : [] });
};

test("where the browser denies Web Storage, the page still starts, and Dusk Wallet can connect", async () => {
  const services = createServices(config);
  useActivityNetwork(config.profile);
  assert.deepEqual(readActivity(), []);
  assert.equal(readWatched(config.profile), null);
  assert.equal(typeof services.discovery.discover, "function");
  assert.equal(typeof (await createDuskConnection()).connect, "function");
});

test("without Web Storage, what the visit sends, follows and reads is kept until it ends", async () => {
  useActivityNetwork(config.profile);
  recordActivity({ hash: `0x${"ab".repeat(32)}`, routeId: "dusk-to-dusk-evm" });
  recordActivity({ hash: `0x${"cd".repeat(32)}`, routeId: "dusk-evm-to-dusk" });
  updateActivity(entryId("dusk-to-dusk-evm", `0x${"ab".repeat(32)}`), { status: "completed" });
  assert.deepEqual(readActivity().map((entry) => [entry.routeId, entry.status]).sort(), [["dusk-evm-to-dusk", "pending"], ["dusk-to-dusk-evm", "completed"]]);

  saveWatched(config.profile, { account: ACCOUNT, name: "alice.dusk" });
  assert.deepEqual(readWatched(config.profile), { account: ACCOUNT, name: "alice.dusk" });

  // My transfers carries on where it stopped, a window further down, rather than starting over.
  const { discovery } = createServices(config);
  await discovery.discover({ evm: EVM, evmRequests: 2 });
  await discovery.discover({ evm: EVM, evmRequests: 2 });
  assert.deepEqual(windows, [[HEAD - 100_000 + 1, HEAD], [HEAD - 200_000 + 1, HEAD - 100_000]]);

  // The chains' times, once read, show at once on the next page.
  const read = { deposit: async () => 35, withdrawal: async () => ({ maturitySeconds: 604_800 }) };
  await createChainTimes({ key: "times", read }).refresh();
  assert.equal(createChainTimes({ key: "times", read }).get()?.deposit.lagSeconds, 35);
});
