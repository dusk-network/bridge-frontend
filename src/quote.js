// The quote under the amount: what you send, the network fee as a maximum
// and its usual cost, the bridge fee, what you receive and when. Pure: the
// balances, prices and gas estimates come in, so it's the same before and
// after the wallet opens.

import { claimAfterProving, provingAfterSending } from "./claim-date.js";
import { aboutFee, formatDusk, formatFee, formatLux, formatMaxFee, formatUnitsGrouped } from "./format.js";
import {
  DEPOSIT_GAS_LIMIT,
  DEPOSIT_GAS_TYPICAL,
  TRANSFER_GAS_LIMIT,
  TRANSFER_GAS_TYPICAL,
  WITHDRAWAL_STEP_GAS_TYPICAL,
  withdrawalStepGas,
} from "./gas.js";
import { gasCoin, networkName, routeUnits, tokenName } from "./names.js";
import { routeTime, routeTimeText } from "./route-times.js";

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

/**
 * The most one Dusk step of a withdrawal can cost, its proof or its claim:
 * the one figure the start page, the quote, the review, the receipt and the
 * card all show. The inputs are the node's gas price and, once known, the
 * withdrawal's own gas.
 */
export function withdrawalStepMax({ gasPrice = 1n, withdrawalGas = 0n } = {}) {
  return routeDuskFees({ mode: "duskevm-withdrawal" }, { gasPrice, withdrawalGas }).claim.maxLux;
}

/** "up to 0.051 DUSK a step", as each page writes it. */
export const stepFeeText = (inputs) => `up to ${formatMaxFee(withdrawalStepMax(inputs))} DUSK a step`;

/**
 * When it arrives, as a quote row: none where this network's time isn't
 * known. Nothing arrives from DuskEVM without the two steps on Dusk, so a
 * withdrawal says when they can be taken: "Claim 7 days after you prove. You
 * can prove about 30 minutes after sending."
 */
function arrivesRow(route, cfg, timing) {
  const time = routeTime(route, cfg, timing);
  if (route.mode === "duskevm-withdrawal")
    return time?.maturity
      ? [{ detail: time.prove ? provingAfterSending(time.prove) : "", key: "when", label: "When", value: claimAfterProving(time.maturity) }]
      : [];
  const value = routeTimeText(time);
  return value ? [{ key: "arrives", label: "Arrives", value }] : [];
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
 * @param {object} [ctx.timing] what `routeTime` reads the route's time from
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
        quote.error = `Send more than the ${formatDusk(bridgeFee)} bridge fee.`;
      else if (quote.maxLux !== null && lux > quote.maxLux) {
        quote.insufficient = true;
        quote.error = `That's more than you have after the network fee. You can send up to ${formatDusk(quote.maxLux)}.`;
      }
    }
    // One line a row; a fee the route doesn't have isn't listed.
    rows.push(
      { key: "send", label: "You send", value: shown(lux) },
      { key: "fee", label: "Network fee", ...feeText(fee) },
      ...(bridgeFee ? [{ key: "bridge", label: "Bridge fee", value: `${formatDusk(bridgeFee)}, from the amount` }] : []),
      {
        key: "receive",
        label: "You receive",
        strong: true,
        value: receive === null || receive <= 0n ? "—" : `${formatLux(receive)} ${routeUnits(route).receive} on ${to}`,
      },
      ...arrivesRow(route, cfg, ctx.timing),
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
      if (!quote.error && wei !== null && wei > balance) {
        quote.insufficient = true;
        quote.error = `That's more than the ${formatUnitsGrouped(balance, 18, 9)} ${tokenName(route.from.id)} in this wallet.`;
      }
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
      { key: "send", label: "You send", value: lux === null ? "—" : `${formatLux(lux)} ${tokenName(route.from.id)}` },
      {
        detail: steps === 2 ? "two wallet steps" : "one wallet step",
        key: "fee",
        label: "Network fee",
        value: evmFee === null ? `paid in ${coin}` : aboutFee(evmFee, 18, coin),
      },
      { key: "receive", label: "You receive", strong: true, value: lux === null ? "—" : `${formatDusk(lux)} on ${to}` },
      ...arrivesRow(route, cfg, ctx.timing),
    );
    return quote;
  }

  // DuskEVM to Dusk: one step on DuskEVM, then prove and claim on Dusk.
  const l2Fee = gas.priceWei && gas.withdraw ? BigInt(gas.withdraw) * BigInt(gas.priceWei) : null;
  if (ctx.balance !== null && ctx.balance !== undefined) {
    if (l2Fee === null) {
      // No gas price yet: the fee comes from the same balance, so there's no
      // Max until it's known, and the whole balance is already too much.
      if (!quote.error && lux !== null && lux * WEI_PER_LUX >= BigInt(ctx.balance)) {
        quote.insufficient = true;
        quote.error = `That's more than you have on ${from}, with its network fee.`;
      }
    } else {
      // Keep twice the estimated gas aside, so the wallet's own estimate fits.
      const room = BigInt(ctx.balance) - 2n * l2Fee;
      quote.maxLux = room > 0n ? room / WEI_PER_LUX : 0n;
      if (!quote.error && lux !== null && lux > quote.maxLux) {
        quote.insufficient = true;
        quote.error = `That's more than you have on ${from} after its network fee. You can send up to ${formatDusk(quote.maxLux)}.`;
      }
    }
  }
  rows.push(
    { key: "send", label: "You send", value: lux === null ? "—" : `${formatDusk(lux)} on ${from}` },
    {
      key: "fee",
      label: `Fee on ${from}`,
      value: l2Fee === null ? "paid in DUSK" : aboutFee(l2Fee, 18, "DUSK"),
    },
    {
      detail: "to prove, then to claim",
      key: "fee-dusk",
      label: `Then on ${to}`,
      value: stepFeeText({ gasPrice: ctx.gasPrice ?? 1n }),
    },
    { key: "receive", label: "You receive", strong: true, value: lux === null ? "—" : `${formatDusk(lux)} on ${to}` },
    ...arrivesRow(route, cfg, ctx.timing),
  );
  return quote;
}
