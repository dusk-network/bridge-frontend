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

export function formatUnits(value, decimals, maximumFractionDigits = decimals) {
  const units = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0");
  const shown = fraction.slice(0, maximumFractionDigits).replace(/0+$/u, "");
  return shown ? `${whole}.${shown}` : whole.toString();
}

export const duskToLux = (input) => parseUnitsExact(input, 9);
export const duskToWei = (input) => parseUnitsExact(input, 18);
