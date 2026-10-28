export function parseUnitsExact(input, decimals) {
  const value = String(input ?? "").trim();
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);

  if (!match) throw new Error("Enter a positive decimal amount.");

  const fraction = match[1] ?? "";
  if (fraction.length > decimals) {
    throw new Error(
      `DUSK supports at most ${decimals} decimal places on this network.`,
    );
  }

  const [whole] = value.split(".");
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new Error("Amount must be greater than zero.");
  return units;
}

export const duskToLux = (input) => parseUnitsExact(input, 9);
export const duskToWei = (input) => parseUnitsExact(input, 18);
