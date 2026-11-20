// The quote under the amount: what you send, the network fee as a maximum
// and its usual cost, the bridge fee, what you receive and when. Pure: the
// balances, prices and gas estimates come in, so it's the same before and
// after the wallet opens.

import { normalizeAmount, parseDusk, unclearAmount } from "@dusk-network/app-core/amounts";
import { beforeProofText, claimAfterProving, claimText } from "@dusk-network/networks/duskevm";
import { DEPOSIT_GAS, TRANSFER_GAS, WITHDRAWAL_GAS, withdrawalGasLimit as withdrawalStepGas } from "@dusk-network/networks/gas";

import { aboutFee, decimalSeparator, formatDateTime, formatDusk, formatLux, formatMaxFee, formatShort, formatToken, formatTypicalFee, formatUnitsGrouped } from "./format.js";
import { HYPERLANE_GAS, U64_MAX } from "./hyperlane.js";
import { gasCoin, networkName, routeUnits, tokenName } from "./names.js";
import { routeTime, routeTimeText } from "./route-times.js";

const WEI_PER_LUX = 1_000_000_000n;

/**
 * The typed amount in plain form, or why it can't be read. One that could
 * mean either of two amounts ("1,234") is asked about, so what is sent never
 * differs from what was meant.
 */
function plainTyped(value) {
  const decimal = decimalSeparator();
  const either = unclearAmount(value, decimal);
  if (either) {
    const instead = decimal === "," ? "point, or with a comma for decimals" : "comma";
    return { error: `Is that ${either.grouped} or ${either.decimal}? Write it without the ${instead}.` };
  }
  const plain = normalizeAmount(value, decimal);
  if (plain.includes(",")) {
    return { error: decimal === "," ? "Use a comma for decimals, like 0,5." : "Use a point for decimals, like 0.5." };
  }
  return { value: plain };
}

