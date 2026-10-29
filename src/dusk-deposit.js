import { depositCall } from "@dusk-network/networks/duskevm";
import { DEPOSIT_GAS } from "@dusk-network/networks/gas";

import { formatUnits } from "viem";
import { config } from "./config.js";
import { networkName } from "./names.js";
import { gasAtNodePrice } from "./gas.js";
import { normalizeEvmAddress } from "./validation.js";

/** What the wallet shows as the dApp's own (unverified) description. */
export function depositDisplay({ amountLux, recipient }) {
  return {
    label: `Bridge ${formatUnits(amountLux, 9)} DUSK to ${networkName(config, "dusk-evm")}`,
    recipient,
  };
}

/**
 * The deposit as Dusk Wallet receives it: the review shows this request, and
 * the same request is sent. Its call leaves DuskEVM's SDK default, 200,000
 * gas, to the deposit's own call there (`depositCall`).
 */
export async function depositRequest({ amountLux, gasPrice = null, node, recipient }) {
  if (!config.duskEvm.enabled)
    throw new Error("DuskEVM deposits are not configured for this deployment.");
  const to = normalizeEvmAddress(recipient);
  const { contractId, deposit, fnArgs, fnName } = depositCall(config.network, { amountLux, to });
  return {
    contractId,
    depositLux: deposit,
    display: depositDisplay({ amountLux, recipient: to }),
    fnArgs,
    fnName,
    gas: await gasAtNodePrice(DEPOSIT_GAS.limit, node, gasPrice),
  };
}
