// The Dusk account a DuskEVM withdrawal pays: its `extraData` carries the
// account's BLS key as raw affine coordinates (Montgomery form, little-endian
// limbs). The account string is that key compressed the way Dusk writes it:
// x as c1 || c0 big-endian, with the compression and sign flags on top.

import { encodeBase58 } from "./base58.js";
import { fromHex } from "./data-driver.js";

const P = BigInt(
  "0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab",
);
const R_INVERSE = BigInt(
  "0x14fec701e8fb0ce9ed5e64273c4f538b1797ab1458a88de9343ea97914956dc87fe11274d898fafbf4d38259380b4820",
);
const FP_BYTES = 48;
const RAW_BYTES = 4 * FP_BYTES + 1;
const HALF = (P - 1n) / 2n;

function fp(raw, offset) {
  let montgomery = 0n;
  for (let index = FP_BYTES - 1; index >= 0; index -= 1)
    montgomery = (montgomery << 8n) | BigInt(raw[offset + index]);
  if (montgomery >= P) throw new Error("Field element out of range.");
  return (montgomery * R_INVERSE) % P;
}

function bigEndian(value) {
  const out = new Uint8Array(FP_BYTES);
  let rest = value;
  for (let index = FP_BYTES - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** The base58 Dusk account for a raw key, or null if it isn't one. */
export function rawKeyToDuskAccount(raw) {
  const bytes = Uint8Array.from(raw ?? []);
  if (bytes.length !== RAW_BYTES || bytes[RAW_BYTES - 1] !== 0) return null;
  try {
    const [x0, x1, y0, y1] = [0, 1, 2, 3].map((index) => fp(bytes, index * FP_BYTES));
    const largest = y1 > HALF || (y1 === 0n && y0 > HALF);
    const compressed = new Uint8Array(2 * FP_BYTES);
    compressed.set(bigEndian(x1), 0);
    compressed.set(bigEndian(x0), FP_BYTES);
    compressed[0] |= 0x80 | (largest ? 0x20 : 0);
    return encodeBase58(compressed);
  } catch {
    return null;
  }
}

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Who a withdrawal pays on Dusk, from its `extraData`: a Dusk account
 * (tag 2, version 1, kind 0, then the raw key), or a Dusk contract's ID (a
 * contract credit: tag 32, version 1, then the ID). Null for anything else.
 */
export function withdrawalRecipientAccount(extraData) {
  try {
    const bytes = typeof extraData === "string" ? fromHex(extraData) : Uint8Array.from(extraData);
    if (bytes.length === 3 + RAW_BYTES && bytes[0] === 2 && bytes[1] === 1 && bytes[2] === 0)
      return rawKeyToDuskAccount(bytes.slice(3));
    if (bytes.length >= 34 && bytes[0] === 32 && bytes[1] === 1) return hex(bytes.slice(2, 34));
    return null;
  } catch {
    return null;
  }
}
