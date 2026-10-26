// Reads from the deployment's own Dusk node. The wallet extension is only
// asked to sign and send; chain state never comes through it.

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
    throw new Error("Dusk transaction hash is invalid.");
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

  /** The node's median gas price, the price the wallet itself defaults to. */
  async function gasPrice() {
    try {
      const response = await post("/on/blocks/gas-price", {
        body: "100",
      });
      const median = BigInt((await response.json())?.median ?? 0);
      return median > 0n ? median : 1n;
    } catch {
      return 1n;
    }
  }

  // Transaction lookups made in the same tick share one aliased query.
  let pending = [];
  function transaction(hash) {
    const id = normalizeHash(hash);
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
        ids.map((id, index) => `t${index}: tx(hash: "${id}") { ${TX_FIELDS} }`).join(" "),
      );
      for (const item of batch)
        item.resolve(parseTransaction(data?.[`t${ids.indexOf(item.id)}`]));
    } catch (error) {
      for (const item of batch) item.reject(error);
    }
  }

  async function latestBlockTimestamp() {
    const data = await query("block(height: -1) { header { timestamp } }");
    const timestamp = data?.block?.header?.timestamp;
    if (timestamp === undefined || timestamp === null)
      throw new Error("Latest Dusk block timestamp is unavailable.");
    return BigInt(timestamp);
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

  /** Moonlight transfers whose memo is exactly `memo` (archive nodes). */
  async function transfersByMemo(memo) {
    const text = String(memo).replace(/["\\]/gu, "");
    const data = await query(`transactionsByMemo(memo: "${text}") { json }`);
    const entries = data?.transactionsByMemo?.json;
    return Array.isArray(entries) ? entries : [];
  }

  return Object.freeze({
    accountBalance,
    contractCall,
    gasPrice,
    latestBlockTimestamp,
    query,
    transaction,
    transfersByMemo,
    url: base,
  });
}
