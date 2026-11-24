import { DuskWalletRequestTimeoutError, createDuskWallet } from "@dusk/connect";

import { config } from "./config.js";
import { toHex } from "./data-driver.js";
import { webStorageAllowed } from "./page-storage.js";

// Dusk Connect is used for the account, signing and sending only. Chain state
// is read from the deployment's own node (see dusk-node.js).
let wallet;

export async function createDuskConnection() {
  // Dusk Connect remembers the wallet last used in Web Storage, and can't
  // start where the browser denies it: there, it isn't asked to.
  wallet = wallet ?? createDuskWallet(webStorageAllowed() ? {} : { rememberLastUsedProvider: false });
  // A wallet slow to answer as the page opens is still installed: the page
  // goes on, and asks it again when the page gets focus.
  await wallet.ready().catch((error) => {
    if (!(error instanceof DuskWalletRequestTimeoutError)) throw error;
  });
  return {
    /**
     * The wallets to choose from where Dusk Connect leaves the choice to you
     * (several are installed, or the one chosen before isn't), and, with
     * several installed, until the one in use lets this page in: a choice
     * cancelled or unanswered in the wallet, on this visit or an earlier
     * one, can be made again. A wallet the page connected keeps its place,
     * locked too. Empty otherwise.
     */
    get choices() {
      const installed = wallet.providers;
      const open = !wallet.provider || (installed.length > 1 && !wallet.state.authorized);
      return open ? installed.map(({ name, rdns, uuid }) => ({ id: uuid, name, rdns })) : [];
    },
    /** Connects, with the wallet chosen (`id`) where there was a choice. */
    async connect(id) {
      if (id) await wallet.selectProvider(id);
      return wallet.connect({ reason: "bridge_recipient" });
    },
    disconnect: () => wallet.disconnect(),
    get state() {
      return wallet.state;
    },
    subscribe: (listener) => wallet.subscribe(listener),
    wallet,
  };
}

/** Why this page is still connected to Dusk Wallet after asking it to let go. */
const NOT_DISCONNECTED = "Dusk Wallet didn't disconnect this page. Try again, or disconnect it in Dusk Wallet.";

/**
 * Lets go of the profile this page uses (`connection`, `createDuskConnection`'s):
 * "" once Dusk Wallet did, else why not, as one that refuses or doesn't
 * answer may still have this page connected.
 */
export async function disconnectDusk(connection) {
  try {
    if (!connection) throw new Error("no wallet");
    // Dusk Connect resolves with the wallet's answer: false where it didn't let go.
    if ((await connection.disconnect()) === false) throw new Error("not disconnected");
    return "";
  } catch {
    return NOT_DISCONNECTED;
  }
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
 * `beforeSend` runs right before the request goes to the wallet, after every
 * wait on the way, and sends nothing where it throws.
 */
async function withDuskSession(operation, reviewed, beforeSend = () => {}) {
  const { account } = await ensureDuskConnected();
  const expected = reviewed || account;
  const moved = () => Object.assign(new Error(DUSK_ACCOUNT_CHANGED), { code: "DUSK_ACCOUNT_CHANGED" });
  if (account !== expected) throw moved();
  try {
    beforeSend();
    return await operation();
  } catch (error) {
    if (!isRecoverableDuskSessionError(error)) throw error;
    const current = getDuskWallet();
    await current.refresh().catch(() => {});
    await current.connect({ reason: "bridge_transaction" });
    if ((await ensureDuskConnected()).account !== expected) throw moved();
    beforeSend();
    return operation();
  }
}

/** A public transfer; without `gas`, the wallet applies its own. */
export function buildTransferRequest({ amountLux, gas, memo, to }) {
  return {
    amount: BigInt(amountLux).toString(),
    ...(gas ? { gas: { limit: String(gas.limit), price: String(gas.price) } } : {}),
    memo: String(memo ?? ""),
    privacy: "public",
    to,
  };
}

export async function sendDuskTransfer(request, { account, beforeSend } = {}) {
  return withDuskSession(
    () => getDuskWallet().sendTransfer(buildTransferRequest(request)),
    account,
    beforeSend,
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

export async function sendDuskContractCall(request, { account, beforeSend } = {}) {
  return withDuskSession(
    () => getDuskWallet().sendContractCall(buildContractCallRequest(request)),
    account,
    beforeSend,
  );
}
