// What the page reads of Hyperlane's routes. On Dusk, the deployment's node:
// each query's arguments and answer in rkyv, written by the Hyperlane data
// driver, or by hand where it has no entry (`paused`, `transfer_remote`'s
// own layout). On the EVM chain, the EVM wallet when it's on that chain,
// since a public RPC behind a load balancer can answer from a block or two
// back; the deployment's RPC otherwise, and where the wallet can't answer.

import { accountToRawKey } from "@dusk-network/networks/account";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, pad, toEventSelector, toHex } from "viem";

import { driverJson, fromHex, toHex as bytesHex } from "./data-driver.js";
import { formatToken } from "./format.js";
import { EVM_TRANSFER_GAS_FALLBACK, HYPERLANE_EVM_ABI, readBool, readU64, transferRemoteArgs } from "./hyperlane.js";

/**
 * The `state_version` each kind of route reports at ef912e9: WarpNative 5,
 * WarpDrc20Collateral 7 (a WarpDrc20 reports 8). The contracts can't be
 * upgraded, so another means another deployment.
 */
export const WARP_NATIVE_STATE_VERSION = 5;
export const WARP_COLLATERAL_STATE_VERSION = 7;
/** The memory the Mailbox takes no new payer past: 3 GiB, less what a new credit entry can allocate (13 pages). */
const NEW_PAYER_MEMORY = 3n * 1024n ** 3n - 13n * 65_536n;

const DISPATCH_ID = toEventSelector("DispatchId(bytes32)");
const PROCESS_ID = toEventSelector("ProcessId(bytes32)");

/** Why a transfer isn't sent: the route on Dusk isn't the one this page's book names. */
export const ROUTE_NOT_AS_BOOKED = "This route on Dusk doesn't send where this page expects, so nothing was sent.";
/** Why a transfer isn't sent: the Mailbox is near its memory limit for new payers. */
export const MAILBOX_FULL = "The bridge's Mailbox on Dusk takes no new transfers right now, so nothing was sent.";

const lower = (value) => String(value ?? "").toLowerCase();
const bare = (hex) => lower(hex).replace(/^0x/u, "");
const bytes32 = (hex) => [...fromHex(bare(hex).padStart(64, "0"))];

/**
 * Whether a wallet's error means it couldn't answer a read, so the RPC is
 * asked: a method or parameters it doesn't take, or a connection or node of
 * its that failed. A revert is an answer, however it's wrapped, as is a call
 * its node found the account can't pay for: the RPC, maybe a block behind,
 * isn't asked to say otherwise.
 */
function unanswered(error) {
  for (let each = error, depth = 0; each && typeof each === "object" && depth < 4; each = each.data ?? each.cause, depth += 1)
    if (each.code === 3 || /revert|insufficient funds/iu.test(String(each.message ?? ""))) return false;
  const code = error?.code;
  // No JSON-RPC code: the transport itself failed.
  if (code === undefined || code === null) return true;
  if ([-32601, -32602, 4100, 4200].includes(code)) return true;
  if ([-32603, -32005, -32002, -32000, 4900, 4901].includes(code)) return true;
  return /not supported|unsupported|method not found/iu.test(String(error?.message ?? ""));
}

/**
 * @param {object} deps
 * @param {object} deps.cfg the deployment config, with its `hyperlane`
 * @param {object} deps.node the Dusk node (dusk-node.js)
 * @param {(network: string, method: string, params: unknown[]) => Promise<any>} deps.rpc the deployment's RPCs
 * @param {(url: string, sha256: string) => Promise<object>} deps.loadDriver
 * @param {() => { chainId?: number | null, provider?: { request: Function } | null }} [deps.wallet] the EVM wallet, as it is now
 */
