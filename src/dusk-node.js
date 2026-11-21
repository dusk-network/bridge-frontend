// Reads from the deployment's own Dusk node. The wallet extension is only
// asked to sign and send; chain state never comes through it.

import { GAS_PRICE_MINIMUM, defaultGasPrice } from "./gas.js";

const RETRYABLE = new Set([429, 502, 503, 504]);
const TX_FIELDS =
  "blockHeight blockTimestamp err gasSpent id tx { txType memo callData { contractId fnName data } json }";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rusk's GraphQL endpoint takes the query text itself, wrapped in `query { }`. */
export function graphqlBody(selection) {
  return `query { ${selection} }`;
}

// Rusk writes u64 amounts (a transfer's value and deposit, an event's value)
// as bare JSON numbers, which JSON.parse rounds above 2^53. An integer past
// that is read as its text instead; amounts are read with BigInt either way.
const LONG_INTEGER = /("(?:[^"\\]|\\.)*")|(?<![\d.eE+-])-?\d{16,}(?![\d.eE])/gu;

/** JSON.parse that keeps integers past 2^53 exact, as strings. */
export function parseJsonExact(text) {
  return JSON.parse(
    String(text).replace(LONG_INTEGER, (match, string) =>
      string ?? (Number.isSafeInteger(Number(match)) ? match : `"${match}"`),
    ),
  );
}

