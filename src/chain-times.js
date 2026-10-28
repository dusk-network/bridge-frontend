// What the chains say about how long DuskEVM's routes take, kept per
// network: read when a page asks, at most every 10 minutes, and kept in this
// browser for a day, so a page shows it at once on the next visit.

const L1_BLOCK = "0x4200000000000000000000000000000000000015";
/** `number()` on DuskEVM's L1Block predeploy: the Dusk block it last took in. */
const L1_BLOCK_NUMBER = "0x8381f58a";

const TTL_MS = 10 * 60_000;
const MAX_AGE_MS = 86_400_000;

/**
 * How far DuskEVM trails Dusk, in seconds: from Dusk's time for the block
 * DuskEVM last took in, to DuskEVM's latest block. A deposit arrives about
 * this long after its Dusk block. The time DuskEVM itself keeps for that
 * block runs behind Dusk's, so Dusk's own is read.
 */
export async function readDepositLag({ node, rpcBatch }) {
  const [head, origin] = await rpcBatch("dusk-evm", [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_call", params: [{ data: L1_BLOCK_NUMBER, to: L1_BLOCK }, "latest"] },
  ]);
  if (!head?.timestamp || !origin || origin === "0x") throw new Error("DuskEVM didn't say which Dusk block it's on.");
  const data = await node.query(`block(height: ${BigInt(origin)}) { header { timestamp } }`);
  const at = data?.block?.header?.timestamp;
  if (at === undefined || at === null) throw new Error("Dusk didn't give that block's time.");
  return Math.max(0, Number(BigInt(head.timestamp)) - Number(at));
}

/**
 * @param {object} deps
 * @param {string} deps.key where this network's values are kept
 * @param {{ deposit: () => Promise<number>, withdrawal: () => Promise<object> }} deps.read
 * @param {Storage | null} [deps.storage]
 * @param {() => number} [deps.now]
 */
export function createChainTimes({ key, read, storage = globalThis.localStorage ?? null, now = Date.now, ttlMs = TTL_MS }) {
  let kept = {};
  try {
    const parsed = JSON.parse(storage?.getItem(key) ?? "null");
    if (parsed && typeof parsed === "object") kept = parsed;
  } catch {}
  let running = null;

  const fresh = (part, age) => Boolean(part?.at) && now() - part.at < age;

  /** What the chains said, each part at most a day old; null when nothing is known. */
  function get() {
    const parts = Object.entries(kept).filter(([, part]) => fresh(part, MAX_AGE_MS));
    return parts.length ? Object.fromEntries(parts) : null;
  }

  async function load() {
    const stale = Object.keys(read).filter((name) => !fresh(kept[name], ttlMs));
    if (!stale.length) return false;
    const answers = await Promise.allSettled(stale.map((name) => read[name]()));
    let changed = false;
    const next = { ...kept };
    stale.forEach((name, index) => {
      const answer = answers[index];
      // A part that couldn't be read keeps what was read before.
      if (answer.status !== "fulfilled" || answer.value === null || answer.value === undefined) return;
      const value = name === "deposit" ? { lagSeconds: answer.value } : answer.value;
      const { at: _at, ...before } = kept[name] ?? {};
      if (JSON.stringify(before) !== JSON.stringify(value)) changed = true;
      next[name] = { ...value, at: now() };
    });
    kept = next;
    try {
      storage?.setItem(key, JSON.stringify(kept));
    } catch {}
    return changed;
  }

  /** Reads what's older than 10 minutes; whether anything shown changed. */
  function refresh() {
    running ??= load().finally(() => {
      running = null;
    });
    return running;
  }

  return Object.freeze({ get, refresh });
}
