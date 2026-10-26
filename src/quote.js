// The quote under the amount: what you send, the network fee as a maximum
// and its usual cost, the bridge fee, what you receive and when. Pure: the
// balances, prices and gas estimates come in, so it's the same before and
// after the wallet opens.

import { aboutFee, formatDusk, formatFee, formatLux, formatMaxFee, formatUnitsGrouped } from "./format.js";
import {
  DEPOSIT_GAS_LIMIT,
  DEPOSIT_GAS_TYPICAL,
  TRANSFER_GAS_LIMIT,
  TRANSFER_GAS_TYPICAL,
  WITHDRAWAL_STEP_GAS_TYPICAL,
  withdrawalStepGas,
} from "./gas.js";
import { gasCoin, networkName } from "./names.js";
import {
  WITHDRAWAL_REPORT_SECONDS,
  WITHDRAWAL_WAITING_PERIOD_SECONDS,
  roughDuration,
} from "./withdrawal-lifecycle.js";

const WEI_PER_LUX = 1_000_000_000n;
const DECIMALS = 9;

/**
 * The typed amount without its commas, or why its commas can't be read.
 * Commas group thousands ("1,234.5"); a lone comma with other than three
 * digits after it is a decimal comma ("0,5"). One that could be either
 * ("1,234") is asked about, so what is sent never differs from what was meant.
 */
function withoutCommas(value) {
  if (!value.includes(",")) return { value };
  const lone = /^(\d{1,3}),(\d{3})$/u.exec(value);
  if (lone) return { error: `Is that ${lone[1]}${lone[2]} or ${lone[1]}.${lone[2]}? Write it without the comma.` };
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/u.test(value)) return { value: value.replace(/,/gu, "") };
  if (/^\d+,\d+$/u.test(value)) return { value: value.replace(",", ".") };
  return { error: "Use a point for decimals, like 0.5." };
}

/** The typed amount in Lux, or why it can't be one. Empty is no error. */
export function parseAmount(input) {
  const read = withoutCommas(String(input ?? "").trim());
  if (read.error) return { error: read.error, lux: null };
  const { value } = read;
  if (!value) return { error: "", lux: null };
  const match = /^(\d+)(?:\.(\d*))?$/u.exec(value);
  if (!match) return { error: "Enter an amount like 25 or 0.5.", lux: null };
  const fraction = match[2] ?? "";
  if (fraction.length > DECIMALS) return { error: "Use at most 9 decimals.", lux: null };
  const lux = BigInt(match[1]) * 10n ** 9n + BigInt(fraction.padEnd(DECIMALS, "0") || "0");
  if (lux <= 0n) return { error: "Enter an amount above 0.", lux: null };
  return { error: "", lux };
}

/** The Dusk fee of one transaction: the most it can cost, and the usual. */
export function duskFee(limit, typical, gasPrice) {
  const price = BigInt(gasPrice ?? 1n) > 0n ? BigInt(gasPrice) : 1n;
  return { maxLux: BigInt(limit) * price, typicalLux: BigInt(typical) * price };
}

const feeText = ({ maxLux, typicalLux }) => ({
  detail: `usually about ${formatFee(typicalLux)} DUSK`,
  value: `up to ${formatMaxFee(maxLux)} DUSK`,
});

/**
 * What each Dusk-side step of a route costs at most, and usually. A proof
 * and a claim share one limit (`withdrawalStepGas`): the withdrawal's own
 * gas on top, at least a bound above what the bridge's withdrawals ask for.
 */
export function routeDuskFees(route, { gasPrice = 1n, withdrawalGas = 0n } = {}) {
  if (route.mode === "duskevm-deposit")
    return { send: duskFee(DEPOSIT_GAS_LIMIT, DEPOSIT_GAS_TYPICAL, gasPrice) };
  if (route.mode === "service-transfer")
    return { send: duskFee(TRANSFER_GAS_LIMIT, TRANSFER_GAS_TYPICAL, gasPrice) };
  if (route.mode === "duskevm-withdrawal") {
    const step = duskFee(withdrawalStepGas(withdrawalGas), WITHDRAWAL_STEP_GAS_TYPICAL, gasPrice);
    return { claim: step, prove: step };
  }
  return {};
}

