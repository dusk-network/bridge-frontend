import { erc20Abi } from "@dusk/evm-sdk";
import { formatUnits, parseAbi, parseUnits } from "viem";

import { ensureEvmChain, getEvmClients } from "./evm-wallet.js";
import { normalizeDuskAddress, normalizeEvmAddress } from "./validation.js";

/** The migration contracts' one function, the same on Ethereum and BNB Smart Chain. */
export const MIGRATION_ABI = parseAbi(["function migrate(uint256 amount, string mainnetDuskAddress)"]);

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

export async function approveMigration(network, amount) {
  await ensureEvmChain(network);
  const { account, publicClient, walletClient } = getEvmClients(network);
  const value = parseMigrationAmount(amount);
  const { request } = await publicClient.simulateContract({
    account,
    abi: erc20Abi,
    address: network.tokenContract,
    functionName: "approve",
    args: [network.migrationContract, value],
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error("The approval transaction failed.");
  return hash;
}

export async function submitMigration(network, amount, duskAccount) {
  await ensureEvmChain(network);
  const { account, publicClient, walletClient } = getEvmClients(network);
  const value = parseMigrationAmount(amount);
  const recipient = normalizeDuskAddress(duskAccount);
  const { request } = await publicClient.simulateContract({
    account,
    abi: MIGRATION_ABI,
    address: normalizeEvmAddress(network.migrationContract),
    functionName: "migrate",
    args: [value, recipient],
  });
  return walletClient.writeContract(request);
}
