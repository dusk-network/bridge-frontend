// What each wallet window will show, in its order, so the review can list it
// before the window opens and every line can be compared. EVM wallets word
// things their own way, so their labels are the fields every wallet shows.
// Dusk Wallet's lines are its approval windows' own words and number forms:
// what each window shows before anything in it is opened (its raw call data
// and its Details stay folded), group by group. A `head` line is the window's
// title, amount and recipient; `gap` starts the window's next group.

import { labelFor, networkFor, networks, routes } from "@dusk-network/networks";
import { formatContractId, formatEvmAddress, shortAccount } from "@dusk-network/networks/format";

import { decodeDepositArgs } from "./dusk-deposit.js";
import { sha256Hex } from "./data-driver.js";
import { aboutFee, formatDusk, formatLux, formatMaxFee } from "./format.js";
import { networkName, tokenName } from "./names.js";
import { normalizeEvmAddress } from "./validation.js";

const WEI_PER_LUX = 1_000_000_000n;

/**
 * A bridge account on Dusk as Dusk Wallet knows it: one of its network's
 * service routes in @dusk-network/networks, as the wallet reads them, with
 * the chain it pays out on as the window names it, the bridge's fee, and
 * whether it pays out there now. Null for any other account: a transfer to
 * one shows as "Bridge to <chain>", to any other as "Pay".
 */
function walletServiceRoute(chainId, account) {
  const net = networkFor(chainId);
  const route = net ? routes(net).find((item) => item.kind === "service" && item.account === account) : null;
  return route ? { chain: route.chain.name, feeLux: route.feeLux, network: route.chain.id, running: route.running } : null;
}

/**
 * The DuskEVM bridge contracts whose calls Dusk Wallet reads, by network:
 * those its network's file lists, on networks with DuskEVM (Testnet only,
 * for now). Their windows say what the call does; any other call shows as
 * bytes.
 */
export const DUSK_WALLET_BRIDGE_CONTRACTS = Object.freeze(
  Object.fromEntries(
    Object.values(networks)
      .filter((net) => net.duskEvm)
      .map(({ chainId, duskEvm: { contracts } }) => [
        `dusk:${chainId}`,
        Object.freeze({ bridge: contracts.l1_standard_bridge.contractId, portal: contracts.optimism_portal.contractId }),
      ]),
  ),
);

const PORTAL_CALLS = Object.freeze({
  finalizeWithdrawalTransaction: "claim",
  proveWithdrawalTransaction: "prove",
});

export const OLDER_WALLET_NOTE = "Older Dusk Wallet versions show the call as bytes; check the sha256.";

