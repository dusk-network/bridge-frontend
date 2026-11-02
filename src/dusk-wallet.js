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
     * The wallets to choose from where Dusk Connect leaves the choice to you:
     * several are installed, or the one chosen before isn't. Empty once one
     * is in use.
     */
    get choices() {
      return wallet.provider ? [] : wallet.providers.map(({ name, rdns, uuid }) => ({ id: uuid, name, rdns }));
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