/** The usual time to arrive, in words. */
export function arrivalText(route, cfg) {
  if (route.mode === "duskevm-deposit") return "usually within a minute";
  if (route.mode === "service-transfer")
    return `usually within ${roughDuration(cfg.service?.delaySeconds ?? 3_600)}`;
  if (route.mode === "migration")
    return `usually within ${roughDuration(cfg.migrationDelaySeconds ?? 3_600)} after step 2`;
  return `about ${roughDuration(WITHDRAWAL_REPORT_SECONDS + WITHDRAWAL_WAITING_PERIOD_SECONDS)}, in three steps`;
}

/**
 * The quote for `amount` on `route`.
 *
 * @param {object} route
 * @param {string} amount what the user typed
 * @param {object} ctx
 * @param {object} ctx.cfg the deployment config
 * @param {bigint} [ctx.gasPrice] Dusk gas price, in Lux
 * @param {bigint | null} [ctx.balance] what the source holds: Lux on Dusk, wei on an EVM chain
 * @param {{ approve?: bigint, migrate?: bigint, withdraw?: bigint, priceWei?: bigint }} [ctx.evmGas]
 * @param {bigint} [ctx.allowanceWei] the migration contract's allowance
 * @param {bigint | null} [ctx.gasCoinBalance] ETH, BNB or DuskEVM DUSK for EVM gas, in wei
 */