function normalizeHash(hash) {
  const value = String(hash ?? "").replace(/^0x/iu, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new Error("Dusk transaction ID is invalid.");
  return value;
}

function parseTransaction(raw) {
  if (!raw) return null;
  let json = null;
  try {
    json = raw.tx?.json ? parseJsonExact(raw.tx.json) : null;
  } catch {
    json = null;
  }
  return Object.freeze({
    blockHeight: BigInt(raw.blockHeight),
    blockTimestamp:
      raw.blockTimestamp === undefined || raw.blockTimestamp === null
        ? null
        : BigInt(raw.blockTimestamp),
    callData: raw.tx?.callData ?? null,
    error: raw.err ?? null,
    gasSpent: raw.gasSpent ?? null,
    hash: raw.id ?? null,
    json,
    memo: raw.tx?.memo ?? null,
  });
}

/** The last finalized block's height, as `lastBlockPair` gives it, or null. */
function finalizedHeight(pair) {
  try {
    return BigInt(pair.json.last_finalized_block[0]);
  } catch {
    return null;
  }
}

/**
 * A Dusk transaction this page sent, once it's confirmed, as the step after
 * it needs: its record from the `node`. One that failed throws, marked
 * FAILED_ON_DUSK; one not confirmed after `tries` checks `wait` ms apart
 * throws saying so, and to check the wallet before reviewing again.
 */
export async function confirmedOnDusk(node, hash, what, { tries = 30, wait = 3_000 } = {}) {
  for (let tried = 0; tried < tries; tried += 1) {
    const tx = await node.transaction(hash).catch(() => null);
    if (tx?.error) throw Object.assign(new Error(`The ${what} failed on Dusk: ${tx.error}`), { code: "FAILED_ON_DUSK" });
    if (tx) return tx;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error(`The ${what} isn't confirmed yet. Check Dusk Wallet's activity, then review again.`);
}

export function createDuskNode({ url, fetch = globalThis.fetch }) {
  const base = String(url ?? "").replace(/\/+$/u, "");
  if (!/^https?:\/\//iu.test(base))
    throw new Error("The Dusk node URL must be an http(s) URL.");

  async function post(path, init) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${base}${path}`, { method: "POST", ...init });
      if (response.ok || attempt === 2 || !RETRYABLE.has(response.status))
        return response;
      await wait(250 * 2 ** attempt);
    }
  }

  async function query(selection) {
    const response = await post("/on/graphql/query", {
      body: graphqlBody(selection),
    });
    const text = await response.text();
    let body;
    try {
      body = parseJsonExact(text);
    } catch {
      throw new Error(
        `Dusk node query failed with HTTP ${response.status}.`,
      );
    }
    const errors = Array.isArray(body) ? body : body?.errors;
    if (errors?.length)
      throw new Error(errors[0]?.message ?? "Dusk node query failed.");
    if (!response.ok)
      throw new Error(`Dusk node query failed with HTTP ${response.status}.`);
    return body && "data" in body ? body.data : body;
  }

  async function contractCall(contractId, fnName, bytes) {
    const id = String(contractId).replace(/^0x/iu, "").toLowerCase();
    const response = await post(`/on/contracts:${id}/${fnName}`, {
      body: bytes,
      headers: {
        accept: "application/octet-stream",
        "content-type": "application/octet-stream",
      },
    });
    if (!response.ok)
      throw new Error(
        (await response.text()) || `Contract query failed with HTTP ${response.status}.`,
      );
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * The gas price Dusk Wallet starts a transaction from (`defaultGasPrice`),
   * from what waits in the node's mempool, as the wallet reads it: what the
   * bridge asks for, so the wallet's window reads it as the network's price.
   * Not the node's own median of what waits, which one transaction at a high
   * price sets. The minimum where the mempool can't be read.
   */
  /**
   * The price Dusk Wallet starts from, as the node's mempool says it now, and
   * whether the network is busy: what waits asks more than that price pays.
   * The minimum, not busy, where the node can't say.
   */
  async function networkGas() {
    try {
      const { busy, price } = defaultGasPrice((await query("mempoolTxs { gasPrice gasLimit }"))?.mempoolTxs);
      return { busy, price };
    } catch {
      return { busy: false, price: GAS_PRICE_MINIMUM };
    }
  }

  async function gasPrice() {
    return (await networkGas()).price;
  }

  // Transaction lookups made in the same tick share one aliased query, with
  // the last finalized block: a transaction in a block at or under it is
  // kept, and later lookups of it on this page take it from here.
  const final = new Map();
  let pending = [];
  function transaction(hash) {
    const id = normalizeHash(hash);
    if (final.has(id)) return Promise.resolve(final.get(id));
    return new Promise((resolve, reject) => {
      pending.push({ id, reject, resolve });
      if (pending.length === 1) queueMicrotask(flushTransactions);
    });
  }
  async function flushTransactions() {
    const batch = pending;
    pending = [];
    const ids = [...new Set(batch.map(({ id }) => id))];
    try {
      const data = await query(
        [...ids.map((id, index) => `t${index}: tx(hash: "${id}") { ${TX_FIELDS} }`), "pair: lastBlockPair { json }"].join(" "),
      );
      const finalized = finalizedHeight(data?.pair);
      const found = ids.map((id, index) => parseTransaction(data?.[`t${index}`]));
      found.forEach((tx, index) => {
        if (tx && finalized !== null && tx.blockHeight <= finalized) final.set(ids[index], tx);
      });
      for (const item of batch) item.resolve(found[ids.indexOf(item.id)]);
    } catch (error) {
      for (const item of batch) item.reject(error);
    }
  }

  /** The latest block's height and time: what contract times are counted from. */
  async function latestBlock() {
    const data = await query("block(height: -1) { header { height timestamp } }");
    const header = data?.block?.header;
    if (header?.timestamp === undefined || header?.timestamp === null || header?.height === undefined || header?.height === null)
      throw new Error("Dusk didn't give its latest time.");
    return Object.freeze({ height: BigInt(header.height), timestamp: BigInt(header.timestamp) });
  }

  /** A public account's balance in Lux. */
  async function accountBalance(account) {
    const key = String(account ?? "").trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/u.test(key)) throw new Error("Dusk account is not valid base58.");
    const response = await post(`/on/account:${key}/status`, {});
    if (!response.ok) throw new Error(`Dusk balance query failed with HTTP ${response.status}.`);
    const text = await response.text();
    // The balance can exceed 2^53 Lux: read it as text.
    const match = /"balance"\s*:\s*"?(\d+)/u.exec(text);
    if (!match) throw new Error("The Dusk node gave no balance.");
    return BigInt(match[1]);
  }

  return Object.freeze({
    accountBalance,
    contractCall,
    gasPrice,
    networkGas,
    latestBlock,
    query,
    transaction,
    url: base,
  });
}
