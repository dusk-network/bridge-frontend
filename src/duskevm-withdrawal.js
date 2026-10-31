import { withdrawalCall } from "@dusk-network/app-core/duskevm-withdrawals";

import { duskToLux } from "./amount.js";
import { config } from "./config.js";
import { ensureDuskConnected } from "./dusk-wallet.js";
import { ensureEvmChain, getEvmClients, reviewedEvmAccount } from "./evm-wallet.js";
import { normalizeDuskAddress } from "./validation.js";

/** DuskEVM counts 18 decimals; Dusk holds whole Lux (9). */
export const WEI_PER_LUX = 1_000_000_000n;

/**
 * A withdrawal amount in wei, refusing anything finer than one Lux: Dusk
 * can't hold less, so the web wallet never sends it either.
 */
export function withdrawalAmountWei(amount) {
  return duskToLux(amount) * WEI_PER_LUX;
}

export const duskEvmNetwork = () => ({
  chainId: config.duskEvm.chainId,
  // What the wallet lists: "DuskEVM Testnet" on testnet.
  chainName: config.duskEvm.name,
  currency: { decimals: 18, name: "DUSK", symbol: "DUSK" },
  explorerUrl: config.duskEvm.explorerUrl,
  rpcUrl: config.duskEvm.rpcUrl,
});

/**
 * Sends the DuskEVM step and returns its hash once the wallet has sent it;
 * the tracker follows it from there. The Dusk recipient is the one given, or
 * the connected Dusk account. It goes out from `account`, the EVM account
 * it was reviewed for, or not at all.
 */
export async function submitDuskEvmWithdrawal({ account: reviewed, amount, duskAccount }) {
  const amountWei = withdrawalAmountWei(amount);
  const recipient = duskAccount ? normalizeDuskAddress(duskAccount) : (await ensureDuskConnected()).account;
  const network = duskEvmNetwork();
  await ensureEvmChain(network);
  const { walletClient } = getEvmClients(network);
  const account = await reviewedEvmAccount(reviewed);
  // DuskEVM's bridge's bridgeETHTo, paying the Dusk account in its extra data.
  const { data, to, value } = withdrawalCall(config.network, { amountWei, sender: account, to: recipient });
  const hash = await walletClient.sendTransaction({ account, data, to, value });
  return { amountWei, duskAccount: recipient, hash };
}