export function buildQuote(route, amount, ctx) {
  const { cfg } = ctx;
  const to = networkName(cfg, route.to.id);
  const from = networkName(cfg, route.from.id);
  const parsed = parseAmount(amount);
  const lux = parsed.lux;
  const rows = [];
  const quote = { amountLux: lux, error: parsed.error, leaves: "", maxLux: null, receiveLux: lux, rows };
  const shown = (value) => (value === null ? "—" : formatDusk(value));

  if (route.mode === "duskevm-deposit" || route.mode === "service-transfer") {
    const fee = routeDuskFees(route, ctx).send;
    const bridgeFee = route.mode === "service-transfer" ? BigInt(cfg.service.feeLux) : 0n;
    const receive = lux === null ? null : lux - bridgeFee;
    quote.receiveLux = receive;
    if (ctx.balance !== null && ctx.balance !== undefined) {
      const room = BigInt(ctx.balance) - fee.maxLux;
      quote.maxLux = room > 0n ? room : 0n;
    }
    if (!quote.error && lux !== null) {
      if (bridgeFee && lux <= bridgeFee)
        quote.error = `Send more than the ${formatDusk(bridgeFee)} bridge fee. Nothing is paid out otherwise.`;
      else if (quote.maxLux !== null && lux > quote.maxLux)
        quote.error = `That's more than you have after the network fee. You can send up to ${formatDusk(quote.maxLux)}.`;
    }
    rows.push(
      { key: "send", label: "You send", value: shown(lux) },
      { key: "fee", label: "Network fee", ...feeText(fee), detail: `${feeText(fee).detail} · on ${from}, paid by you` },
      {
        key: "bridge",
        label: "Bridge fee",
        value: bridgeFee ? `${formatDusk(bridgeFee)}, taken from the amount` : "None",
      },
      {
        key: "receive",
        label: "You receive",
        strong: true,
        value: receive === null || receive <= 0n ? "—" : `${formatDusk(receive)} on ${to}`,
      },
      { key: "arrives", label: "Arrives", value: arrivalText(route, cfg) },
    );
    if (lux !== null) quote.leaves = `up to ${formatLux(lux + fee.maxLux)} DUSK`;
    return quote;
  }

  const gas = ctx.evmGas ?? {};
  const coin = gasCoin(cfg, route.from.id);

  if (route.mode === "migration") {
    const wei = lux === null ? null : lux * WEI_PER_LUX;
    if (ctx.balance !== null && ctx.balance !== undefined) {
      const balance = BigInt(ctx.balance);
      // The contract moves whole Lux: what's finer stays in the wallet.
      quote.maxLux = balance / WEI_PER_LUX;
      if (!quote.error && wei !== null && wei > balance)
        quote.error = `That's more than the ${formatUnitsGrouped(balance, 18, 9)} old DUSK in this wallet.`;
    }
    const needsApproval = wei === null || BigInt(ctx.allowanceWei ?? 0n) < wei;
    const steps = needsApproval ? 2 : 1;
    const priced = gas.priceWei && gas.migrate && (!needsApproval || gas.approve);
    const evmFee = priced
      ? (BigInt(gas.migrate) + (needsApproval ? BigInt(gas.approve) : 0n)) * BigInt(gas.priceWei)
      : null;
    quote.evmFeeWei = evmFee;
    quote.steps = steps;
    rows.push(
      { key: "send", label: "You send", value: lux === null ? "—" : `${formatLux(lux)} old DUSK` },
      {
        detail: `${steps === 2 ? "two wallet steps" : "one wallet step"} · on ${from}, paid by you in ${coin}`,
        key: "fee",
        label: "Network fee",
        value: evmFee === null ? `paid in ${coin}` : aboutFee(evmFee, 18, coin),
      },
      { key: "bridge", label: "Bridge fee", value: "None" },
      { key: "receive", label: "You receive", strong: true, value: lux === null ? "—" : `${formatDusk(lux)} on ${to}` },
      { key: "arrives", label: "Arrives", value: arrivalText(route, cfg) },
    );
    return quote;
  }

  // DuskEVM to Dusk: one step on DuskEVM, then prove and claim on Dusk.
  const l2Fee = gas.priceWei && gas.withdraw ? BigInt(gas.withdraw) * BigInt(gas.priceWei) : null;
  if (ctx.balance !== null && ctx.balance !== undefined) {
    if (l2Fee === null) {
      // No gas price yet: the fee comes from the same balance, so there's no
      // Max until it's known, and the whole balance is already too much.
      if (!quote.error && lux !== null && lux * WEI_PER_LUX >= BigInt(ctx.balance))
        quote.error = `That's more than you have on ${from}, with its network fee.`;
    } else {
      // Keep twice the estimated gas aside, so the wallet's own estimate fits.
      const room = BigInt(ctx.balance) - 2n * l2Fee;
      quote.maxLux = room > 0n ? room / WEI_PER_LUX : 0n;
      if (!quote.error && lux !== null && lux > quote.maxLux)
        quote.error = `That's more than you have on ${from} after its network fee. You can send up to ${formatDusk(quote.maxLux)}.`;
    }
  }
  const fees = routeDuskFees(route, ctx);
  rows.push(
    { key: "send", label: "You send", value: lux === null ? "—" : `${formatDusk(lux)} on ${from}` },
    {
      detail: `step 1 · on ${from}, paid by you`,
      key: "fee",
      label: "Network fee",
      value: l2Fee === null ? "paid in DUSK" : aboutFee(l2Fee, 18, "DUSK"),
    },
    {
      detail: `${feeText(fees.prove).detail} each · prove and claim on ${to}, paid by you`,
      key: "fee-dusk",
      label: "Then, on Dusk",
      value: `up to ${formatMaxFee(fees.claim.maxLux)} DUSK per step`,
    },
    { key: "bridge", label: "Bridge fee", value: "None" },
    { key: "receive", label: "You receive", strong: true, value: lux === null ? "—" : `${formatDusk(lux)} on ${to}` },
    { key: "arrives", label: "Arrives", value: arrivalText(route, cfg) },
  );
  return quote;
}
