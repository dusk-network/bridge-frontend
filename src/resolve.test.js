import assert from "node:assert/strict";
import test from "node:test";

import { networks } from "@dusk-network/networks";
import { decodeBase58 } from "@dusk-network/networks/account";
import { encodeDuskExternalAssetRecipient } from "@dusk/evm-sdk";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi } from "viem";

import { loadConfig } from "./config.js";
import { resolveTransfer } from "./resolve.js";
import { hashWithdrawal } from "./withdrawals.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = {
  VITE_BRIDGE_PROFILE: "testnet",
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "3b7d562aa0e6b94ce29c5ce2a6f0587ad771afdace86abb0baf66f93e49548cd",
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d",
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "14eeb3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9",
};
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;

const ABI = parseAbi([
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
  "function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message)",
  "function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes _extraData)",
  "function finalizeBridgeERC20(address _localToken, address _remoteToken, address _from, address _to, uint256 _amount, bytes _extraData)",
]);
const MESSENGER = "0x4200000000000000000000000000000000000007";
// Dusk's messenger and bridge, as DuskEVM testnet's withdrawals reach them.
const { l1_cross_domain_messenger: L1_MESSENGER, l1_standard_bridge: L1_BRIDGE } = networks.testnet.duskEvm.contracts;
const USER = "0xeb9ea22334e679cdbc669cf9ad2d713b559708b1";
const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TX = `0x${"57".repeat(32)}`;

/** A receipt whose one MessagePassed event carries `message`, relayed from the L2 bridge to `target`. */
function receipt(message, value, target = L1_MESSENGER.evmAddress) {
  const data = encodeFunctionData({ abi: ABI, args: [7n, "0x4200000000000000000000000000000000000010", L1_BRIDGE.evmAddress, value, 200_000n, message], functionName: "relayMessage" });
  const withdrawal = { data, gasLimit: 519_542n, nonce: 7n, sender: MESSENGER, target, value };
  return {
    blockNumber: "0x3564",
    logs: [
      {
        address: "0x4200000000000000000000000000000000000016",
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }], [value, withdrawal.gasLimit, data, hashWithdrawal(withdrawal)]),
        topics: encodeEventTopics({ abi: ABI, args: { nonce: 7n, sender: MESSENGER, target }, eventName: "MessagePassed" }),
      },
    ],
    status: "0x1",
    transactionHash: TX,
  };
}

test("a DuskEVM hash opens as a withdrawal only when it withdraws DUSK through the bridge", async () => {
  const resolve = (answer) =>
    resolveTransfer(TX, {
      cfg,
      node: { transaction: async () => null },
      rpc: async (network, method) => (network === "dusk-evm" && method === "eth_getTransactionReceipt" ? answer : null),
    });
  const pays = encodeFunctionData({ abi: ABI, args: [USER, USER, 10n ** 19n, encodeDuskExternalAssetRecipient(decodeBase58(ACCOUNT))], functionName: "finalizeBridgeETH" });
  const dusk = receipt(pays, 10n ** 19n);
  assert.deepEqual(await resolve(dusk), { hash: TX, routeId: "dusk-evm-to-dusk" });
  // The same call, sent somewhere other than Dusk's messenger.
  assert.deepEqual(await resolve(receipt(pays, 10n ** 19n, USER)), { message: "That DuskEVM transaction isn't a withdrawal of DUSK." });

  // A token withdrawal passes the same contracts, but isn't DUSK.
  const token = receipt(encodeFunctionData({ abi: ABI, args: [USER, USER, USER, USER, 5n, "0x"], functionName: "finalizeBridgeERC20" }), 0n);
  assert.deepEqual(await resolve(token), { message: "That DuskEVM transaction isn't a withdrawal of DUSK." });
  assert.deepEqual(await resolve({ ...dusk, logs: [] }), { message: "That DuskEVM transaction isn't a withdrawal of DUSK." });
});
