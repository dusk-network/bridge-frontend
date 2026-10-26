import { createDuskApp, createDuskWallet } from "@dusk/connect";

import { config } from "./config.js";

let wallet;
let app;

export async function createDuskConnection() {
  wallet = wallet ?? createDuskWallet();
  app =
    app ??
    createDuskApp({
      wallet,
      nodeUrl: config.duskEvm.l1NodeUrl,
      chain: { chainId: config.duskEvm.l1ChainId },
    });
  await wallet.ready();

  return {
    app,
    connect: () => wallet.connect({ reason: "bridge_recipient" }),
    disconnect: () => wallet.disconnect(),
    get state() {
      return wallet.state;
    },
    subscribe: (listener) => wallet.subscribe(listener),
    wallet,
  };
}

export function getDuskWallet() {
  if (!wallet) throw new Error("The Dusk wallet is not initialized.");
  return wallet;
}

export function getDuskApp() {
  if (!app) throw new Error("The Dusk app is not initialized.");
  return app;
}

export function isRecoverableDuskSessionError(error) {
  return error?.code === 4100;
}

export async function ensureDuskConnected(
  chainId = config.dusk.mainnet.chainId,
) {
  const current = getDuskWallet();
  await current.refresh().catch(() => {});
  if (!current.state.authorized || !current.state.selectedProfile)
    await current.connect({ reason: "bridge_recipient" });
  if (current.state.chainId !== chainId) await current.switchChain({ chainId });
  const profile = current.state.selectedProfile;
  if (!profile?.account) throw new Error("Select a Dusk wallet profile first.");
  return profile;
}

async function withDuskSession(chainId, operation) {
  await ensureDuskConnected(chainId);
  try {
    return await operation();
  } catch (error) {
    if (!isRecoverableDuskSessionError(error)) throw error;
    const current = getDuskWallet();
    await current.refresh().catch(() => {});
    await current.connect({ reason: "bridge_transaction" });
    await ensureDuskConnected(chainId);
    return operation();
  }
}

export async function sendDuskTransfer({ amountLux, chainId, memo, to }) {
  return withDuskSession(chainId, () =>
    getDuskWallet().sendTransfer({
      amount: BigInt(amountLux).toString(),
      memo: String(memo ?? ""),
      privacy: "public",
      to,
    }),
  );
}

export function buildContractCallRequest({
  chainId: _chainId,
  contractId,
  depositLux,
  fnArgs,
  fnName,
  gas,
}) {
  return {
    ...(depositLux === undefined
      ? {}
      : { deposit: BigInt(depositLux).toString() }),
    contractId,
    display: { contractName: "Dusk bridge", methodSig: fnName },
    fnArgs,
    fnName,
    gas,
    privacy: "public",
  };
}

export async function sendDuskContractCall(request) {
  const { chainId } = request;
  return withDuskSession(chainId, () =>
    getDuskWallet().sendContractCall(buildContractCallRequest(request)),
  );
}
