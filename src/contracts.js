// The Contracts sheet: every address and contract ID each route uses, in
// full, from the deployment's own config, with explorer links where the
// explorer has a page. An operator is named only when the deployment names
// one; nothing here is inferred.

import { NAME_FILE_HOSTS } from "./dusk-names.js";
import { OldTokenName, networkNames } from "./names.js";

export const L2_TO_L1_MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

const trim = (url) => String(url ?? "").replace(/\/+$/u, "");

/** An address's page on its explorer, or null when there is none. */
export function explorerAddressUrl(cfg, network, address) {
  if (!address) return null;
  if (network === "dusk")
    // The Dusk explorer has pages for accounts, not for contracts.
    return /^[1-9A-HJ-NP-Za-km-z]{60,}$/u.test(address) ? `${trim(cfg.dusk.explorerUrl)}/accounts/?key=${address}` : null;
  const explorer = network === "dusk-evm" ? cfg.duskEvm.explorerUrl : cfg.evmNetworks[network]?.explorerUrl;
  return explorer ? `${trim(explorer)}/address/${address}` : null;
}

const row = (cfg, network, label, value, note = "") => ({
  href: explorerAddressUrl(cfg, network, value),
  label,
  network,
  note,
  value,
});

/**
 * A Dusk contract, its ID written as Dusk Wallet writes it: 0x and the full
 * 64 hex characters, lower case. The copy button copies the same.
 */
export const duskContractId = (id) => `0x${String(id ?? "").replace(/^0x/iu, "").toLowerCase()}`;
const contractRow = (cfg, label, id, note = "") => row(cfg, "dusk", label, duskContractId(id), note);

/** The sheet's groups: the networks, then one group per route. */
export function contractGroups(cfg) {
  const names = networkNames(cfg);
  const groups = [];

  const networks = [{ label: names.dusk, value: cfg.dusk.chainId }];
  networks.push(
    cfg.duskEvm.enabled
      ? { label: names["dusk-evm"], value: `chain ${cfg.duskEvm.chainId}` }
      : { label: names["dusk-evm"], muted: true, value: `not on ${names.badge} yet` },
  );
  const evmIds = [...new Set([...cfg.migrations, ...(cfg.service ? [cfg.service.network] : [])])];
  for (const id of evmIds) networks.push({ label: names[id], value: `chain ${cfg.evmNetworks[id].chainId}` });
  groups.push({ id: "networks", rows: networks, title: "Networks" });

  for (const id of cfg.migrations) {
    const network = cfg.evmNetworks[id];
    groups.push({
      docs: cfg.links?.docs?.migration,
      id: `migration-${id}`,
      operator: cfg.operators?.migration || "",
      rows: [
        row(cfg, id, "Migration contract", network.migrationContract, "Keeps the old DUSK locked. It has no function to send them out."),
        row(cfg, id, OldTokenName(cfg, id), network.tokenContract),
      ],
      title: `Old DUSK from ${names[id]}`,
    });
  }

  if (cfg.service) {
    const network = cfg.evmNetworks[cfg.service.network];
    const rows = [
      row(cfg, "dusk", "Bridge account on Dusk", cfg.service.account, "Receives the DUSK you send. The memo names where it pays out."),
      row(cfg, cfg.service.network, OldTokenName(cfg, cfg.service.network), network.tokenContract, "What the bridge pays out: the same token the migration takes."),
    ];
    if (cfg.service.payoutAddress)
      rows.push(row(cfg, cfg.service.network, "Pays out from", cfg.service.payoutAddress));
    groups.push({
      docs: cfg.links?.docs?.service,
      id: "service",
      operator: cfg.operators?.service || "",
      rows,
      title: `Dusk to ${names[cfg.service.network]}`,
    });
  }

  if (cfg.duskEvm.enabled)
    groups.push({
      docs: cfg.links?.docs?.duskEvm,
      id: "duskevm",
      operator: cfg.operators?.duskEvm || "",
      rows: [
        contractRow(cfg, "Bridge contract on Dusk", cfg.duskEvm.l1StandardBridgeContractId, "Takes deposits, and holds the DUSK that is on DuskEVM."),
        contractRow(cfg, "Withdrawal portal on Dusk", cfg.duskEvm.optimismPortalContractId, "Checks proofs and releases claims."),
        contractRow(cfg, "Dispute game factory on Dusk", cfg.duskEvm.disputeGameFactoryContractId),
        row(cfg, "dusk-evm", "Bridge on DuskEVM", cfg.duskEvm.l2StandardBridgeAddress),
        row(cfg, "dusk-evm", "Message passer on DuskEVM", L2_TO_L1_MESSAGE_PASSER),
      ],
      title: `${names.dusk} and ${names["dusk-evm"]}`,
    });

  if (cfg.multicall?.contractId)
    groups.push({
      id: "reads",
      rows: [contractRow(cfg, "Multicall for Dusk", cfg.multicall.contractId, "Batches this page's reads of Dusk contracts.")],
      title: "Used to read Dusk",
    });

  return groups;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/** In one line, the servers this page reads from and what for. */
export function serversLine(cfg) {
  const names = networkNames(cfg);
  const parts = [`${hostOf(cfg.dusk.nodeUrl)} (the Dusk node and its archive)`];
  if (cfg.duskEvm.enabled) parts.push(`${hostOf(cfg.duskEvm.rpcUrl)} (${names["dusk-evm"]})`);
  const evmIds = [...new Set([...cfg.migrations, ...(cfg.service ? [cfg.service.network] : [])])];
  for (const id of evmIds) {
    const host = hostOf(cfg.evmNetworks[id]?.rpcUrl);
    if (host) parts.push(`${host} (${names[id]})`);
  }
  const nameHost = NAME_FILE_HOSTS[cfg.dusk.chainId];
  if (nameHost) parts.push(`${nameHost} (for .dusk names)`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `This page reads from ${list}.`;
}
