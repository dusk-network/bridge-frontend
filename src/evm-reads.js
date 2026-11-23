// Balances, allowances and gas estimates for the quote and the review, read
// from each chain's public RPC: the wallet isn't asked to switch chains just
// so the page can read.

import { withdrawalCall } from "@dusk-network/app-core/duskevm-withdrawals";
import { erc20Abi as ERC20 } from "@dusk/evm-sdk";
import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex } from "viem";

import { MIGRATION_ABI } from "./legacy-migration.js";

/**
 * What a migration usually spends when it can't be estimated yet (before
 * the approval, the contract would refuse the call): a transferFrom and an
 * event, with headroom.
 */
export const MIGRATE_GAS_FALLBACK = 70_000n;
/** A DuskEVM withdrawal spends about 138,000 gas (testnet, October). */
export const WITHDRAW_GAS_FALLBACK = 140_000n;

/**
 * DuskEVM's GasPriceOracle predeploy, as on every OP Stack chain: what the
 * chain adds to a transaction's gas, its L1 data fee and its operator fee.
 */
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE = parseAbi([
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
]);
/** At most what a type-2 transaction adds around its call data, unsigned: its type, chain, nonce, fees, gas, to and value. */
const ENVELOPE_BYTES = 160;
/** A withdrawal's call data, a bridgeETHTo to a Dusk account, as testnet's went out: 356 bytes, where the call can't be built yet. */
const WITHDRAW_DATA_BYTES = 356;

/** The gas limit a withdrawal asks the wallet for: the estimate and a fifth more, for what the chain does differently by then. */
export const duskEvmGasLimit = (gas) => (BigInt(gas) * 6n + 4n) / 5n;

const big = (value) => (value === null || value === undefined ? null : BigInt(value));

export function createEvmReads({ cfg, rpc, rpcBatch }) {
  const call = (to, data) => ({ method: "eth_call", params: [{ data, to }, "latest"] });

  /** The ERC20 or BEP20 DUSK held, the migration contract's allowance, and the gas coin: one request. */
  async function migrationState(network, owner) {
    const chain = cfg.evmNetworks[network];
    const [balance, allowance, coins, price] = await rpcBatch(network, [
      call(chain.tokenContract, encodeFunctionData({ abi: ERC20, args: [owner], functionName: "balanceOf" })),
      call(
        chain.tokenContract,
        encodeFunctionData({ abi: ERC20, args: [owner, chain.migrationContract], functionName: "allowance" }),
      ),
      { method: "eth_getBalance", params: [owner, "latest"] },
      { method: "eth_gasPrice", params: [] },
    ]);
    const read = (data, functionName) =>
      data ? decodeFunctionResult({ abi: ERC20, data, functionName }) : null;
    return {
      allowanceWei: read(allowance, "allowance"),
      balanceWei: read(balance, "balanceOf"),
      gasCoinWei: big(coins),
      gasPriceWei: big(price),
    };
  }

  async function estimate(network, request, fallback = null) {
    try {
      return BigInt(await rpc(network, "eth_estimateGas", [request]));
    } catch {
      return fallback;
    }
  }

  /** Gas for the approval and the migration; the migration's is a fallback until approved. */
  async function migrationGas(network, { allowanceWei, amountWei, duskAccount, owner }) {
    const chain = cfg.evmNetworks[network];
    const approve = estimate(network, {
      data: encodeFunctionData({ abi: ERC20, args: [chain.migrationContract, amountWei], functionName: "approve" }),
      from: owner,
      to: chain.tokenContract,
    });
    const migrate =
      allowanceWei !== null && allowanceWei >= amountWei && duskAccount
        ? estimate(
            network,
            {
              data: encodeFunctionData({ abi: MIGRATION_ABI, args: [amountWei, duskAccount], functionName: "migrate" }),
              from: owner,
              to: chain.migrationContract,
            },
            MIGRATE_GAS_FALLBACK,
          )
        : MIGRATE_GAS_FALLBACK;
    return { approve: await approve, migrate: await migrate };
  }

  /** Gas for a revoke: an approval of 0 for the migration contract. Null where it can't be estimated. */
  function revokeGas(network, owner) {
    const chain = cfg.evmNetworks[network];
    return estimate(network, {
      data: encodeFunctionData({ abi: ERC20, args: [chain.migrationContract, 0n], functionName: "approve" }),
      from: owner,
      to: chain.tokenContract,
    });
  }

  /**
   * DUSK on DuskEVM, and what the withdrawal call would spend and cost: its
   * gas, the limit the wallet is asked for, the base fee and tip it's priced
   * at, and what DuskEVM adds as its GasPriceOracle says, for a transaction
   * of this size at that limit: the L1 data fee at most, and the operator fee.
   * `estimated` says the gas is the call's own estimate, not the fallback a
   * withdrawal usually needs.
   */
  async function withdrawalState(owner, { amountWei, duskAccount } = {}) {
    const [balance, price, block, tip] = await rpcBatch("dusk-evm", [
      { method: "eth_getBalance", params: [owner, "latest"] },
      { method: "eth_gasPrice", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_maxPriorityFeePerGas", params: [] },
    ]);
    let gas = null;
    let dataBytes = WITHDRAW_DATA_BYTES;
    if (amountWei && duskAccount) {
      try {
        const { data, to, value } = withdrawalCall(cfg.network, { amountWei, sender: owner, to: duskAccount });
        dataBytes = (data.length - 2) / 2;
        gas = await estimate("dusk-evm", { data, from: owner, to, value: toHex(value) });
      } catch {
        gas = null;
      }
    }
    const estimated = gas !== null;
    gas ??= WITHDRAW_GAS_FALLBACK;
    const gasLimit = duskEvmGasLimit(gas);
    const [l1Fee, operatorFee] = await rpcBatch("dusk-evm", [
      call(GAS_PRICE_ORACLE, encodeFunctionData({ abi: ORACLE, args: [BigInt(dataBytes + ENVELOPE_BYTES)], functionName: "getL1FeeUpperBound" })),
      call(GAS_PRICE_ORACLE, encodeFunctionData({ abi: ORACLE, args: [gasLimit], functionName: "getOperatorFee" })),
    ]);
    const word = (data) => (data && data !== "0x" ? BigInt(data) : null);
    const baseFeeWei = big(block?.baseFeePerGas);
    const gasPriceWei = big(price);
    // A node without the tip's method: what its gas price is above the base fee, none where it's that.
    const tipWei = big(tip) ?? (gasPriceWei !== null && baseFeeWei !== null && gasPriceWei >= baseFeeWei ? gasPriceWei - baseFeeWei : null);
    return {
      balanceWei: big(balance),
      baseFeeWei,
      estimated,
      gas,
      gasLimit,
      gasPriceWei,
      l1FeeMaxWei: word(l1Fee),
      operatorFeeWei: word(operatorFee),
      tipWei,
    };
  }

  /** Whether an address on a chain holds code: a contract, not an ordinary wallet. */
  async function hasCode(network, address) {
    const code = await rpc(network, "eth_getCode", [address, "latest"]);
    return Boolean(code) && code !== "0x";
  }

  return Object.freeze({ hasCode, migrationGas, migrationState, revokeGas, withdrawalState });
}
