// Balances, allowances and gas estimates for the quote and the review, read
// from each chain's public RPC: the wallet isn't asked to switch chains just
// so the page can read.

import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex } from "viem";

import { prepareWithdrawalCall } from "./duskevm-withdrawal.js";

const ERC20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
const MIGRATION = parseAbi(["function migrate(uint256 amount, string mainnetDuskAddress)"]);

/**
 * What a migration usually spends when it can't be estimated yet (before
 * the approval, the contract would refuse the call): a transferFrom and an
 * event, with headroom.
 */
export const MIGRATE_GAS_FALLBACK = 70_000n;
/** A DuskEVM withdrawal spends about 138,000 gas (testnet, October). */
export const WITHDRAW_GAS_FALLBACK = 140_000n;

const big = (value) => (value === null || value === undefined ? null : BigInt(value));

export function createEvmReads({ cfg, rpc, rpcBatch }) {
  const call = (to, data) => ({ method: "eth_call", params: [{ data, to }, "latest"] });

  /** Old DUSK held, the migration contract's allowance, and the gas coin: one request. */
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
              data: encodeFunctionData({ abi: MIGRATION, args: [amountWei, duskAccount], functionName: "migrate" }),
              from: owner,
              to: chain.migrationContract,
            },
            MIGRATE_GAS_FALLBACK,
          )
        : MIGRATE_GAS_FALLBACK;
    return { approve: await approve, migrate: await migrate };
  }

  /** DUSK on DuskEVM, its gas price, and what the withdrawal call would spend. */
  async function withdrawalState(owner, { amountWei, duskAccount } = {}) {
    const [balance, price] = await rpcBatch("dusk-evm", [
      { method: "eth_getBalance", params: [owner, "latest"] },
      { method: "eth_gasPrice", params: [] },
    ]);
    let gas = WITHDRAW_GAS_FALLBACK;
    if (amountWei && duskAccount) {
      try {
        const { l2Transaction } = prepareWithdrawalCall({ account: owner, amountWei, duskAccount });
        gas = await estimate(
          "dusk-evm",
          { data: l2Transaction.data, from: owner, to: l2Transaction.to, value: toHex(l2Transaction.value) },
          WITHDRAW_GAS_FALLBACK,
        );
      } catch {
        gas = WITHDRAW_GAS_FALLBACK;
      }
    }
    return { balanceWei: big(balance), gas, gasPriceWei: big(price) };
  }

  return Object.freeze({ migrationGas, migrationState, withdrawalState });
}