/** "40 bytes · sha256=1f2e3d4c5b6a…01234567", as Dusk Wallet prints call data. */
export async function argsSummary(bytes) {
  const data = Uint8Array.from(bytes);
  const hash = await sha256Hex(data);
  return `${data.length} bytes · sha256=${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

// ---- Dusk Wallet's forms ----------------------------------------------------

/**
 * A maximum, fee or total, as Dusk Wallet writes it: exact to 4 decimals,
 * rounded up past them so it never reads lower than it can be, trailing
 * zeros trimmed.
 */
export const walletFee = (lux) => `${formatMaxFee(lux)} DUSK`;

/** A withdrawal's amount: DuskEVM counts 18 decimals, Dusk 9. Anything finer than a Lux keeps all 18. */
export function withdrawalAmount(wei) {
  const value = BigInt(wei);
  if (value % WEI_PER_LUX === 0n) return `${formatLux(value / WEI_PER_LUX)} DUSK`;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/u, "");
  return `${value / 10n ** 18n}.${fraction} DUSK`;
}

const bare = (id) => String(id ?? "").replace(/^0x/iu, "").toLowerCase();

// ---- EVM wallets ------------------------------------------------------------

const chainLine = (cfg, network) => {
  const chainId = network === "dusk-evm" ? cfg.duskEvm.chainId : cfg.evmNetworks[network].chainId;
  return { label: "Network", value: `${networkName(cfg, network)}, chain ${chainId}` };
};

const evmFeeLine = (fee, coin) => ({
  label: "Network fee",
  value: fee === null || fee === undefined ? `shown by your wallet, paid in ${coin}` : aboutFee(fee, 18, coin),
});

/** Approve: the migration contract may take exactly this amount of ERC20 or BEP20 DUSK. */
export function approveLines({ amountLux, cfg, fee, network }) {
  const chain = cfg.evmNetworks[network];
  return [
    chainLine(cfg, network),
    { address: chain.tokenContract, label: "Token", network, value: tokenName(network) },
    { address: chain.migrationContract, label: "Spender", network, value: "Dusk migration contract" },
    {
      label: "Spending cap",
      note: "Exactly this transfer, no more.",
      value: `${formatLux(amountLux)} ${tokenName(network)}`,
    },
    evmFeeLine(fee, chain.currency?.symbol ?? "ETH"),
  ];
}

/** Migrate: the ERC20 or BEP20 DUSK goes into the contract, naming the Dusk account to pay. */
export function migrateLines({ amountLux, cfg, duskAccount, fee, network }) {
  const chain = cfg.evmNetworks[network];
  const wei = BigInt(amountLux) * WEI_PER_LUX;
  return [
    chainLine(cfg, network),
    { address: chain.migrationContract, label: "Interacting with", network, value: "Dusk migration contract" },
    { label: "Method", mono: true, value: "migrate" },
    {
      label: "amount",
      mono: true,
      note: `= ${formatLux(amountLux)} DUSK. Wallets show it with 18 decimals, so 18 more digits than you typed. That is normal.`,
      value: wei.toString(),
    },
    {
      address: duskAccount,
      label: "mainnetDuskAddress",
      network: "dusk",
      note: "Your Dusk account that receives the DUSK. The contract calls it mainnetDuskAddress on every network.",
    },
    { label: "Estimated change", value: `−${formatLux(amountLux)} ${tokenName(network)}` },
    evmFeeLine(fee, chain.currency?.symbol ?? "ETH"),
  ];
}

/** The DuskEVM step of a withdrawal: the L2 bridge call with the DUSK as its value. */
export function withdrawLines({ amountLux, cfg, duskAccount, fee }) {
  return [
    chainLine(cfg, "dusk-evm"),
    { address: cfg.duskEvm.predeploys.l2StandardBridge, label: "Interacting with", network: "dusk-evm", value: "Bridge on DuskEVM" },
    { label: "Amount", value: formatDusk(amountLux) },
    { label: "Method", mono: true, value: "bridgeETHTo" },
    {
      address: duskAccount,
      label: "Recipient on Dusk",
      network: "dusk",
      note: "Inside the call's data, so the wallet shows it as bytes.",
    },
    evmFeeLine(fee, "DUSK"),
  ];
}

// ---- Dusk Wallet ------------------------------------------------------------

const maxFee = (gas) => BigInt(gas.limit) * BigInt(gas.price);

/** The fee group: the most it can cost, then everything that can leave. */
const feeLines = (gas, spentLux) => [
  { gap: true, label: "Network fee", value: `up to ${walletFee(maxFee(gas))}` },
  { label: "Total", value: `up to ${walletFee(BigInt(spentLux) + maxFee(gas))}` },
];

/**
 * The paying account and its rail: "alice.dusk · Public" by the .dusk name
 * Dusk Wallet sent, or "21n5nc…fMMLNz · Public" without one.
 */
const fromLine = (from, name = "") =>
  name
    ? { full: from, label: "From", suffix: "Public", value: name }
    : { full: from, label: "From", mono: true, note: "Or your .dusk name, if you have one.", suffix: "Public", value: shortAccount(from) };

// Under Details, folded as the window folds them: the method, the call
// data's size and hash, and the site's own words.
const siteLine = (display) =>
  display === undefined || display === null
    ? []
    : [{ fold: true, label: "From the site, not checked by the wallet", mono: true, value: JSON.stringify(display) }];

/**
 * The call as a person checks it, the contract and what it sends; its method
 * and hash under Details. The contract reads as the window writes it: by the
 * name its network gives it, then its ID without 0x, 6…6.
 */
async function callRows({ chainId, contractId, depositLux, fnArgs, fnName, from, fromName, note, read }) {
  const id = formatContractId(contractId);
  const net = networkFor(chainId);
  const name = net ? labelFor(net, id) : null;
  return [
    ...(from ? [fromLine(from, fromName)] : []),
    { full: id, gap: !from, label: "Contract", mono: true, ...(name ? { name } : { note }), value: formatContractId(id, { short: true }) },
    ...(depositLux > 0n ? [{ label: "Deposit", value: `${formatLux(depositLux)} DUSK` }] : []),
    { fold: true, label: "Method", mono: true, value: fnName },
    {
      fold: true,
      label: "Call data",
      mono: true,
      note: read ? OLDER_WALLET_NOTE : "Dusk Wallet shows this call as bytes; check the sha256.",
      value: await argsSummary(fnArgs),
    },
  ];
}

/**
 * What the call is to Dusk Wallet: a deposit to DuskEVM, a withdrawal's
 * proof or claim, or null when it shows the call as bytes.
 */
export function bridgeCallKind({ chainId, contractId, fnName }) {
  const known = DUSK_WALLET_BRIDGE_CONTRACTS[chainId];
  if (!known) return null;
  if (bare(contractId) === known.bridge && fnName === "depositETHToWithValue") return "deposit";
  if (bare(contractId) === known.portal) return PORTAL_CALLS[fnName] ?? null;
  return null;
}

/** A deposit's amount and DuskEVM recipient, or null when its arguments don't read as one. */
function readDeposit(fnArgs) {
  try {
    return decodeDepositArgs(fnArgs);
  } catch {
    return null;
  }
}

/**
 * What a proof or claim pays and to whom, as Dusk Wallet reads it: a Dusk
 * account or a contract's 64-hex ID, an amount the same in the withdrawal and
 * its message, and the DuskEVM sender. Null when the window can't read it.
 */
function readWithdrawal(withdrawal) {
  const recipient = String(withdrawal?.recipient ?? "");
  if (!recipient || withdrawal.amountWei === undefined || !withdrawal.from) return null;
  if (withdrawal.value !== undefined && BigInt(withdrawal.value) !== BigInt(withdrawal.amountWei)) return null;
  return {
    amount: withdrawalAmount(withdrawal.amountWei),
    pays: /^[0-9a-f]{64}$/u.test(recipient) ? { contractId: recipient } : { account: recipient },
    sender: normalizeEvmAddress(withdrawal.from),
  };
}

/** Whether Dusk Wallet reads `memo` as an EVM address: 0x and 40 hex digits, mixed case only with its checksum. */
const walletReadsAddress = (memo) =>
  /^0x(?:[0-9a-f]{40}|[0-9A-F]{40})$/u.test(memo) || (/^0x[0-9a-fA-F]{40}$/u.test(memo) && formatEvmAddress(memo) === memo);

/**
 * A public transfer, as Dusk Wallet's window shows it. To a bridge account
 * it knows (walletServiceRoute): "Bridge to <chain>", the amount
 * to the memo's address there, and what arrives once the bridge takes its
 * fee, or that nothing does; then the fee, and who pays, the bridge's
 * account and the recipient there. To any other account: "Pay", with the
 * memo last.
 */
export function duskTransferLines({ amountLux, chainId, from, fromName = "", gas, memo, to }) {
  const service = walletServiceRoute(chainId, to);
  if (!service)
    return [
      { amount: `${formatLux(amountLux)} DUSK`, kind: "head", title: "Pay", to: shortAccount(to), toFull: to },
      ...feeLines(gas, amountLux),
      { ...fromLine(from, fromName), gap: true },
      { address: to, label: "To", network: "dusk" },
      { label: "Memo", mono: true, note: "Where the bridge pays out. It must be your address.", value: memo },
    ];
  const { chain } = service;
  const sent = BigInt(amountLux);
  const arrivesLux = sent > service.feeLux ? sent - service.feeLux : 0n;
  const recipient = String(memo ?? "").trim();
  const recipientOk = walletReadsAddress(recipient);
  const arrives =
    !service.running || arrivesLux <= 0n
      ? `Nothing arrives on ${chain}`
      : recipientOk
        ? `${formatLux(arrivesLux)} DUSK arrives on ${chain}`
        : `Nothing arrives without ${/^[aeiou]/iu.test(chain) ? "an" : "a"} ${chain} address in the memo`;
  return [
    {
      amount: `${formatLux(sent)} DUSK`,
      kind: "head",
      sub: `${formatLux(sent)} DUSK sent · ${formatLux(service.feeLux)} DUSK bridge fee · ${arrives}`,
      tag: "Known bridge account",
      title: `Bridge to ${chain}`,
      ...(recipientOk ? { to: formatEvmAddress(recipient, { short: true }), toFull: recipient, where: `on ${chain}` } : {}),
    },
    ...feeLines(gas, sent),
    { ...fromLine(from, fromName), gap: true },
    { address: to, label: "To", network: "dusk", value: `The bridge's account for ${chain}` },
    recipientOk
      ? { address: recipient, label: `Recipient on ${chain}`, network: service.network }
      : { label: `Recipient on ${chain}`, mono: true, value: recipient || "(none)" },
  ];
}

