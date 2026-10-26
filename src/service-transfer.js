import { formatUnits } from "./amount.js";
import { config } from "./config.js";
import { sendDuskTransfer } from "./dusk-wallet.js";
import { gasAtNodePrice, TRANSFER_GAS_LIMIT } from "./gas.js";
import { normalizeEvmAddress } from "./validation.js";

/**
 * Dusk -> BSC (or Sepolia on testnet): a public transfer to the operated
 * bridge account, with the EVM destination as the memo. The bridge pays out
 * the amount minus its fee to that address. With the node, the transfer
 * carries the wallet's public-transfer gas limit at the node's price, so the
 * quote and the wallet agree.
 */
export async function serviceTransferRequest({ amountLux, destination, node }) {
  const service = config.service;
  if (!service) throw new Error("This route isn't configured for this deployment.");
  const amount = BigInt(amountLux);
  if (amount <= service.feeLux)
    throw new Error(
      `The amount must exceed the ${formatUnits(service.feeLux, 9)} DUSK bridge fee.`,
    );
  const to = normalizeEvmAddress(destination);
  return {
    amountLux: amount,
    ...(node ? { gas: await gasAtNodePrice(TRANSFER_GAS_LIMIT, node) } : {}),
    memo: to,
    to: service.account,
  };
}

export async function submitServiceTransfer(options) {
  const request = options.request ?? (await serviceTransferRequest(options));
  const { hash } = await sendDuskTransfer(request);
  return { hash, to: request.memo };
}
