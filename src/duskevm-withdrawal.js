import {
  encodeDuskExternalAssetRecipient,
  prepareNativeWithdrawal,
} from "@dusk/evm-sdk";

import { decodeBase58 } from "./base58.js";
import { config } from "./config.js";
import { ensureDuskConnected } from "./dusk-wallet.js";
import { ensureEvmChain, getEvmClients } from "./evm-wallet.js";

export const DEFAULT_WITHDRAWAL_MIN_GAS_LIMIT = 200_000;

export const duskEvmNetwork = () => ({
  chainId: config.duskEvm.chainId,
  chainName: config.duskEvm.name,
  currency: { decimals: 18, name: "DUSK", symbol: "DUSK" },
  explorerUrl: config.duskEvm.explorerUrl,
  rpcUrl: config.duskEvm.rpcUrl,
});

export async function submitDuskEvmWithdrawal({ amountWei }) {
  const profile = await ensureDuskConnected(config.duskEvm.l1ChainId);
  const network = duskEvmNetwork();
  await ensureEvmChain(network);
  const { account, publicClient, walletClient } = getEvmClients(network);
  const extraData = encodeDuskExternalAssetRecipient(
    decodeBase58(profile.account),
  );
  const operation = prepareNativeWithdrawal({
    amountWei: BigInt(amountWei),
    extraData,
    minGasLimit: DEFAULT_WITHDRAWAL_MIN_GAS_LIMIT,
    recipient: account,
  });
  const hash = await walletClient.sendTransaction({
    account,
    data: operation.l2Transaction.data,
    to: operation.l2Transaction.to,
    value: operation.l2Transaction.value,
  });
  return {
    hash,
    operation,
    receipt: await publicClient.waitForTransactionReceipt({ hash }),
  };
}
