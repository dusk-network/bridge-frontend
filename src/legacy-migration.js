import { erc20Abi } from "@dusk/evm-sdk";
import { formatUnits, parseAbi, parseUnits } from "viem";

import { ensureEvmChain, getEvmClients, reviewedEvmAccount } from "./evm-wallet.js";
import { normalizeDuskAddress, normalizeEvmAddress } from "./validation.js";

/** The migration contracts' one function, the same on Ethereum and BNB Smart Chain. */
export const MIGRATION_ABI = parseAbi(["function migrate(uint256 amount, string targetAddress)"]);

export function parseMigrationAmount(amount) {
  const value = parseUnits(String(amount).trim(), 18);
  if (value < 1_000_000_000n)
    throw new Error("The migration minimum is 0.000000001 DUSK.");
  if (value % 1_000_000_000n !== 0n) {
    throw new Error(
      "Use at most 9 decimal places; smaller fractions are rounded down by the migration contract.",
    );
  }
  return value;
}

export function assertMigrationBalance(balance, amount) {
  const value = parseMigrationAmount(amount);
  if (BigInt(balance) < value)
    throw new Error(
      `Insufficient DUSK token balance: ${formatUnits(balance, 18)} available, ${formatUnits(value, 18)} required.`,
    );
  return value;
}

/** Approves exactly `amount` from `account`, the EVM account it was reviewed for, or sends nothing. */
export async function approveMigration(network, amount, { account: reviewed } = {}) {
  await ensureEvmChain(network);
  const { publicClient, walletClient } = getEvmClients(network);
  const value = parseMigrationAmount(amount);
  const { request } = await publicClient.simulateContract({
    account: reviewed,
    abi: erc20Abi,
    address: network.tokenContract,
    functionName: "approve",
    args: [network.migrationContract, value],
  });
  const hash = await walletClient.writeContract({ ...request, account: await reviewedEvmAccount(reviewed) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error("The approval transaction failed.");
  return hash;
}

/** Why a revoke ends without one: it didn't go through on its chain. */
export const NOT_REVOKED = "The approval wasn't revoked. Check your EVM wallet's activity before you try again.";

/**
 * Takes back what the migration contract may take from `account`, the EVM
 * account it was reviewed for: an approval of 0, once it's in a block. With
 * nothing approved on the chain any more, the wallet is asked for nothing.
 */
export async function revokeMigration(network, { account: reviewed } = {}) {
  await ensureEvmChain(network);
  const { publicClient, walletClient } = getEvmClients(network);
  const left = await publicClient.readContract({
    abi: erc20Abi,
    address: network.tokenContract,
    args: [reviewed, network.migrationContract],
    functionName: "allowance",
  });
  if (left === 0n) return null;
  const { request } = await publicClient.simulateContract({
    account: reviewed,
    abi: erc20Abi,
    address: network.tokenContract,
    functionName: "approve",
    args: [network.migrationContract, 0n],
  });
  const hash = await walletClient.writeContract({ ...request, account: await reviewedEvmAccount(reviewed) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(NOT_REVOKED);
  return hash;
}

/** Migrates `amount` to `duskAccount` from `account`, the EVM account it was reviewed for, or sends nothing. */
export async function submitMigration(network, amount, duskAccount, { account: reviewed } = {}) {
  await ensureEvmChain(network);
  const { publicClient, walletClient } = getEvmClients(network);
  const value = parseMigrationAmount(amount);
  const recipient = normalizeDuskAddress(duskAccount);
  const { request } = await publicClient.simulateContract({
    account: reviewed,
    abi: MIGRATION_ABI,
    address: normalizeEvmAddress(network.migrationContract),
    functionName: "migrate",
    args: [value, recipient],
  });
  return walletClient.writeContract({ ...request, account: await reviewedEvmAccount(reviewed) });
}
