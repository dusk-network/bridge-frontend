import { formatUnits } from "./amount.js";
import { config } from "./config.js";
import { sendDuskTransfer } from "./dusk-wallet.js";
import { normalizeEvmAddress } from "./validation.js";

/**
 * Dusk -> BSC (or Sepolia on testnet): a public transfer to the operated
 * bridge account, with the EVM destination as the memo. The bridge pays out
 * the amount minus its fee to that address.
 */
export async function submitServiceTransfer({ amountLux, destination }) {
  const service = config.service;
  if (!service) throw new Error("This route isn't configured for this deployment.");
  const amount = BigInt(amountLux);
  if (amount <= service.feeLux)
    throw new Error(
      `The amount must exceed the ${formatUnits(service.feeLux, 9)} DUSK bridge fee.`,
    );
  const to = normalizeEvmAddress(destination);
  const { hash } = await sendDuskTransfer({
    amountLux: amount,
    memo: to,
    to: service.account,
  });
  return { hash, to };
}
