import { formatUnits, parseUnits } from "viem";

import { ensureEvmChain, getEvmClients } from "./evm-wallet.js";
import { normalizeDuskAddress, normalizeEvmAddress } from "./validation.js";

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const migrationAbi = [
  {
    type: "function",
    name: "migrate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "mainnetDuskAddress", type: "string" },
    ],
    outputs: [],
  },
];

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

export async function migrationSnapshot(network) {
  await ensureEvmChain(network);
  const { account, publicClient } = getEvmClients(network);
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({
      account,
      abi: erc20Abi,
      address: network.tokenContract,
      functionName: "balanceOf",
      args: [account],
    }),
    publicClient.readContract({
      account,
      abi: erc20Abi,
      address: network.tokenContract,
      functionName: "allowance",
      args: [account, network.migrationContract],
    }),
  ]);
  return { allowance, balance, formattedBalance: formatUnits(balance, 18) };
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
    abi: migrationAbi,
    address: normalizeEvmAddress(network.migrationContract),
    functionName: "migrate",
    args: [value, recipient],
  });
  return walletClient.writeContract(request);
}
