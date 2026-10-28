import { createDuskWallet } from "@dusk/connect";

import { config } from "./config.js";
import { toHex } from "./data-driver.js";

// Dusk Connect is used for the account, signing and sending only. Chain state
// is read from the deployment's own node (see dusk-node.js).
let wallet;

export async function createDuskConnection() {
  wallet = wallet ?? createDuskWallet();
  await wallet.ready();
  return {
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

/** For tests: a stand-in for the Dusk Connect wallet. */
export function useDuskWallet(next) {
  wallet = next;
}

export function isRecoverableDuskSessionError(error) {
  return error?.code === 4100;
}

export async function ensureDuskConnected(chainId = config.dusk.chainId) {
  const current = getDuskWallet();
  await current.refresh().catch(() => {});
  if (!current.state.authorized || !current.state.selectedProfile)
    await current.connect({ reason: "bridge_recipient" });
  if (current.state.chainId !== chainId) await current.switchChain({ chainId });
  const profile = current.state.selectedProfile;
  if (!profile?.account) throw new Error("Select a Dusk wallet profile first.");
  return profile;
}

/** Why a request isn't sent again after a reconnect: it was reviewed for another account. */
export const DUSK_ACCOUNT_CHANGED = "Dusk Wallet switched to another account, so nothing was sent. Review it again.";

/**
 * Sends with Dusk Wallet's session, connecting again once if it lapsed.
 * `reviewed` is the account the request was reviewed for; without one, it's
 * the account connected when sending starts. A connect can come back with
 * another profile: the request is only sent as the reviewed account.
 */
async function withDuskSession(operation, reviewed) {
  const { account } = await ensureDuskConnected();
  const expected = reviewed || account;
  const moved = () => Object.assign(new Error(DUSK_ACCOUNT_CHANGED), { code: "DUSK_ACCOUNT_CHANGED" });
  if (account !== expected) throw moved();
  try {
    return await operation();
  } catch (error) {
    if (!isRecoverableDuskSessionError(error)) throw error;
    const current = getDuskWallet();
    await current.refresh().catch(() => {});
    await current.connect({ reason: "bridge_transaction" });
    if ((await ensureDuskConnected()).account !== expected) throw moved();
    return operation();
  }
}

/** A public transfer; the wallet applies its own public-transfer gas. */
export function buildTransferRequest({ amountLux, memo, to }) {
  return {
    amount: BigInt(amountLux).toString(),
    memo: String(memo ?? ""),
    privacy: "public",
    to,
  };
}

export async function sendDuskTransfer(request, { account } = {}) {
  return withDuskSession(
    () => getDuskWallet().sendTransfer(buildTransferRequest(request)),
    account,
  );
}

export function buildContractCallRequest({
  contractId,
  depositLux,
  display,
  fnArgs,
  fnName,
  gas,
}) {
  return {
    ...(depositLux === undefined
      ? {}
      : { deposit: BigInt(depositLux).toString() }),
    contractId: `0x${String(contractId).replace(/^0x/iu, "")}`,
    display,
    fnArgs: `0x${toHex(fnArgs)}`,
    fnName,
    gas: { limit: String(gas.limit), price: String(gas.price) },
    privacy: "public",
  };
}

export async function sendDuskContractCall(request, { account } = {}) {
  return withDuskSession(
    () => getDuskWallet().sendContractCall(buildContractCallRequest(request)),
    account,
  );
}
