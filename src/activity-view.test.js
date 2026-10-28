import assert from "node:assert/strict";
import test from "node:test";

import { activityView, explorerTxUrl, friendlyWalletError, renderActivityItem } from "./activity-view.js";
import { WITHDRAWAL_GAS_REFUSAL } from "./gas.js";

const cfg = {
  dusk: { explorerUrl: "https://apps.testnet.dusk.network/explorer/" },
  duskEvm: { explorerUrl: "https://explorer.testnet.evm.dusk.network" },
  evmNetworks: { ethereum: { explorerUrl: "https://sepolia.etherscan.io" } },
};
const deposit = {
  from: { id: "dusk", kind: "dusk", label: "Dusk Testnet" },
  id: "dusk-to-dusk-evm",
  mode: "duskevm-deposit",
  to: { id: "dusk-evm", kind: "evm", label: "DuskEVM Testnet" },
};
const withdrawal = {
  from: { id: "dusk-evm", kind: "evm", label: "DuskEVM Testnet" },
  id: "dusk-evm-to-dusk",
  mode: "duskevm-withdrawal",
  to: { id: "dusk", kind: "dusk", label: "Dusk Testnet" },
};
const DUSK_HASH = "ce".repeat(32);
const L2_HASH = `0x${"34".repeat(32)}`;

test("explorer links point at each network's own explorer", () => {
  assert.equal(
    explorerTxUrl(cfg, "dusk", `0x${DUSK_HASH}`),
    `https://apps.testnet.dusk.network/explorer/transactions/transaction?id=${DUSK_HASH}`,
  );
  assert.equal(explorerTxUrl(cfg, "dusk-evm", "34".repeat(32)), `https://explorer.testnet.evm.dusk.network/tx/${L2_HASH}`);
  assert.equal(explorerTxUrl(cfg, "ethereum", L2_HASH), `https://sepolia.etherscan.io/tx/${L2_HASH}`);
});

test("a deposit shows Pending, then Completed with links on both sides", () => {
  const pending = activityView(
    { amountLux: "100000000", hash: DUSK_HASH, note: "Waiting for DuskEVM Testnet.", status: "pending" },
    { cfg, route: deposit },
  );
  assert.equal(pending.status, "Pending");
  assert.equal(pending.amount, "0.1 DUSK");
  assert.equal(pending.title, "Dusk Testnet → DuskEVM Testnet");
  assert.deepEqual(pending.links.map(({ label }) => label), ["Dusk Testnet transaction"]);

  const done = activityView(
    { amountLux: "100000000", destinationHash: L2_HASH, hash: DUSK_HASH, status: "completed" },
    { cfg, route: deposit },
  );
  assert.equal(done.status, "Completed");
  assert.deepEqual(
    done.links.map(({ href }) => href),
    [
      `https://apps.testnet.dusk.network/explorer/transactions/transaction?id=${DUSK_HASH}`,
      `https://explorer.testnet.evm.dusk.network/tx/${L2_HASH}`,
    ],
  );
  assert.equal(activityView({ hash: DUSK_HASH, status: "failed" }, { cfg, route: deposit }).status, "Failed");
});

test("a withdrawal shows its three steps, their times and the next action", () => {
  const sentAt = Date.UTC(2026, 9, 26, 2, 17);
  const ready = activityView(
    { hash: L2_HASH, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" },
    { cfg, route: withdrawal },
  );
  assert.deepEqual(ready.steps.map(({ label }) => label), [
    "Sent on DuskEVM Testnet",
    "Proved on Dusk Testnet",
    "Claimed on Dusk Testnet",
  ]);
  assert.deepEqual(ready.steps.map(({ done }) => done), [true, false, false]);
  assert.match(ready.steps[0].detail, /Oct/u);
  assert.match(ready.steps[0].detail, /26/u);
  assert.equal(ready.steps[1].detail, "Ready. Step 1 of 2. Fee from your public account.");
  assert.equal(ready.steps[2].detail, "About 7 days after the proof");
  assert.deepEqual(ready.action, { failure: "", kind: "prove", label: "Prove on Dusk" });

  const now = Date.UTC(2026, 9, 27);
  const waiting = activityView(
    {
      hash: L2_HASH,
      proveHash: DUSK_HASH,
      provenAt: Date.UTC(2026, 9, 26, 3),
      readyAt: Date.UTC(2026, 10, 2, 14, 5) / 1_000,
      readyAtExact: true,
      sourceAt: sentAt,
      stage: "proven_waiting",
      status: "pending",
    },
    { cfg, now, route: withdrawal },
  );
  assert.deepEqual(waiting.steps.map(({ done }) => done), [true, true, false]);
  assert.match(waiting.steps[2].detail, /^Claim from (2 Nov|Nov 2)/u);
  assert.equal(waiting.steps[1].href, `https://apps.testnet.dusk.network/explorer/transactions/transaction?id=${DUSK_HASH}`);
  assert.equal(waiting.action, null);

  const ownProof = activityView(
    { hash: L2_HASH, proveAt: Date.UTC(2026, 9, 26, 3, 20), proveHash: DUSK_HASH, stage: "proven_waiting", status: "pending" },
    { cfg, now, route: withdrawal },
  );
  assert.match(ownProof.steps[1].detail, /Oct/u);
  assert.equal(ownProof.steps[1].done, true);

  const estimate = activityView(
    { hash: L2_HASH, readyAt: (now + 3 * 86_400_000) / 1_000, stage: "proven_waiting", status: "pending" },
    { cfg, now, route: withdrawal },
  );
  assert.equal(estimate.steps[2].detail, "Claim in about 3 days.");

  const rejected = activityView(
    { hash: L2_HASH, proofRejected: true, stage: "proven_waiting", status: "pending" },
    { cfg, now, route: withdrawal },
  );
  assert.equal(rejected.steps[2].detail, "The proof was rejected. Prove again once DuskEVM reports a new output.");

  const refused = activityView(
    { actionError: WITHDRAWAL_GAS_REFUSAL, hash: L2_HASH, stage: "ready_to_finalize", status: "pending" },
    { cfg, route: withdrawal },
  );
  assert.equal(refused.action.label, "Claim on Dusk");
  assert.equal(refused.action.failure, WITHDRAWAL_GAS_REFUSAL);

  const html = renderActivityItem({ id: "w", status: "pending" }, ready);
  assert.match(html, /data-action="withdrawal-prove" data-id="w"/u);
  assert.match(html, /Sent on DuskEVM Testnet/u);
});

test("wallet errors name the wallet that raised them", () => {
  assert.equal(friendlyWalletError({ code: 4001 }), "The wallet request was cancelled.");
  // viem wraps an EVM wallet's rejection in its own error.
  assert.equal(
    friendlyWalletError({ cause: { code: 4001 }, shortMessage: "User rejected the request." }, "evm"),
    "The wallet request was cancelled.",
  );
  assert.match(friendlyWalletError({ code: 4100, message: "Wallet locked" }), /^The Dusk wallet is locked/u);
  assert.match(friendlyWalletError({ code: 4100 }, "evm"), /^The EVM wallet is locked/u);
  assert.match(friendlyWalletError({ code: 4900 }, "evm"), /^The EVM wallet disconnected/u);
});
