// What each wallet popup will show, line by line in the popup's order, with
// the raw values decoded next to them: the review lists these before the
// popup opens, so every line can be compared. Wallets word things their own
// way, so the labels are the fields every wallet shows.

import { sha256Hex, toHex } from "./data-driver.js";
import { aboutFee, formatDusk, formatFee, formatLux, formatUnitsGrouped } from "./format.js";
import { networkName } from "./names.js";

const WEI_PER_LUX = 1_000_000_000n;

/** "40 bytes · sha256=1f2e3d4c5b6a…01234567", as Dusk Wallet prints call arguments. */
export async function argsSummary(bytes) {
  const data = Uint8Array.from(bytes);
  const hash = await sha256Hex(data);
  return `${data.length} bytes · sha256=${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

const chainLine = (cfg, network) => {
  const chainId = network === "dusk-evm" ? cfg.duskEvm.chainId : cfg.evmNetworks[network].chainId;
  return { label: "Network", value: `${networkName(cfg, network)}, chain ${chainId}` };
};

const maxFee = (gas) => BigInt(gas.limit) * BigInt(gas.price);

/** Dusk Wallet's fee rows: the most it can cost, then everything that can leave. */
const feeLines = (gas, spentLux) => [
  {
    label: "Network fee (max)",
    note: `Limit ${formatUnitsGrouped(BigInt(gas.limit), 0)} at ${formatUnitsGrouped(BigInt(gas.price), 0)} Lux. Only the gas used is charged.`,
    value: formatDusk(maxFee(gas)),
  },
  { label: "Total (max)", value: formatDusk(BigInt(spentLux) + maxFee(gas)) },
];

/** The network Dusk Wallet shows first: its name and chain ID. */
const duskNetworkLine = (network) =>
  network ? [{ label: "Network", value: `${network.name}, ${network.chainId}` }] : [];

const evmFeeLine = (fee, coin) => ({
  label: "Network fee",
  value: fee === null || fee === undefined ? `shown by your wallet, paid in ${coin}` : aboutFee(fee, 18, coin),
});

/** Approve: the migration contract may take exactly this amount of old DUSK. */
export function approveLines({ amountLux, cfg, fee, network }) {
  const chain = cfg.evmNetworks[network];
  return [
    chainLine(cfg, network),
    { address: chain.tokenContract, label: "Token", network, value: "Old DUSK" },
    { address: chain.migrationContract, label: "Spender", network, value: "Dusk migration contract" },
    {
      label: "Spending cap",
      note: "Exactly this transfer, no more.",
      value: `${formatLux(amountLux)} old DUSK`,
    },
    evmFeeLine(fee, chain.currency?.symbol ?? "ETH"),
  ];
}

/** Migrate: the old DUSK goes into the contract, naming the Dusk account to pay. */
export function migrateLines({ amountLux, cfg, duskAccount, fee, network }) {
  const chain = cfg.evmNetworks[network];
  const wei = BigInt(amountLux) * WEI_PER_LUX;
  return [
    chainLine(cfg, network),
    { address: chain.migrationContract, label: "Interacting with", network, value: "Dusk migration contract" },
    { label: "Function", mono: true, value: "migrate" },
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
    { label: "Estimated change", value: `−${formatLux(amountLux)} old DUSK` },
    evmFeeLine(fee, chain.currency?.symbol ?? "ETH"),
  ];
}

/** The DuskEVM step of a withdrawal: the L2 bridge call with the DUSK as its value. */
export function withdrawLines({ amountLux, cfg, duskAccount, fee }) {
  return [
    chainLine(cfg, "dusk-evm"),
    { address: cfg.duskEvm.l2StandardBridgeAddress, label: "Interacting with", network: "dusk-evm", value: "Bridge on DuskEVM" },
    { label: "Amount", value: formatDusk(amountLux) },
    { label: "Function", mono: true, value: "bridgeETHTo" },
    {
      address: duskAccount,
      label: "Recipient on Dusk",
      network: "dusk",
      note: "Inside the call's data, so the wallet shows it as bytes.",
    },
    evmFeeLine(fee, "DUSK"),
  ];
}

/** A public transfer in Dusk Wallet, in its order. */
export function duskTransferLines({ amountLux, from, gas, memo, network, to }) {
  return [
    ...duskNetworkLine(network),
    { address: from, label: "From", network: "dusk" },
    { label: "Privacy", value: "Public" },
    { address: to, label: "To", network: "dusk" },
    { label: "Amount", value: formatDusk(amountLux) },
    { label: "Memo", mono: true, note: "Where the bridge pays out. It must be your address.", value: memo },
    ...feeLines(gas, amountLux),
  ];
}

/** A contract call in Dusk Wallet, in its order: the arguments show as bytes and their hash. */
export async function duskCallLines({ contractId, depositLux = 0n, display, fnArgs, fnName, from, gas, network, note }) {
  return [
    ...duskNetworkLine(network),
    { address: from, label: "From", network: "dusk" },
    { label: "Contract", mono: true, note, value: `0x${String(contractId).replace(/^0x/iu, "")}` },
    { label: "Privacy", value: "Public" },
    { label: "Function", mono: true, value: fnName },
    { label: "Args (opaque bytes)", mono: true, value: await argsSummary(fnArgs) },
    { label: "Amount", value: formatDusk(0n) },
    { label: "Deposit", value: formatDusk(depositLux) },
    ...feeLines(gas, depositLux),
    ...(display
      ? [
          {
            label: "Site-provided details (unverified)",
            mono: true,
            note: "Written by this page, so the wallet can't check them.",
            value: JSON.stringify(display),
          },
        ]
      : []),
  ];
}

export const bytesHex = (bytes) => `0x${toHex(bytes)}`;