export function createHyperlaneReads({ cfg, loadDriver, node, rpc, wallet = () => ({}) }) {
  const hyperlane = cfg.hyperlane;
  const driver = () => loadDriver(hyperlane.driver.url, hyperlane.driver.sha256);

  // ---- Dusk -----------------------------------------------------------------

  /** A query, its arguments written by the driver and its answer read by it. */
  async function query(contractId, fnName, args) {
    const dd = await driver();
    const out = await node.contractCall(contractId, fnName, args === undefined ? new Uint8Array() : dd.encodeInputFn(fnName, driverJson(args)));
    return dd.decodeOutputFn(fnName, out);
  }

  /** A Moonlight account as the canonical DRC20 names it: its raw key. */
  const moonlight = (account) => {
    const raw = accountToRawKey(account);
    if (!raw) throw new Error("That isn't a Dusk account.");
    return { bytes: [...raw], kind: "Moonlight" };
  };

  /**
   * The route's fee for a transfer, in Lux (`quote_transfer_remote`): what it
   * pays the Mailbox's hooks to deliver it. It takes the transfer's own
   * arguments; before there are any, an amount of 1 to the token itself.
   */
  async function dispatchFee(token, { amount = 1n, recipient = token.evm.token } = {}) {
    const args = transferRemoteArgs({ amount, destination: hyperlane.evm.domain, recipient });
    return readU64(await node.contractCall(token.dusk.route, "quote_transfer_remote", args));
  }

  /**
   * Whether the route is the one the book names, before anything is signed,
   * either way: it sends to the token the book names on the EVM chain (its
   * enrolled router there), that token sends back to it (its router for
   * Dusk), and it's native, or a collateral route that locks the book's
   * token. Read for every request, since either owner can enroll another
   * router. Throws ROUTE_NOT_AS_BOOKED where it isn't; a read that fails
   * throws as it is.
   */
  async function checkRoute(token) {
    const [router, version, wrapped, back] = await Promise.all([
      query(token.dusk.route, "enrolled_router", [hyperlane.evm.domain]),
      query(token.dusk.route, "state_version"),
      token.native ? null : query(token.dusk.route, "wrapped_token"),
      call(token.evm.token, "routers", [hyperlane.dusk.domain]),
    ]);
    const same =
      bytesHex(Uint8Array.from(router)) === bytesHex(Uint8Array.from(bytes32(token.evm.token))) && lower(back) === `0x${token.dusk.route}`;
    const kind = token.native
      ? Number(version) === WARP_NATIVE_STATE_VERSION
      : Number(version) === WARP_COLLATERAL_STATE_VERSION && bytesHex(Uint8Array.from(wrapped)) === token.dusk.token;
    if (!same || !kind) throw new Error(ROUTE_NOT_AS_BOOKED);
  }

  /**
   * Whether the Mailbox takes the route as a payer of `fee`: a route spends
   * its dispatch credit to nothing each transfer, so it's a new payer, which
   * the Mailbox refuses within 13 pages of its 3 GiB. Throws MAILBOX_FULL then.
   */
  async function checkMailbox(token, fee) {
    if (fee <= 0n) return;
    const credit = BigInt(await query(hyperlane.dusk.mailbox, "fee_credit", [bytes32(token.dusk.route)]));
    if (credit > 0n) return;
    const memory = BigInt(await query(hyperlane.dusk.mailbox, "memory_bytes"));
    if (memory > NEW_PAYER_MEMORY) throw new Error(MAILBOX_FULL);
  }

  /** What `account` holds of a token issued on Dusk, in its smallest unit. */
  const tokenBalance = async (token, account) => BigInt(await query(token.dusk.token, "balance_of", { account: moonlight(account) }));

  /** What the token's route may take from `account`. */
  const allowance = async (token, account) =>
    BigInt(await query(token.dusk.token, "allowance", { owner: moonlight(account), spender: { bytes: bytes32(token.dusk.route), kind: "Contract" } }));

  /** Whether a token issued on Dusk is paused: it moves nothing then. One byte, as the canonical DRC20 answers. */
  const paused = async (token) => readBool(await node.contractCall(token.dusk.token, "paused", new Uint8Array()));

  /**
   * What each route holds in escrow for the account with recipient hash
   * `hash`, and whether the account is registered there: the first transfer
   * a route pays it waits until it's claimed.
   */
  async function escrow(hash, tokens = hyperlane.tokens) {
    const args = [bytes32(hash)];
    return Promise.all(
      tokens.map(async (token) => {
        const [registered, pending] = await Promise.all([query(token.dusk.route, "is_registered", args), query(token.dusk.route, "pending_balance", args)]);
        return { pending: BigInt(pending), registered: Boolean(registered), token };
      }),
    );
  }

  /** Whether Dusk's Mailbox delivered the message with this ID. */
  const deliveredOnDusk = async (messageId) => Boolean(await query(hyperlane.dusk.mailbox, "delivered", [bytes32(messageId)]));

  /**
   * The ID of the message a Dusk transaction dispatched: the Mailbox's
   * `dispatch_id` event of that transaction, in its block's events. Null
   * until the archive lists it.
   */
  async function dispatchedId(hash, blockHeight) {
    const data = await node.query(`contractEvents(height: ${BigInt(blockHeight)}) { json }`);
    const events = Array.isArray(data?.contractEvents?.json) ? data.contractEvents.json : [];
    const event = events.find(
      (each) => bare(each.origin) === bare(hash) && bare(each.source) === hyperlane.dusk.mailbox && each.topic === "dispatch_id" && !each.reverted,
    );
    if (!event) return null;
    const read = (await driver()).decodeEvent("dispatch_id", fromHex(event.data));
    return `0x${bytesHex(Uint8Array.from(read.message_id))}`;
  }

  // ---- The EVM chain ----------------------------------------------------------

  /**
   * An EVM request: to the wallet where it's connected on the route's chain,
   * else, or where it can't answer it (`unanswered`), to the deployment's
   * RPC. A call the wallet reverts is its answer: the RPC, maybe a block
   * behind, isn't asked to say otherwise.
   */
  async function evm(method, params) {
    const { chainId, provider } = wallet() ?? {};
    if (provider && chainId === hyperlane.chain.id) {
      try {
        return await provider.request({ method, params });
      } catch (error) {
        if (!unanswered(error)) throw error;
      }
    }
    return rpc(hyperlane.network, method, params);
  }

  const call = async (to, functionName, args = []) => {
    const data = await evm("eth_call", [{ data: encodeFunctionData({ abi: HYPERLANE_EVM_ABI, args, functionName }), to }, "latest"]);
    return decodeFunctionResult({ abi: HYPERLANE_EVM_ABI, data, functionName });
  };

  /**
   * The EVM side of a transfer to Dusk, for `owner`: the token it holds, the
   * gas coin, the gas price, and the fee the token takes as the call's value
   * to pay for delivery (`quoteGasPayment`). A read that fails is null.
   */
  async function evmState(token, owner) {
    const settle = (promise) => promise.then((value) => value, () => null);
    const [balance, coins, price, fee] = await Promise.all([
      settle(call(token.evm.token, "balanceOf", [owner])),
      settle(evm("eth_getBalance", [owner, "latest"]).then(BigInt)),
      settle(evm("eth_gasPrice", []).then(BigInt)),
      settle(call(token.evm.token, "quoteGasPayment", [hyperlane.dusk.domain])),
    ]);
    return { balance, deliveryFeeWei: fee, gasCoinWei: coins, gasPriceWei: price };
  }

  /**
   * What a transfer of `amount` to `recipient` (a Dusk account's hash)
   * charges, as the token itself quotes it (HypERC20's
   * `quoteTransferRemote`): the ETH it takes as the call's value (`native`)
   * and the token it takes (`token`). Refused, with why, where that's more
   * of the token than the amount, a fee this page can't show, or anything in
   * another token.
   */
  async function transferCharge(token, { amount, recipient }) {
    const quotes = await call(token.evm.token, "quoteTransferRemote", [hyperlane.dusk.domain, recipient, amount]);
    let native = 0n;
    let own = 0n;
    for (const quote of quotes) {
      if (BigInt(quote.token) === 0n) native += quote.amount;
      else if (lower(quote.token) === lower(token.evm.token)) own += quote.amount;
      else if (quote.amount > 0n) throw new Error("The bridge would also charge another token, which this page can't show, so nothing was sent.");
    }
    if (own > amount) throw new Error(`The bridge would also take ${formatToken(own - amount, token)} as a fee, which this page can't show yet, so nothing was sent.`);
    return { native, token: own };
  }

  /** What a `transferRemote` spends, or a usual figure until it can be estimated. */
  async function transferGas(token, { amount, owner, recipient, value }) {
    try {
      const data = encodeFunctionData({ abi: HYPERLANE_EVM_ABI, args: [hyperlane.dusk.domain, recipient, amount], functionName: "transferRemote" });
      return BigInt(await evm("eth_estimateGas", [{ data, from: owner, to: token.evm.token, value: toHex(value) }]));
    } catch {
      return EVM_TRANSFER_GAS_FALLBACK;
    }
  }

  /** Whether the EVM chain's Mailbox delivered the message with this ID. */
  const deliveredOnEvm = (messageId) => call(hyperlane.evm.mailbox, "delivered", [messageId]);

  /**
   * What a transfer to Dusk did on the EVM chain, from its receipt: null
   * until the chain has it. Its message ID is the Mailbox's `DispatchId`, and
   * what it sent and to whom the token's `SentTransferRemote`.
   */
  async function evmTransfer(hash, token) {
    const receipt = await evm("eth_getTransactionReceipt", [hash]);
    if (!receipt) return null;
    const ours = (log, address) => lower(log.address) === lower(address);
    const id = receipt.logs?.find((log) => ours(log, hyperlane.evm.mailbox) && lower(log.topics?.[0]) === DISPATCH_ID);
    let sent = null;
    for (const log of receipt.logs ?? []) {
      if (!ours(log, token.evm.token)) continue;
      try {
        const event = decodeEventLog({ abi: HYPERLANE_EVM_ABI, data: log.data, topics: log.topics });
        if (event.eventName === "SentTransferRemote") sent = event.args;
      } catch {}
    }
    const block = receipt.blockNumber ? await evm("eth_getBlockByNumber", [receipt.blockNumber, false]) : null;
    return {
      at: block?.timestamp ? Number(BigInt(block.timestamp)) * 1_000 : null,
      blockNumber: receipt.blockNumber ? BigInt(receipt.blockNumber) : null,
      failed: receipt.status === "0x0",
      feeWei: receipt.gasUsed && receipt.effectiveGasPrice ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) : null,
      from: receipt.from ? getAddress(receipt.from) : null,
      messageId: id?.topics?.[1] ? lower(id.topics[1]) : null,
      sent: sent ? { amount: sent.amount, destination: Number(sent.destination), recipient: lower(sent.recipient) } : null,
      to: receipt.to ? lower(receipt.to) : null,
    };
  }

  /** What a transaction on the EVM chain paid as its value, for the fee it carried. */
  const evmValue = async (hash) => {
    const tx = await evm("eth_getTransactionByHash", [hash]);
    return tx?.value === undefined || tx?.value === null ? null : BigInt(tx.value);
  };

  /**
   * Where the EVM chain's Mailbox processed a message: its `ProcessId` log,
   * from `fromBlock` to the latest, with that block's time. Null where none
   * is found.
   */
  async function processedOnEvm(messageId, fromBlock) {
    const logs = await evm("eth_getLogs", [
      { address: hyperlane.evm.mailbox, fromBlock: toHex(BigInt(fromBlock)), toBlock: "latest", topics: [PROCESS_ID, pad(messageId)] },
    ]);
    const log = Array.isArray(logs) ? logs.find((each) => !each.removed) : null;
    if (!log) return null;
    const block = await evm("eth_getBlockByNumber", [log.blockNumber, false]);
    return { at: block?.timestamp ? Number(BigInt(block.timestamp)) * 1_000 : null, hash: lower(log.transactionHash) };
  }

  /** The EVM chain's latest block number. */
  const evmHead = async () => BigInt(await evm("eth_blockNumber", []));

  return Object.freeze({
    allowance,
    checkMailbox,
    checkRoute,
    deliveredOnDusk,
    deliveredOnEvm,
    dispatchFee,
    dispatchedId,
    driver,
    escrow,
    evm,
    evmHead,
    evmState,
    evmTransfer,
    evmValue,
    paused,
    processedOnEvm,
    tokenBalance,
    transferCharge,
    transferGas,
  });
}