/** Plain digits with a point as a whole number of units with `decimals`, or null. */
function parseUnits(plain, decimals) {
  if (decimals === 9) return parseDusk(plain);
  if (!/^(\d+(\.\d*)?|\.\d+)$/u.test(plain)) return null;
  const [whole, fraction = ""] = plain.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/**
 * The typed amount in the smallest unit of what's sent, Lux for DUSK, or why
 * it can't be one; `decimals` are the token's, 9 for DUSK. Empty is no error.
 */
export function parseAmount(input, decimals = 9) {
  const read = plainTyped(String(input ?? "").trim());
  if (read.error) return { error: read.error, lux: null };
  const { value } = read;
  if (!value) return { error: "", lux: null };
  const lux = parseUnits(value, decimals);
  if (lux === null) {
    return /^\d*\.\d+$/u.test(value)
      ? { error: `Max ${decimals} decimals`, lux: null }
      : { error: `Enter an amount like 25 or 0${decimalSeparator()}5.`, lux: null };
  }
  if (lux <= 0n) return { error: "Enter an amount above 0.", lux: null };
  return { error: "", lux };
}

/** The Dusk fee of one transaction: the most it can cost, and the usual. */
export function duskFee(limit, typical, gasPrice) {
  const price = BigInt(gasPrice ?? 1n) > 0n ? BigInt(gasPrice) : 1n;
  return { maxLux: BigInt(limit) * price, typicalLux: BigInt(typical) * price };
}

/** The most a Dusk fee can be: what a Dusk Wallet window asks for. */
/** The most a Dusk fee can be, what a Dusk Wallet window asks for, and what it usually comes to. */
const feeText = ({ maxLux, typicalLux }) => ({ detail: `usually ~${formatTypicalFee(typicalLux)} DUSK`, value: `up to ${formatMaxFee(maxLux)} DUSK` });

/**
 * What each Dusk-side step of a route costs at most, and usually. A proof
 * and a claim share one limit (`withdrawalStepGas`): the withdrawal's own
 * gas on top, at least a bound above what the bridge's withdrawals ask for.
 */
export function routeDuskFees(route, { gasPrice = 1n, withdrawalGas = 0n } = {}) {
  if (route.mode === "duskevm-deposit")
    return { send: duskFee(DEPOSIT_GAS.limit, DEPOSIT_GAS.typical, gasPrice) };
  if (route.mode === "service-transfer")
    return { send: duskFee(TRANSFER_GAS.limit, TRANSFER_GAS.typical, gasPrice) };
  if (route.mode === "duskevm-withdrawal") {
    const step = duskFee(withdrawalStepGas(withdrawalGas), WITHDRAWAL_GAS.typical, gasPrice);
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

/**
 * When it arrives, as a quote row: none where this network's time isn't
 * known. Nothing arrives from DuskEVM without the two steps on Dusk, so a
 * withdrawal says when it can be claimed: sent now and proved about an
 * output later, "Claim from about 5 Nov, 12:28 CET", or, before the chain's
 * times are read, "Claim 7 days after you prove." The date waits for the
 * longer of the proof's maturity and the game's finality (`wait`), as the
 * Portal does. The card's route line says the steps' times.
 */
function arrivesRow(route, cfg, { locale, timeZone, timing } = {}) {
  const time = routeTime(route, cfg, timing);
  if (route.mode === "duskevm-withdrawal") {
    if (!time?.maturity) return [];
    if (!time.prove) return [{ key: "when", label: "When", value: claimAfterProving(time.maturity) }];
    const now = timing?.now ?? Date.now();
    const at = now + (time.prove + (time.wait ?? time.maturity)) * 1_000;
    const when = (ms) => formatDateTime(ms, { locale, now, timeZone });
    return [{ detail: beforeProofText(time), key: "when", label: "When", value: claimText({ at, exact: false }, when) }];
  }
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
 * @param {string} [ctx.locale] for tests: whose clock a date is written on; the viewer's otherwise
 * @param {string} [ctx.timeZone] for tests; the viewer's own otherwise
 */
export function buildQuote(route, amount, ctx) {
  if (route.mode === "hyperlane") return hyperlaneQuote(route, amount, ctx);
  const { cfg } = ctx;
  const to = networkName(cfg, route.to.id);
  const from = networkName(cfg, route.from.id);
  const parsed = parseAmount(amount);
  const lux = parsed.lux;
  const rows = [];
  const quote = { amountLux: lux, error: parsed.error, feeOverAmount: false, maxLux: null, receiveLux: lux, rows };
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
        quote.error = `Send more than the ${formatDusk(bridgeFee)} bridge fee`;
      else if (quote.maxLux !== null && lux > quote.maxLux) {
        quote.insufficient = true;
        quote.error = `That's more than you have after the network fee. You can send up to ${formatDusk(quote.maxLux)}.`;
      }
    }
    // One line a row; a fee the route doesn't have isn't listed.
    rows.push(
      { key: "send", label: "You send", value: shown(lux) },
      ...(bridgeFee ? [{ key: "bridge", label: "Bridge fee", value: `${formatDusk(bridgeFee)}, from the amount` }] : []),
      { key: "fee", label: "Network fee", ...feeText(fee) },
      {
        key: "receive",
        label: "You receive",
        strong: true,
        value: receive === null || receive <= 0n ? "—" : `${formatLux(receive)} ${routeUnits(route).receive} on ${to}`,
      },
      ...arrivesRow(route, cfg, ctx),
    );
    // The fees as one figure: the bridge's, taken from the amount, and the network's, on top.
    quote.fees = bridgeFee
      ? { detail: `${formatDusk(bridgeFee)} of it from the amount`, key: "fees", label: "Fees", value: `up to ${formatMaxFee(bridgeFee + fee.maxLux)} DUSK` }
      : { key: "fees", label: "Network fee", value: `up to ${formatMaxFee(fee.maxLux)} DUSK` };
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
      { detail: steps === 2 ? "two wallet steps" : "one wallet step", key: "fee", label: "Network fee", value: evmFee === null ? `paid in ${coin}` : aboutFee(evmFee, 18, coin) },
      { key: "receive", label: "You receive", strong: true, value: lux === null ? "—" : `${formatDusk(lux)} on ${to}` },
      ...arrivesRow(route, cfg, ctx),
    );
    return quote;
  }

  // DuskEVM to Dusk: one step on DuskEVM, then prove and claim on Dusk.
  const l2Fee = gas.priceWei && gas.withdraw ? BigInt(gas.withdraw) * BigInt(gas.priceWei) : null;
  quote.evmFeeWei = l2Fee;
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
    { key: "fee", label: "Network fee", value: l2Fee === null ? "paid in DUSK" : aboutFee(l2Fee, 18, "DUSK") },
    { key: "fee-dusk", label: "Prove and claim", value: `up to ${formatMaxFee(withdrawalStepMax({ gasPrice: ctx.gasPrice ?? 1n }))} DUSK each` },
    { key: "receive", label: "You receive", strong: true, value: lux === null ? "—" : `${formatDusk(lux)} on ${to}` },
    ...arrivesRow(route, cfg, ctx),
  );
  // The fees as one figure: DuskEVM's now, then the most the proof and the claim on Dusk can cost.
  quote.fees = {
    key: "fees",
    label: "Fees",
    value: `${l2Fee === null ? "paid in DUSK" : aboutFee(l2Fee, 18, "DUSK")}, then up to ${formatMaxFee(2n * withdrawalStepMax({ gasPrice: ctx.gasPrice ?? 1n }))} DUSK on Dusk`,
  };
  return quote;
}