/**
 * A contract call, as Dusk Wallet's window for it shows it. Calls to the
 * DuskEVM bridge it knows lead with what they do, read from their arguments
 * (`withdrawal` is the withdrawal a proof or claim carries); any other call
 * shows as its bytes and their hash.
 */
export async function duskCallLines({ chainId, contractId, depositLux = 0n, display, fnArgs, fnName, from, fromName = "", gas, note, withdrawal }) {
  const deposit = BigInt(depositLux ?? 0n);
  const kind = bridgeCallKind({ chainId, contractId, fnName });
  const call = { chainId, contractId, depositLux: deposit, fnArgs, fnName, fromName, note };

  const args = kind === "deposit" ? readDeposit(fnArgs) : null;
  if (args) {
    const amount = `${formatLux(args.amountLux)} DUSK`;
    return [
      {
        amount,
        kind: "head",
        tag: args.amountLux === deposit ? "Known DuskEVM bridge call" : "",
        title: "Bridge to DuskEVM",
        to: formatEvmAddress(args.to, { short: true }),
        toFull: args.to,
        where: "on DuskEVM",
      },
      { address: args.to, label: "DuskEVM recipient", network: "dusk-evm" },
      { label: "Amount", value: amount },
      fromLine(from, fromName),
      ...feeLines(gas, deposit),
      ...(await callRows({ ...call, read: true })),
      ...siteLine(display),
    ];
  }

  const read = kind === "prove" || kind === "claim" ? readWithdrawal(withdrawal) : null;
  if (read) {
    const { amount, pays, sender } = read;
    // What it costs leads: it moves none of the account's DUSK. Then the
    // withdrawal it's for and whom that pays.
    return [
      {
        amount: walletFee(maxFee(gas)),
        kind: "head",
        lead: "Costs up to",
        prefix: `for a ${amount} withdrawal that pays`,
        sub:
          kind === "prove"
            ? "Proving moves no DUSK. You claim it once the waiting period ends."
            : "Claiming pays this DUSK to the account above. You pay only the network fee.",
        tag: "Known DuskEVM bridge call",
        title: kind === "prove" ? "Prove a DuskEVM withdrawal" : "Claim a DuskEVM withdrawal",
        to: pays.account ? shortAccount(pays.account) : formatContractId(pays.contractId, { short: true }),
        toFull: pays.account ?? pays.contractId,
        where: pays.account ? "on Dusk" : "on Dusk, a contract",
      },
      pays.account
        ? { address: pays.account, label: "Pays to", network: "dusk" }
        : { label: "Pays to contract", mono: true, value: pays.contractId },
      { label: "Amount", value: amount },
      { address: sender, label: "Sent from DuskEVM", network: "dusk-evm" },
      ...feeLines(gas, deposit),
      ...(await callRows({ ...call, read: true })),
      ...siteLine(display),
    ];
  }

  // Any other call: "Contract call", with what it sends and its method.
  return [
    { amount: deposit > 0n ? `${formatLux(deposit)} DUSK` : "", kind: "head", title: "Contract call" },
    ...(await callRows({ ...call, from, read: false })),
    ...feeLines(gas, deposit),
    ...siteLine(display),
  ];
}
