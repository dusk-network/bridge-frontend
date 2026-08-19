import { compressedDuskBlsPublicKeyToRaw } from "@dusk/evm-sdk";
import { keccak256 } from "viem";

import { decodeBase58 } from "./base58.js";
import { config } from "./config.js";
import { ensureDuskConnected, getDuskApp } from "./dusk-wallet.js";

const asContract = (contractId, driverUrl) =>
  getDuskApp().contract({
    contractId: `0x${String(contractId).replace(/^0x/u, "")}`,
    defaultTx: { privacy: "public" },
    driverUrl,
  });

async function submitContract(contractId, driverUrl, method, args, gas) {
  await ensureDuskConnected(config.duskEvm.l1ChainId);
  const contract = asContract(contractId, driverUrl);
  return contract.write[method](args, {
    ...(gas
      ? { gas: { limit: gas.limit.toString(), price: gas.price.toString() } }
      : {}),
    privacy: "public",
  });
}

export const walletStore = Object.freeze({
  async finalizeDuskEvmWithdrawal(contractId, driverUrl, withdrawal, gas) {
    return submitContract(
      contractId,
      driverUrl,
      "finalizeWithdrawalTransaction",
      withdrawal,
      gas,
    );
  },
  getDuskEvmProofSubmitter() {
    const account = getDuskApp().wallet.state.selectedProfile?.account;
    if (!account)
      throw new Error("Connect a Dusk wallet before checking the withdrawal.");
    const raw = compressedDuskBlsPublicKeyToRaw(decodeBase58(account));
    return `0x${keccak256(raw).slice(-40)}`;
  },
  async proveDuskEvmWithdrawal(contractId, driverUrl, args, gas) {
    return submitContract(
      contractId,
      driverUrl,
      "proveWithdrawalTransaction",
      args,
      gas,
    );
  },
  async useContract(contractId, driverUrl) {
    return asContract(contractId, driverUrl);
  },
});

async function graphql(query) {
  const response = await fetch(
    `${config.duskEvm.l1NodeUrl.replace(/\/$/u, "")}/on/graphql/query`,
    {
      body: JSON.stringify({ query }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok)
    throw new Error(`Dusk node query failed with HTTP ${response.status}.`);
  const body = await response.json();
  if (body.errors?.length)
    throw new Error(body.errors[0].message ?? "Dusk node query failed.");
  return body.data ?? body;
}

export const networkStore = Object.freeze({
  async connect() {
    return { query: graphql };
  },
  async getLatestBlockTimestamp() {
    const result = await graphql("block(height: -1) { header { timestamp } }");
    const timestamp = result?.block?.header?.timestamp;
    if (timestamp === undefined || timestamp === null)
      throw new Error("Latest Dusk block timestamp is unavailable.");
    return BigInt(timestamp);
  },
});

export const duskEvm = Object.freeze({
  rpcUrls: { default: { http: [config.duskEvm.rpcUrl] } },
});