/** Gas for a transfer to the EVM chain on Dusk, with an approval first where the route can't take the amount yet. */
export function hyperlaneDuskFees({ approves = false, gasPrice = 1n } = {}) {
  const send = duskFee(HYPERLANE_GAS.transfer.limit, HYPERLANE_GAS.transfer.typical, gasPrice);
  if (!approves) return send;
  const approve = duskFee(HYPERLANE_GAS.approve.limit, HYPERLANE_GAS.approve.typical, gasPrice);
  return { maxLux: send.maxLux + approve.maxLux, typicalLux: send.typicalLux + approve.typicalLux };
}

/**
 * A Hyperlane route's quote, in its token's smallest unit (`amountLux`,
 * `maxLux` and `receiveLux` are Lux for DUSK). From Dusk, the network fee is
 * DUSK's, for an approval first where a token's route may not take the
 * amount yet (`hyperlane.allowance`; until that's read, the steps aren't
 * known and `waiting` says why: "reading", or "failed" where the read
 * failed), and the bridge's fee is the route's
 * own quote for delivering it (`hyperlane.fee`), paid in DUSK on top: the
 * DUSK route takes both with the amount. From the EVM chain, the network fee
 * is its coin's, and the bridge's fee is the token's quote for delivery
 * (`evm.deliveryFeeWei`), sent as the call's value. An amount past a u64
 * can't be carried. Where a fee isn't read yet, it's a dash.
 *
 * @param {object} ctx
 * @param {bigint | null} [ctx.balance] what pays: DUSK on Dusk in Lux, the token on the EVM chain
 * @param {{ fee?: bigint | null, allowance?: bigint | null, tokenBalance?: bigint | null }} [ctx.hyperlane] read on Dusk
 * @param {{ deliveryFeeWei?: bigint | null, gas?: bigint | null, gasCoinWei?: bigint | null, priceWei?: bigint | null }} [ctx.evm] read on the EVM chain
 */
