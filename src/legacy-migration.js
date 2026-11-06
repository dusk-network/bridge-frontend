import { erc20Abi } from "@dusk/evm-sdk";
import { createPublicClient, formatUnits, http, parseAbi, parseUnits } from "viem";

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

/** An approval cancelled in the wallet once it was sent: nothing was approved. */
export const APPROVAL_CANCELLED = "You cancelled the approval in your wallet. Nothing moved.";

/**
 * Approves exactly `amount` from `account`, the EVM account it was reviewed
 * for, or sends nothing. Its hash is the transaction mined: the one the wallet
 * sent, or the one it sent in its place when sped up.
 */
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
  const { receipt, replaced } = await mined(publicClient, hash);
  if (replaced === "cancelled") throw new Error(APPROVAL_CANCELLED);
  if (receipt.status !== "success" || (replaced && replaced !== "repriced"))
    throw new Error("The approval transaction failed.");
  return receipt.transactionHash;
}

/** Why a revoke ends without one: it didn't go through on its chain. */
export const NOT_REVOKED = "The approval wasn't revoked. Check your EVM wallet's activity before you try again.";

/** A revoke cancelled in the wallet once it was sent: the approval is as it was. */
export const REVOKE_CANCELLED = "You cancelled the revoke in your wallet. The approval stands.";

/**
 * Waits for the wallet's transaction `hash` to be mined, or the one the
 * wallet sent in its place on the same nonce (viem's `onReplaced`): sped up
 * ("repriced"), "cancelled", or "replaced" by another. The receipt is the
 * mined transaction's, under its own hash.
 */
async function mined(publicClient, hash) {
  let replaced = null;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    onReplaced: ({ reason }) => {
      replaced = reason;
    },
  });
  return { receipt, replaced };
}

/**
 * Takes back what the migration contract may take from `account`, the EVM
 * account it was reviewed for: an approval of 0, once it's in a block. With
 * nothing approved on the chain any more, the wallet is asked for nothing.
 * It's revoked only once the chain says so: a revoke the wallet cancelled or
 * replaced after sending it leaves the approval standing.
 */
export async function revokeMigration(network, { account: reviewed } = {}) {
  await ensureEvmChain(network);
  const { publicClient, walletClient } = getEvmClients(network);
  const approved = (blockNumber) =>
    publicClient.readContract({
      abi: erc20Abi,
      address: network.tokenContract,
      args: [reviewed, network.migrationContract],
      blockNumber,
      functionName: "allowance",
    });
  if ((await approved()) === 0n) return null;
  const { request } = await publicClient.simulateContract({
    account: reviewed,
    abi: erc20Abi,
    address: network.tokenContract,
    functionName: "approve",
    args: [network.migrationContract, 0n],
  });
  const hash = await walletClient.writeContract({ ...request, account: await reviewedEvmAccount(reviewed) });
  const { receipt, replaced } = await mined(publicClient, hash);
  // As of the block it was mined in, whatever the wallet sent in its place.
  if (receipt.status !== "success" || (await approved(receipt.blockNumber)) !== 0n)
    throw new Error(replaced === "cancelled" ? REVOKE_CANCELLED : NOT_REVOKED);
  return receipt.transactionHash;
}

/**
 * What the wallet's transaction `hash` was mined as, read on its chain: its
 * own hash, or the one the wallet sent in its place on the same nonce, and why
 * (`replaced`: "repriced" when sped up, "cancelled" or "replaced"). Given up
 * after viem's three minutes.
 */
export async function minedAs(network, hash) {
  const { receipt, replaced } = await mined(createPublicClient({ transport: http(network.rpcUrl) }), hash);
  return { hash: receipt.transactionHash, replaced };
}

/**
 * Migrates `amount` to `duskAccount` from `account`, the EVM account it was
 * reviewed for, or sends nothing. Its hash is the one the wallet sent: until
 * it's mined (`minedAs`), the wallet can speed it up under another.
 */
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
