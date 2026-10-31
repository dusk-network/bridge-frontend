#!/usr/bin/env node
// Compares, on Dusk testnet, what two checkouts of this site hand Dusk
// Wallet to sign for DuskEVM withdrawals: this one and another (`MAIN`, a
// checkout from before @dusk-network/app-core/duskevm-withdrawals, with its
// dependencies installed). Read-only: Dusk Wallet is a stand-in that records
// each request it gets and refuses it, so nothing is signed or sent. Not run
// in CI: it reads testnet's node, DuskEVM's RPC, and both checkouts.
//
// For user2's withdrawals (those its DuskEVM addresses sent, and the known
// ones below), and for user2 and each other account that proved one:
// - the withdrawal as each site keeps it after a check (stage, dates,
//   amount, whom it pays, whose proof);
// - where it can be proved now, the proof's request;
// - where it can be claimed now, the claim's request;
// each request byte for byte: contract, function, arguments, deposit, gas
// limit and gas price, as each site's own code hands them to the wallet.
//
//   node scripts/compare-withdrawals.mjs MAIN [--only=HASH,...]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [MAIN] = process.argv.slice(2);
const only = (process.argv.find((arg) => arg.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
if (!MAIN) {
  console.error("usage: node scripts/compare-withdrawals.mjs MAIN_CHECKOUT [--only=HASH,...]");
  process.exit(2);
}

// user2 (wallet-both.dusk) on testnet, and the DuskEVM addresses it withdraws from.
const USER2 = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const USER2_EVM = ["0xc11d5aab4234e255e214ac6e8c0ad61fa0836473", "0x784053019bd07a6444779f3b1094f15b1bac4eac"];
// Testnet withdrawals the apps' recordings use, which other addresses sent: the 1,008 DUSK one to
// 213qXN…, and two of 1 DUSK to user2, one proved by user2; and the one this change was tried with.
const KNOWN = [
  "0x04a8a8977dd251da49bd8997cf4d063ddc385f8d29b437b119bb3c79c11b3213",
  "0x517fe1a2b949b9cc23ff9bb3b3acc77d256bed937c88b647b7bebd13d02b510c",
  "0x6ae8c4cbf54f2fe2edfa881a3f24d82ba46f735707f6f9ef7ff591963574b38f",
  "0xe45ebbda57a2b697a8457bba94eb12475b959278e37d4073b449162cb605cf97",
];

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };

/** One checkout's own services, with a Dusk Wallet that records each request and refuses it. */
async function site(dir) {
  const { loadConfig } = await import(`${dir}/src/config.js`);
  const { createServices, proofSubmitterFor } = await import(`${dir}/src/services.js`);
  const wallet = await import(`${dir}/src/dusk-wallet.js`);
  const { buildRoutes } = await import(`${dir}/src/bridge-routes.js`);
  const cfg = loadConfig();
  const services = createServices(cfg, { fetchDriver: async (url) => new Response(await readFile(`${dir}/public${url}`)) });
  const route = buildRoutes(cfg).find((each) => each.mode === "duskevm-withdrawal");
  const asked = [];
  let account = USER2;
  wallet.useDuskWallet({
    connect: async () => {},
    refresh: async () => {},
    sendContractCall: async (request) => {
      asked.push(JSON.stringify(request));
      throw Object.assign(new Error("Recorded, not signed."), { code: 4001 });
    },
    get state() {
      return { authorized: true, chainId: cfg.dusk.chainId, selectedProfile: { account } };
    },
    switchChain: async () => {},
  });
  /** What the site hands Dusk Wallet for a proof or claim, as its review prepares it for `as`. */
  async function handed(kind, hash, { as, price, submitter }) {
    const request = services.portalRequest
      ? await services.portalRequest(
          await services.withdrawals[kind === "prove" ? "prepareProve" : "prepareFinalize"](hash, { gasPrice: price, proofSubmitter: submitter }),
        )
      : (await services.withdrawals.request(kind, hash, { price, submitter })).request;
    account = as;
    asked.length = 0;
    await wallet.sendDuskContractCall(request, { account: as }).catch((error) => {
      if (error?.code !== 4001) throw error;
    });
    account = USER2;
    return asked[0];
  }
  /** The withdrawal as the site keeps it after a check for `submitter`. */
  const checked = (hash, submitter) =>
    services.tracking.refresh({ hash, routeId: route.id, ...(submitter ? { proofSubmitter: submitter, proveHash: "checked for this account" } : {}) }, route);
  return { cfg, checked, handed, proofSubmitterFor, services };
}

const main = await site(path.resolve(MAIN));
const branch = await site(HERE);

// The Portal's other provers of a withdrawal, read with this checkout's node and driver.
const { createDuskNode } = await import(`${HERE}/src/dusk-node.js`);
const { driverJson, loadDataDriver } = await import(`${HERE}/src/data-driver.js`);
const portalDriver = await loadDataDriver(await readFile(`${HERE}/public${branch.cfg.duskEvm.optimismPortalDriver.url}`));
const node = createDuskNode({ url: branch.cfg.dusk.nodeUrl });
const portal = (fn, args) =>
  node.contractCall(branch.cfg.duskEvm.optimismPortalContractId, fn, portalDriver.encodeInputFn(fn, driverJson(args))).then((out) => portalDriver.decodeOutputFn(fn, out));
const bytesOf = (hex) => Array.from(Buffer.from(hex.replace(/^0x/u, ""), "hex"));
const u256 = (n) => bytesOf(BigInt(n).toString(16).padStart(64, "0"));
async function provers(withdrawalHash) {
  const id = bytesOf(withdrawalHash);
  const count = Number(BigInt(`0x${Buffer.from(await portal("numProofSubmitters", id)).toString("hex")}`));
  return Promise.all(Array.from({ length: Math.min(count, 8) }, (_, i) => portal("proofSubmitters", [id, u256(i)]).then((who) => `0x${Buffer.from(who).toString("hex")}`)));
}

// user2's withdrawals, as both sites find them from its DuskEVM addresses.
const found = [];
for (const each of [main, branch]) {
  const hashes = new Set();
  for (const evm of USER2_EVM) {
    const run = await each.services.discovery.discover({ evm, evmRequests: 60 });
    if (run.errors.length) throw run.errors[0];
    for (const entry of run.entries) hashes.add(`${entry.hash} ${entry.amountLux} ${entry.destination}`);
  }
  found.push([...hashes].sort());
}
const differences = [];
const sameFound = JSON.stringify(found[0]) === JSON.stringify(found[1]);
if (!sameFound) differences.push("the withdrawals found");
console.log(`found from ${USER2_EVM.join(" and ")}: ${found[1].length}, ${sameFound ? "the same on both" : "DIFFERENT"}`);
const hashes = [...new Set([...found[1].map((line) => line.split(" ")[0]), ...KNOWN])].filter((hash) => !only.length || only.includes(hash)).sort();
const price = await branch.services.node.gasPrice();
const user2 = branch.proofSubmitterFor(USER2);
console.log(`${hashes.length} withdrawals; gas price ${price} LUX, as the page reads it; user2 proves as ${user2}`);

const shown = ({ amountLux, claimOverdue, destination, proofGame, proofRejected, provenAt, provenByOther, readyAt, readyAtExact, sender, stage, stageSubmitter, status, statusMessage, withdrawalGas, withdrawalHash }) =>
  ({ amountLux, claimOverdue, destination, proofGame, proofRejected, provenAt, provenByOther, readyAt, readyAtExact, sender, stage, stageSubmitter, status, statusMessage, withdrawalGas, withdrawalHash });
for (const hash of hashes) {
  const first = await branch.checked(hash, null);
  const accounts = [user2, ...(first.withdrawalHash ? (await provers(first.withdrawalHash)).filter((who) => who !== user2) : [])];
  for (const submitter of accounts) {
    const label = `${hash.slice(0, 10)}… for ${submitter === user2 ? "user2" : submitter}`;
    const [a, b] = [shown(await main.checked(hash, submitter)), shown(await branch.checked(hash, submitter))];
    // Whose proof a claimed withdrawal's check was for: the package names it, the earlier code didn't, and nothing reads it then.
    const unread = (key) => key === "stageSubmitter" && a.stage === "finalized" && b.stage === "finalized";
    const keys = Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
    const same = keys.every(unread);
    console.log(`${label}: ${b.stage}${b.readyAt ? `, claim from ${new Date(b.readyAt * 1_000).toISOString()}${b.readyAtExact ? "" : " (about)"}` : ""} · status ${same ? "same" : "DIFFERS"}${keys.length && same ? " (but for stageSubmitter, which a claimed one doesn't read)" : ""}`);
    if (!same) {
      differences.push(label);
      for (const key of keys) console.log(`    ${key}: main ${JSON.stringify(a[key])} · branch ${JSON.stringify(b[key])}`);
    }
    const kind = b.stage === "ready_to_prove" ? "prove" : b.stage === "ready_to_finalize" ? "finalize" : null;
    if (!kind || (kind !== (a.stage === "ready_to_prove" ? "prove" : a.stage === "ready_to_finalize" ? "finalize" : null))) continue;
    // As the review prepares it: for the account Dusk Wallet has, user2's, or a stand-in named after another prover.
    const as = submitter === user2 ? USER2 : `prover ${submitter}`;
    const [x, y] = await Promise.all([
      main.handed(kind, hash, { as, price, submitter }).catch((error) => `refused: ${error.message}`),
      branch.handed(kind, hash, { as, price, submitter }).catch((error) => `refused: ${error.message}`),
    ]);
    const request = (() => {
      try {
        const { contractId, deposit, fnArgs, fnName, gas } = JSON.parse(y);
        return `${fnName} on ${contractId.slice(0, 10)}…, ${(fnArgs.length - 2) / 2} bytes, deposit ${deposit ?? "none"}, gas ${gas.limit} at ${gas.price}`;
      } catch {
        return y;
      }
    })();
    console.log(`    ${kind === "prove" ? "proof" : "claim"}: ${x === y ? "byte for byte the same" : "DIFFERS"}: ${request}`);
    if (x !== y) {
      differences.push(`${label} ${kind}`);
      console.log(`    main:   ${x}\n    branch: ${y}`);
    }
  }
}
console.log(differences.length ? `Differences: ${differences.join("; ")}` : "No differences.");
process.exitCode = differences.length ? 1 : 0;