function hyperlaneQuote(route, amount, ctx) {
  const { cfg } = ctx;
  const { token } = route;
  const to = networkName(cfg, route.to.id);
  const parsed = parseAmount(amount, token.decimals);
  const units = parsed.lux !== null && parsed.lux > U64_MAX ? null : parsed.lux;
  const quote = {
    amountLux: units,
    error: parsed.error || (units === null && parsed.lux !== null ? "That's more than one transfer can carry." : ""),
    feeOverAmount: false,
    maxLux: null,
    receiveLux: units,
    rows: [],
    steps: 1,
  };
  const sent = units === null ? "—" : formatToken(units, token);
  const received = { key: "receive", label: "You receive", strong: true, value: units === null ? "—" : `${formatToken(units, token)} on ${to}` };
  const time = routeTimeText(routeTime(route, cfg, ctx.timing));
  const arrives = time ? [{ key: "arrives", label: "Arrives", value: time }] : [];

  if (route.signer === "dusk") {
    const read = ctx.hyperlane ?? {};
    const native = Boolean(route.hyperlane?.native);
    const fee = read.fee ?? null;
    const allowance = read.allowance ?? null;
    // What the route may take already decides the steps: an approval not read
    // yet, or that couldn't be read, decides nothing, and the review waits.
    const unknown = !native && allowance === null;
    const approves = !native && !unknown && (units === null || allowance < units);
    const gas = hyperlaneDuskFees({ approves, gasPrice: ctx.gasPrice });
    const balance = ctx.balance === null || ctx.balance === undefined ? null : BigInt(ctx.balance);
    Object.assign(quote, { bridgeFeeLux: fee, gasMaxLux: gas.maxLux, steps: unknown ? null : approves ? 2 : 1 });
    // DUSK's bridge fee is paid in DUSK, on top: where it's more than what's sent, that's said. It blocks nothing.
    quote.feeOverAmount = native && units !== null && fee !== null && fee > units;
    if (native) {
      if (balance !== null && fee !== null) quote.maxLux = balance > fee + gas.maxLux ? balance - fee - gas.maxLux : 0n;
      if (!quote.error && units !== null && quote.maxLux !== null && units > quote.maxLux) {
        quote.insufficient = true;
        quote.error = `That's more than you have after the fees. You can send up to ${formatDusk(quote.maxLux)}.`;
      }
    } else {
      const held = read.tokenBalance ?? null;
      quote.maxLux = held;
      if (!quote.error && units !== null && held !== null && units > held) {
        quote.insufficient = true;
        quote.error = `That's more than the ${formatToken(held, token)} you have.`;
      } else if (!quote.error && units !== null && balance !== null && fee !== null && balance < fee + gas.maxLux) {
        // The token goes; the fees are DUSK.
        quote.insufficient = true;
        quote.short = "DUSK";
        quote.error = `The fees take up to ${formatDusk(fee + gas.maxLux)}, more than the ${formatDusk(balance)} you have.`;
      }
      if (unknown && units !== null && !quote.error) quote.waiting = read.allowanceFailed ? "failed" : "reading";
    }
    quote.rows.push(
      { key: "send", label: "You send", value: sent },
      { detail: native ? "on top of the amount" : "paid in DUSK", key: "bridge", label: "Bridge fee", value: fee === null ? "—" : formatDusk(fee) },
      { detail: `usually ~${formatTypicalFee(gas.typicalLux)} DUSK${approves ? ", for two wallet steps" : ""}`, key: "fee", label: "Network fee", value: `up to ${formatMaxFee(gas.maxLux)} DUSK` },
      // DUSK goes with its bridge fee in one deposit, which the wallet asks for: the most that leaves.
      ...(native && units !== null && fee !== null ? [{ key: "total", label: "Total", value: `up to ${formatDusk(units + fee + gas.maxLux)}` }] : []),
      received,
      ...arrives,
    );
    // The fees as one figure: the bridge's and the network's, both in DUSK.
    quote.fees = { key: "fees", label: "Fees", value: fee === null ? "—" : `up to ${formatMaxFee(fee + gas.maxLux)} DUSK` };
    return quote;
  }

  // From the EVM chain: one call, with the delivery fee as its value.
  const coin = gasCoin(cfg, route.from.id);
  const evm = ctx.evm ?? {};
  const held = ctx.balance === null || ctx.balance === undefined ? null : BigInt(ctx.balance);
  const fee = evm.deliveryFeeWei ?? null;
  const gasWei = evm.gas && evm.priceWei ? BigInt(evm.gas) * BigInt(evm.priceWei) : null;
  Object.assign(quote, { bridgeFeeWei: fee, evmFeeWei: gasWei, maxLux: held });
  const coins = evm.gasCoinWei ?? null;
  if (!quote.error && units !== null && held !== null && units > held) {
    quote.insufficient = true;
    quote.error = `That's more than the ${formatToken(held, token)} in this wallet.`;
  } else if (!quote.error && units !== null && coins !== null && fee !== null && gasWei !== null && coins < fee + gasWei) {
    quote.insufficient = true;
    quote.short = coin;
    quote.error = `The fees take ${aboutFee(fee + gasWei, 18, coin)}, more than the ${formatShort(coins, 18).text} ${coin} in this wallet.`;
  }
  quote.rows.push(
    { key: "send", label: "You send", value: sent },
    { detail: `paid in ${coin}, with the transfer`, key: "bridge", label: "Bridge fee", value: fee === null ? "—" : aboutFee(fee, 18, coin) },
    { detail: "one wallet step", key: "fee", label: "Network fee", value: gasWei === null ? `paid in ${coin}` : aboutFee(gasWei, 18, coin) },
    received,
    ...arrives,
  );
  // The fees as one figure, both in the chain's coin; the network's once the gas is read.
  quote.fees = {
    key: "fees",
    label: "Fees",
    value: fee === null ? "—" : gasWei === null ? `${aboutFee(fee, 18, coin)} and the network fee` : aboutFee(fee + gasWei, 18, coin),
  };
  return quote;
}
