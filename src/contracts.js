// The Contracts sheet: every address and contract ID each route uses, in
// full, from the deployment's own config, with explorer links where the
// explorer has a page. An operator is named only when the deployment names
// one; nothing here is inferred.

import { networkNames } from "./names.js";

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
        row(cfg, id, "Old DUSK token", network.tokenContract),
      ],
      title: `Old DUSK from ${names[id]}`,
    });
  }

  if (cfg.service) {
    const network = cfg.evmNetworks[cfg.service.network];
    const rows = [
      row(cfg, "dusk", "Bridge account on Dusk", cfg.service.account, "Receives the DUSK you send. The memo names where it pays out."),
      row(cfg, cfg.service.network, `DUSK token on ${names[cfg.service.network]}`, network.tokenContract),
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
        row(cfg, "dusk", "Bridge contract on Dusk", cfg.duskEvm.l1StandardBridgeContractId, "Takes deposits, and holds the DUSK that is on DuskEVM."),
        row(cfg, "dusk", "Withdrawal portal on Dusk", cfg.duskEvm.optimismPortalContractId, "Checks proofs and releases claims."),
        row(cfg, "dusk", "Dispute game factory on Dusk", cfg.duskEvm.disputeGameFactoryContractId),
        row(cfg, "dusk-evm", "Bridge on DuskEVM", cfg.duskEvm.l2StandardBridgeAddress),
        row(cfg, "dusk-evm", "Message passer on DuskEVM", L2_TO_L1_MESSAGE_PASSER),
      ],
      title: `${names.dusk} and ${names["dusk-evm"]}`,
    });

  if (cfg.multicall?.contractId)
    groups.push({
      id: "reads",
      rows: [row(cfg, "dusk", "Multicall for Dusk", cfg.multicall.contractId, "Batches this page's reads of Dusk contracts.")],
      title: "Used to read Dusk",
    });

  return groups;
}
