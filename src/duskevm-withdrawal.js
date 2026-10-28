import {
  DEFAULT_WITHDRAWAL_MIN_GAS_LIMIT,
  encodeDuskExternalAssetRecipient,
  prepareNativeWithdrawal,
} from "@dusk/evm-sdk";

import { duskToLux } from "./amount.js";
import { decodeBase58 } from "./base58.js";
import { config } from "./config.js";
import { ensureDuskConnected } from "./dusk-wallet.js";
import { ensureEvmChain, getEvmClients } from "./evm-wallet.js";

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
  chainName: config.duskEvm.name,
  currency: { decimals: 18, name: "DUSK", symbol: "DUSK" },
  explorerUrl: config.duskEvm.explorerUrl,
  rpcUrl: config.duskEvm.rpcUrl,
});

export function prepareWithdrawalCall({ account, amountWei, duskAccount }) {
  return prepareNativeWithdrawal({
    amountWei: BigInt(amountWei),
    extraData: encodeDuskExternalAssetRecipient(decodeBase58(duskAccount)),
    minGasLimit: DEFAULT_WITHDRAWAL_MIN_GAS_LIMIT,
    recipient: account,
  });
}

export async function submitDuskEvmWithdrawal({ amount }) {
  const amountWei = withdrawalAmountWei(amount);
  const profile = await ensureDuskConnected();
  const network = duskEvmNetwork();
  await ensureEvmChain(network);
  const { account, publicClient, walletClient } = getEvmClients(network);
  const operation = prepareWithdrawalCall({
    account,
    amountWei,
    duskAccount: profile.account,
  });
  const hash = await walletClient.sendTransaction({
    account,
    data: operation.l2Transaction.data,
    to: operation.l2Transaction.to,
    value: operation.l2Transaction.value,
  });
  return {
    amountWei,
    duskAccount: profile.account,
    hash,
    receipt: await publicClient.waitForTransactionReceipt({ hash }),
  };
}
