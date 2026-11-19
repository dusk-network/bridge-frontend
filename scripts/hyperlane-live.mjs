#!/usr/bin/env node
// Testnet's Hyperlane routes, live, with the page's own reads and tracking.
// It signs nothing and sends nothing: transfers go through the page, with
// Dusk Wallet and an EVM wallet.
//
//   node scripts/hyperlane-live.mjs check <dusk account> <sepolia address> [amount]
//     Whether each route is the one the book names, as the page checks it
//     before every send, what each route's transfer of `amount` (1 unless
//     given, in each token's own units) costs, both ways, what the accounts
//     hold, and what's short.
//
//   node scripts/hyperlane-live.mjs follow <transaction hash>
//     Finds the transfer a hash is, on either side, and follows it as its
//     receipt does, until it ends or for 10 minutes: its message, its
//     delivery and, on Dusk, the transaction that delivered it and the
//     escrow its account claims.

import { readFile } from "node:fs/promises";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const { loadConfig } = await import("../src/config.js");
const { buildRoutes } = await import("../src/bridge-routes.js");
const { createDriverLoader } = await import("../src/data-driver.js");
const { createDuskNode } = await import("../src/dusk-node.js");
const { formatDusk, formatToken } = await import("../src/format.js");
const { HYPERLANE_GAS, duskRecipientHash } = await import("../src/hyperlane.js");
const { createHyperlaneReads } = await import("../src/hyperlane-reads.js");
const { parseAmount } = await import("../src/quote.js");
const { resolveTransfer } = await import("../src/resolve.js");
const { createRpc } = await import("../src/services.js");
const { createTracking } = await import("../src/tracking.js");
const { backLine } = await import("./hyperlane-live-lines.mjs");

const cfg = loadConfig();
const node = createDuskNode({ url: cfg.dusk.nodeUrl });
const rpc = createRpc({ [cfg.hyperlane.network]: cfg.evmNetworks[cfg.hyperlane.network].rpcUrl });
const loadDriver = createDriverLoader({ fetch: async (url) => new Response(await readFile(new URL(`../public${url}`, import.meta.url))) });
const reads = createHyperlaneReads({ cfg, loadDriver, node, rpc });

async function check(account, address, typed = "1") {
  if (!duskRecipientHash(account) || !/^0x[0-9a-f]{40}$/iu.test(address ?? "")) throw new Error("Give a Dusk account and a Sepolia address.");
  const price = await node.gasPrice();
  const dusk = await node.accountBalance(account);
  console.log(`Dusk ${account}: ${formatDusk(dusk)}, gas price ${price} Lux`);
  const escrow = await reads.escrow(duskRecipientHash(account));
  let duskNeeded = 0n;
  for (const token of cfg.hyperlane.tokens) {
    const { lux: amount } = parseAmount(typed, token.decimals);
    const [fee, held, approved, evm] = await Promise.all([
      reads.dispatchFee(token, { amount, recipient: address }),
      token.native ? dusk : reads.tokenBalance(token, account),
      token.native ? null : reads.allowance(token, account),
      reads.evmState(token, address),
    ]);
    // No delivery fee read: no estimate of the call it's the value of.
    const gas = evm.deliveryFeeWei === null ? null : await reads.transferGas(token, { amount, owner: address, recipient: duskRecipientHash(account), value: evm.deliveryFeeWei });
    const booked = await reads.checkRoute(token).then(() => reads.checkMailbox(token, fee)).then(() => "", (error) => error.message);
    const approves = !token.native && approved < amount;
    const fees = fee + (HYPERLANE_GAS.transfer.limit + (approves ? HYPERLANE_GAS.approve.limit : 0n)) * price;
    const out = token.native ? amount + fees : fees;
    const held_ = escrow.find((each) => each.token === token);
    const claim = held_.registered ? 0n : HYPERLANE_GAS.claim.limit * price;
    duskNeeded += out + claim;
    console.log(`\n${token.symbol}, ${formatToken(amount, token)} each way`);
    console.log(`  Route: ${booked || "as the book names it, with room in the Mailbox"}.`);
    console.log(`  To Sepolia: bridge fee ${formatDusk(fee)}${approves ? ", an approval first" : ""}; it takes up to ${formatDusk(out)} from the account${token.native ? "" : ` and ${formatToken(amount, token)} (it holds ${formatToken(held, token)}${held < amount ? ", too little" : ""})`}.`);
    console.log(backLine({ amount, evm, gas, token }));
    console.log(`  Escrow on Dusk: ${held_.registered ? "the account is registered: transfers arrive directly" : `the first transfer waits for a claim, up to ${formatDusk(claim)}`}${held_.pending ? `; ${formatToken(held_.pending, token)} waits now` : ""}.`);
  }
  console.log(`\nAll three both ways, with the claims: up to ${formatDusk(duskNeeded)} on Dusk; it holds ${formatDusk(dusk)}${dusk < duskNeeded ? ", too little" : ""}.`);
  console.log(`A claim for another account (claim_pending_for) takes up to ${formatDusk(HYPERLANE_GAS.claimFor.limit * price)} from the account that sends it.`);
}

async function follow(hash) {
  const found = await resolveTransfer(hash, { cfg, node, rpc });
  if (!found?.routeId) throw new Error(found?.message ?? "No Hyperlane transfer has this hash yet.");
  const route = buildRoutes(cfg).find((each) => each.id === found.routeId);
  if (route?.mode !== "hyperlane") throw new Error(`That's a transfer on ${found.routeId}, not one of Hyperlane's.`);
  const tracking = createTracking({ archive: null, config: cfg, hyperlane: reads, node, rpc });
  let entry = { hash: found.hash, routeId: route.id, status: "pending" };
  let said = "";
  const until = Date.now() + 10 * 60_000;
  console.log(`${route.id}, ${found.hash}`);
  while (Date.now() < until) {
    try {
      // Checked as the page checks it: when, so a delivery seen since is looked for in the blocks since.
      entry = { ...entry, ...(await tracking.refresh(entry, route)), lastCheckedAt: Date.now() };
    } catch (error) {
      console.log(`  (a read failed, trying again: ${error.message})`);
    }
    const now = [
      entry.status,
      entry.note,
      entry.messageId ? `message ${entry.messageId}` : "",
      entry.deliveryHash ? `delivered in Dusk transaction ${entry.deliveryHash}` : "",
      entry.escrow ? `escrow ${entry.escrow}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (now !== said) console.log(`${new Date().toISOString()}  ${now}`);
    said = now;
    if (entry.status !== "pending" || entry.escrow === "held") break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  console.log(JSON.stringify(entry, null, 2));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "check") await check(...args);
  else if (command === "follow") await follow(...args);
  else {
    console.error("Usage: node scripts/hyperlane-live.mjs check <dusk account> <sepolia address> [amount]\n       node scripts/hyperlane-live.mjs follow <transaction hash>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
