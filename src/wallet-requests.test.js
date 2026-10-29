import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "viem";

// The testnet profile, with DuskEVM configured, before the modules read it.
globalThis.__DUSK_BRIDGE_CONFIG__ = {
  VITE_BRIDGE_PROFILE: "testnet",
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "33".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "11".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "22".repeat(32),
};
const { config } = await import("./config.js");
const { networks } = await import("@dusk-network/networks");
const { sendDuskContractCall, sendDuskTransfer, useDuskWallet } = await import("./dusk-wallet.js");
const { serviceTransferRequest } = await import("./service-transfer.js");
const { decodeDepositArgs, depositRequest } = await import("./dusk-deposit.js");
const { fromHex } = await import("./data-driver.js");

// What the review prepares and then sends, as the account it was reviewed for.
const submitServiceTransfer = async ({ account, ...options }) => sendDuskTransfer(await serviceTransferRequest(options), { account });
const submitDuskEvmDeposit = async ({ account, ...options }) => sendDuskContractCall(await depositRequest(options), { account });

/** A Dusk Connect wallet stand-in that records what the bridge sends. */
function fakeWallet() {
  const sent = [];
  return {
    async connect() {},
    async refresh() {},
    async sendContractCall(params) {
      sent.push({ kind: "contract_call", params });
      return { hash: "c".repeat(64) };
    },
    async sendTransfer(params) {
      sent.push({ kind: "transfer", params });
      return { hash: "d".repeat(64) };
    },
    sent,
    state: {
      authorized: true,
      chainId: "dusk:2",
      selectedProfile: { account: "21n5ncyu" },
    },
    async switchChain() {},
  };
}

const node = { gasPrice: async () => 1n };
// Typed in lower case; the wallet must get the same address, checksummed.
const TYPED = "0xf49ea944fd8a6bde7358a61ac1004fbaa9321aec";

test("a Dusk → Sepolia transfer memos the typed destination to the bridge account", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await submitServiceTransfer({
    amountLux: 2_000_000_000n,
    destination: `  ${TYPED} `,
  });

  assert.equal(wallet.sent.length, 1);
  const [{ kind, params }] = wallet.sent;
  assert.equal(kind, "transfer");
  assert.equal(params.memo, getAddress(TYPED));
  assert.equal(params.to, config.service.account);
  // The Sepolia bridge account, as the network's file names it.
  assert.equal(params.to, networks.testnet.routes.services[0].account);
  assert.equal(params.amount, "2000000000");
  assert.equal(params.privacy, "public");
});

test("a transfer at or under the bridge fee isn't sent", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await assert.rejects(
    submitServiceTransfer({ amountLux: 1_000_000_000n, destination: TYPED }),
    /must exceed the 1 DUSK bridge fee/u,
  );
  await assert.rejects(
    submitServiceTransfer({ amountLux: 2_000_000_000n, destination: "0x1234" }),
    /valid 20-byte EVM address/u,
  );
  assert.equal(wallet.sent.length, 0);
});

test("a DuskEVM deposit carries the typed recipient, its own gas and a label", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await submitDuskEvmDeposit({ amountLux: 100_000_000n, node, recipient: TYPED });

  const [{ kind, params }] = wallet.sent;
  assert.equal(kind, "contract_call");
  assert.equal(params.contractId, `0x${"11".repeat(32)}`);
  assert.equal(params.fnName, "depositETHToWithValue");
  assert.equal(params.deposit, "100000000");
  assert.equal(params.privacy, "public");
  // 5M gas at the node's price, not the wallet's 500M contract-call default.
  assert.deepEqual(params.gas, { limit: "5000000", price: "1" });
  const args = decodeDepositArgs(fromHex(params.fnArgs));
  assert.equal(args.to, getAddress(TYPED));
  assert.equal(args.amountLux, 100_000_000n);
  assert.deepEqual(params.display, {
    label: "Bridge 0.1 DUSK to DuskEVM",
    recipient: getAddress(TYPED),
  });
});

test("with the node, a Dusk → Sepolia transfer carries the gas the quote shows", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await submitServiceTransfer({ amountLux: 2_000_000_000n, destination: TYPED, node });

  const [{ params }] = wallet.sent;
  assert.deepEqual(params.gas, { limit: "2500000", price: "1" });
  assert.equal(params.memo, getAddress(TYPED));
});

test("a deposit or transfer is priced at the gas price its page quoted, not at one read again", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);
  const moved = { gasPrice: async () => 2n };

  await submitDuskEvmDeposit({ amountLux: 100_000_000n, gasPrice: 1n, node: moved, recipient: TYPED });
  await submitServiceTransfer({ amountLux: 2_000_000_000n, destination: TYPED, gasPrice: 1n, node: moved });

  assert.deepEqual(wallet.sent.map(({ params }) => params.gas), [
    { limit: "5000000", price: "1" },
    { limit: "2500000", price: "1" },
  ]);
});

test("a deposit or transfer reviewed for one Dusk account isn't sent as another", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);
  const other = { account: "21n5ncOther" };
  await assert.rejects(submitDuskEvmDeposit({ ...other, amountLux: 100_000_000n, node, recipient: TYPED }), { code: "DUSK_ACCOUNT_CHANGED" });
  await assert.rejects(submitServiceTransfer({ ...other, amountLux: 2_000_000_000n, destination: TYPED, node }), { code: "DUSK_ACCOUNT_CHANGED" });
  assert.equal(wallet.sent.length, 0);
  await submitServiceTransfer({ account: "21n5ncyu", amountLux: 2_000_000_000n, destination: TYPED, node });
  assert.equal(wallet.sent.length, 1);
});
