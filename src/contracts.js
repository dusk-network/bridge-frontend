// The Contracts sheet: every address and contract ID each route uses, in
// full, from the deployment's own config, with explorer links where the
// explorer has a page, grouped by the three routes. Nothing here is
// inferred.

import { formatContractId } from "@dusk-network/networks/format";

import { buildRoutes } from "./bridge-routes.js";
import { evmChains } from "./config.js";
import { bridgeTasks, networkNames, notRunning, tokenName } from "./names.js";

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
 * A Dusk contract, its ID as every Dusk app writes one: the full 64 hex
 * characters, lower case, without 0x, so it isn't taken for an EVM address.
 * The copy button copies the same. It has no explorer link: the explorer has
 * no contract pages, and without 0x an ID with no 0 reads as an account.
 */
const contractRow = (label, id, note = "") => ({ href: null, label, network: "dusk", note, value: formatContractId(id) });

/**
 * The sheet's groups: the networks, then one group per route: BNB Smart
 * Chain ↔ Dusk, Ethereum → Dusk and Dusk ↔ DuskEVM.
 */
export function contractGroups(cfg) {
  const names = networkNames(cfg);
  const groups = [];

  const networks = [{ label: names.dusk, value: cfg.dusk.chainId }];
  networks.push(
    cfg.duskEvm.enabled
      ? { label: names["dusk-evm"], value: `chain ${cfg.duskEvm.chainId}` }
      : { label: names["dusk-evm"], muted: true, value: `not on ${names.badge} yet` },
  );
  for (const id of evmChains(cfg)) networks.push({ label: names[id], value: `chain ${cfg.evmNetworks[id].chainId}` });
  groups.push({ id: "networks", rows: networks, title: "Networks" });

  for (const task of bridgeTasks(cfg, buildRoutes(cfg))) {
    // Hyperlane's routes to the same chain have a group of their own.
    const own = task.routes.filter((route) => route.mode !== "hyperlane");
    if (task.id === "duskevm" || !own.length) continue;
    const id = task.id;
    const network = cfg.evmNetworks[id];
    const migrates = own.some((route) => route.mode === "migration");
    const service = cfg.service?.network === id ? cfg.service : null;
    const payer = migrates ? network.payoutAccount : "";
    const rows = [
      row(cfg, id, tokenName(id), network.tokenContract, migrates && service ? "What the migration takes and the bridge pays out." : migrates ? "What the migration takes." : "What the bridge pays out."),
    ];
    if (migrates)
      rows.push(row(cfg, id, "Migration contract", network.migrationContract));
    if (service)
      rows.push(
        row(
          cfg,
          "dusk",
          "Bridge account on Dusk",
          service.account,
          `Receives the DUSK you send. The memo names where it pays out.${payer === service.account ? ` It also pays out what comes from ${names[id]}.` : ""}`,
        ),
      );
    if (payer && payer !== service?.account)
      rows.push(row(cfg, "dusk", "Pays out on Dusk", payer, "Only its transfers count as a migration's payout."));
    if (service?.payoutAddress) rows.push(row(cfg, id, "Pays out from", service.payoutAddress));
    const paused = own.every((route) => route.paused);
    groups.push({
      docs: migrates ? cfg.links?.docs?.migration : cfg.links?.docs?.service,
      id: `route-${id}`,
      note: paused ? `${notRunning(cfg)}.` : "",
      rows,
      title: task.title,
    });
  }

  if (cfg.duskEvm.enabled)
    groups.push({
      docs: cfg.links?.docs?.duskEvm,
      id: "duskevm",
      rows: [
        contractRow("Bridge contract on Dusk", cfg.duskEvm.l1StandardBridgeContractId, "Takes deposits."),
        contractRow("Withdrawal portal on Dusk", cfg.duskEvm.optimismPortalContractId, "Checks proofs and releases claims."),
        contractRow("Dispute game factory on Dusk", cfg.duskEvm.disputeGameFactoryContractId),
        ...(cfg.duskEvm.anchorStateRegistryContractId
          ? [contractRow("Anchor state registry on Dusk", cfg.duskEvm.anchorStateRegistryContractId, "Says which dispute games the portal takes.")]
          : []),
        row(cfg, "dusk-evm", "Bridge on DuskEVM", cfg.duskEvm.predeploys.l2StandardBridge),
        row(cfg, "dusk-evm", "Message passer on DuskEVM", cfg.duskEvm.predeploys.l2ToL1MessagePasser),
      ],
      title: `${names.dusk} ↔ ${names["dusk-evm"]}`,
    });

  if (cfg.hyperlane?.enabled) {
    const { dusk, evm, network, tokens } = cfg.hyperlane;
    const chain = names[network];
    const rows = tokens.flatMap((token) => [
      contractRow(`${token.symbol} route on Dusk`, token.dusk.route, `Takes the ${token.symbol} sent to ${chain}, and pays out what comes back.`),
      ...(token.native ? [] : [contractRow(`${token.symbol} on Dusk`, token.dusk.token, "The token, issued on Dusk.")]),
      row(cfg, network, `${token.symbol} on ${chain}`, token.evm.token, "Mints what comes from Dusk, and burns what goes back."),
    ]);
    rows.push(contractRow("Mailbox on Dusk", dusk.mailbox), contractRow("Gas paymaster on Dusk", dusk.igp, "Takes the bridge fee for what's sent from Dusk."), row(cfg, network, `Mailbox on ${chain}`, evm.mailbox));
    const routes = buildRoutes(cfg).filter((route) => route.mode === "hyperlane");
    groups.push({
      id: "hyperlane",
      note: routes.every((route) => route.paused) ? `${notRunning(cfg)}.` : "",
      rows,
      title: `${names.dusk} ↔ ${chain}, through Hyperlane`,
    });
  }

  if (cfg.multicall?.contractId)
    groups.push({
      id: "reads",
      rows: [contractRow("Multicall for Dusk", cfg.multicall.contractId, "Batches this page's reads of Dusk contracts.")],
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
  for (const id of evmChains(cfg)) {
    const host = hostOf(cfg.evmNetworks[id]?.rpcUrl);
    if (host) parts.push(`${host} (${names[id]})`);
  }
  // Dusk Domains' site, which serves the name reader's lens driver.
  const nameHost = hostOf(cfg.network.duskDomains?.site);
  if (nameHost) parts.push(`${nameHost} (for .dusk names)`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `This page reads from ${list}.`;
}
