// Pages live in the URL hash, so any static host serves them and a receipt
// link opens the same transfer on any device: `#/transfer/<hash>`.

const HASH = /^(0x)?[0-9a-f]{64}$/u;

/** A transaction hash as its chain writes it: 0x on EVM chains, bare on Dusk. */
export function canonicalHash(input) {
  const value = String(input ?? "").trim().toLowerCase();
  return HASH.test(value) ? value : null;
}

export const transferHref = (hash) => `#/transfer/${canonicalHash(hash) ?? ""}`;

/** The full receipt link for `hash`, from the page's own address. */
export function receiptUrl(hash, location = globalThis.location) {
  const base = location ? `${location.origin}${location.pathname}` : "";
  return `${base}${transferHref(hash)}`;
}

/**
 * The page a hash names:
 * - `{ page: "home" }`
 * - `{ page: "move", task }`
 * - `{ page: "transfer", hash }`
 * - `{ page: "transfers" }`
 * - `{ page: "lookup" }`
 */
/** A path part as text; a malformed escape such as "%" stays as typed. */
function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Whether a page quotes fees or times, so a new gas price or route time draws
 * it again. Look up quotes neither: nothing redraws it while a hash is typed.
 */
export const quotesOn = (page) => ["home", "move", "transfer", "transfers"].includes(page?.page);

export function parseLocation(hash) {
  const path = String(hash ?? "").replace(/^#\/?/u, "").replace(/\/+$/u, "");
  const [head, ...rest] = path.split("/").map(decodePart);
  if (head === "move" && /^[a-z-]+$/u.test(rest[0] ?? "")) return { page: "move", task: rest[0] };
  if (head === "transfer") {
    const value = canonicalHash(rest[0]);
    return value ? { hash: value, page: "transfer" } : { page: "lookup", query: rest[0] ?? "" };
  }
  if (head === "transfers") return { page: "transfers" };
  if (head === "lookup") return { page: "lookup", query: rest[0] ?? "" };
  return { page: "home" };
}
