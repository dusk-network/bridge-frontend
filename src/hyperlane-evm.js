// A transfer from the EVM chain back to Dusk: `transferRemote` on the
// chain's token, which burns what it sends, with the token's whole charge
// for it, as the token quotes it, as the call's value. Before it goes, both
// routers are checked to name each other, and Dusk's token not to be paused,
// since the route couldn't pay it out. The charge is read as it's sent,
// never kept from earlier, and the call is simulated against the chain as
// the page reads it: through the EVM wallet, where a public RPC can be a
// block behind. It goes out from the account it was reviewed for, on the
// route's chain, or not at all.

import { createPublicClient, custom } from "viem";

import { formatUnitsGrouped } from "./format.js";
import { ensureEvmChain, getEvmClients, reviewedEvmAccount } from "./evm-wallet.js";
import { HYPERLANE_EVM_ABI, carries, duskRecipientHash } from "./hyperlane.js";
import { NOT_CARRIED, feeChanged } from "./hyperlane-requests.js";
import { gasCoin } from "./names.js";

/**
 * Whether a transfer of `amount` back to Dusk, to the account whose hash is
 * `recipientHash`, can go, and what it charges: both routers name each
 * other, Dusk's token isn't paused, since the route couldn't pay it out,
 * and the token's whole charge (`transferCharge`, which refuses a fee in the
 * token the page can't show). Its review reads it, and its send again.
 */
export async function inboundCharge(reads, token, { amount, recipientHash }) {
  const [, paused, charge] = await Promise.all([reads.checkRoute(token), token.native ? false : reads.paused(token), reads.transferCharge(token, { amount, recipient: recipientHash })]);
  if (paused) throw new Error(`${token.symbol} is paused on Dusk, so it couldn't be paid out there. Nothing was sent.`);
  return charge;
}

/**
 * Sends `amount` of `token` to the Dusk account `recipient`, from `account`,
 * the EVM account it was reviewed for. The token pays a Dusk account by its
 * recipient hash, keccak256 of its key. `reads` are the page's Hyperlane
 * reads: the routers (`checkRoute`), the token's pause on Dusk, the whole
 * charge (`transferCharge`, which refuses a fee in the token the page can't
 * show), and Sepolia as the page reads it (`evm`: the wallet while it's on
 * the chain, else the RPC), which the call is simulated through.
 * `reviewedFee`, the ETH charge the review showed, refuses one that changed
 * since. Its hash is the one the wallet sent: until it's mined, the wallet
 * can speed it up under another (`minedAs`).
 */
export async function sendToDusk(cfg, { account, amount, reads, recipient, reviewedFee = null, token }) {
  if (!carries(amount)) throw new Error(NOT_CARRIED);
  const hash = duskRecipientHash(recipient);
  if (!hash) throw new Error("That isn't a Dusk account.");
  const network = cfg.evmNetworks[cfg.hyperlane.network];
  await ensureEvmChain(network);
  const { walletClient } = getEvmClients(network);
  const value = (await inboundCharge(reads, token, { amount, recipientHash: hash })).native;
  if (reviewedFee !== null && value !== reviewedFee)
    throw Object.assign(new Error(feeChanged(`${formatUnitsGrouped(value, 18)} ${gasCoin(cfg, cfg.hyperlane.network)}`)), { code: "FEE_CHANGED", fee: value });
  const chain = createPublicClient({ chain: cfg.hyperlane.chain, transport: custom({ request: ({ method, params }) => reads.evm(method, params) }) });
  const { request } = await chain.simulateContract({
    abi: HYPERLANE_EVM_ABI,
    account,
    address: token.evm.token,
    args: [cfg.hyperlane.dusk.domain, hash, amount],
    functionName: "transferRemote",
    value,
  });
  return walletClient.writeContract({ ...request, account: await reviewedEvmAccount(account) });
}
