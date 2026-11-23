import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decodeFunctionData, encodeAbiParameters, parseAbi } from "viem";

import { loadConfig } from "./config.js";
import { GAS_PRICE_ORACLE, createEvmReads } from "./evm-reads.js";

// Testnet's site, with its settings from deployments.json.
globalThis.__DUSK_BRIDGE_CONFIG__ = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"))["https://bridge.testnet.dusk.network/"];
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;

const ORACLE = parseAbi(["function getL1FeeUpperBound(uint256) view returns (uint256)", "function getOperatorFee(uint256) view returns (uint256)"]);
const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const EVM = "0x75685f9D88749B583732B40d56fe007cD404b72D";
const word = (value) => encodeAbiParameters([{ type: "uint256" }], [value]);

test("a withdrawal's state reads what DuskEVM adds from its GasPriceOracle, at the gas limit the wallet is asked for", async () => {
  const asked = [];
  // DuskEVM as testnet's RPC answers: 138,439 gas, a 10 gwei base fee and a 0.001 gwei tip, and the oracle.
  const rpc = async (network, method) => {
    assert.deepEqual([network, method], ["dusk-evm", "eth_estimateGas"]);
    return "0x21cc7";
  };
  const rpcBatch = async (network, calls) => {
    assert.equal(network, "dusk-evm");
    return calls.map(({ method, params }) => {
      if (method === "eth_getBalance") return "0x10f0cf064dd59200000";
      if (method === "eth_gasPrice") return "0x2541b2640";
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x2540be400" };
      if (method === "eth_maxPriorityFeePerGas") return "0xf4240";
      assert.equal(params[0].to, GAS_PRICE_ORACLE);
      const { args, functionName } = decodeFunctionData({ abi: ORACLE, data: params[0].data });
      asked.push([functionName, args[0]]);
      return word(functionName === "getOperatorFee" ? 24_071_158_578_548_300n : 379n);
    });
  };
  const reads = createEvmReads({ cfg, rpc, rpcBatch });
  const state = await reads.withdrawalState(EVM, { amountWei: 1_008n * 10n ** 18n, duskAccount: ACCOUNT });
  assert.deepEqual(state, {
    balanceWei: 5_000n * 10n ** 18n,
    baseFeeWei: 10_000_000_000n,
    // Its gas is the call's own estimate.
    estimated: true,
    gas: 138_439n,
    gasLimit: 166_127n,
    gasPriceWei: 10_001_000_000n,
    l1FeeMaxWei: 379n,
    operatorFeeWei: 24_071_158_578_548_300n,
    tipWei: 1_000_000n,
  });
  // The L1 data fee at most for the call's 356 bytes and what's around them; the operator fee at the limit asked for.
  assert.deepEqual(asked, [
    ["getL1FeeUpperBound", 516n],
    ["getOperatorFee", 166_127n],
  ]);
});

test("a withdrawal's state says when its gas isn't the call's own estimate, and takes a gas price at the base fee as no tip", async () => {
  // The estimate refused, and a node without eth_maxPriorityFeePerGas whose gas price is the base fee.
  const rpc = async () => {
    throw Object.assign(new Error("execution reverted"), { code: 3 });
  };
  const rpcBatch = async (_network, calls) =>
    calls.map(({ method }) => {
      if (method === "eth_getBalance") return "0x10f0cf064dd59200000";
      if (method === "eth_gasPrice") return "0x2540be400";
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x2540be400" };
      if (method === "eth_maxPriorityFeePerGas") return undefined;
      return word(1n);
    });
  const state = await createEvmReads({ cfg, rpc, rpcBatch }).withdrawalState(EVM, { amountWei: 10n ** 18n, duskAccount: ACCOUNT });
  assert.deepEqual([state.estimated, state.gas, state.tipWei], [false, 140_000n, 0n]);
  // Nothing to estimate yet: no estimate either.
  assert.equal((await createEvmReads({ cfg, rpc, rpcBatch }).withdrawalState(EVM)).estimated, false);
});
