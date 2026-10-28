import { DEFAULT_BRIDGE_MIN_GAS_LIMIT } from "@dusk/evm-sdk";

import { formatUnits } from "viem";
import { config } from "./config.js";
import { fromHex } from "./data-driver.js";
import { networkName } from "./names.js";
import { DEPOSIT_GAS_LIMIT, gasAtNodePrice } from "./gas.js";
import { normalizeEvmAddress } from "./validation.js";

/**
 * The least gas DuskEVM gives the deposit's own call: the DuskEVM SDK's
 * default, 200,000, as OP Stack bridges use. The call itself, crediting an
 * address that has no code, used 27,213 gas on DuskEVM testnet (Oct 2026);
 * the rest leaves room for a contract that receives the DUSK.
 */
export const BRIDGE_DEPOSIT_MIN_GAS_LIMIT = DEFAULT_BRIDGE_MIN_GAS_LIMIT;
export const DEPOSIT_FN_NAME = "depositETHToWithValue";
const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

function hexToBytes(input, expectedLength) {
  const bytes = fromHex(input);
  if (bytes.length !== expectedLength)
    throw new Error(`Expected ${expectedLength} bytes.`);
  return bytes;
}

function writeUintLe(out, offset, value, bytes) {
  let remaining = value;
  for (let index = 0; index < bytes; index += 1) {
    out[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function readUintLe(bytes, offset, length) {
  let out = 0n;
  for (let index = length - 1; index >= 0; index -= 1)
    out = (out << 8n) + BigInt(bytes[offset + index]);
  return out;
}

/** `depositETHToWithValue(u64, [u8; 20], u32, Vec<u8>)`, rkyv as Rust writes it. */
export function encodeDepositArgs({ amountLux, minGasLimit, to }) {
  const amount = BigInt(amountLux);
  const gas = BigInt(minGasLimit);
  if (amount <= 0n || amount > UINT64_MAX)
    throw new RangeError("Deposit amount must fit in u64.");
  if (gas < 0n || gas > UINT32_MAX)
    throw new RangeError("Minimum gas limit must fit in u32.");
  const out = new Uint8Array(40);
  writeUintLe(out, 0, amount, 8);
  out.set(hexToBytes(normalizeEvmAddress(to), 20), 8);
  writeUintLe(out, 28, gas, 4);
  writeUintLe(out, 32, 0xffffffe0n, 4);
  return out;
}

/**
 * The amount and DuskEVM recipient of a deposit call. rkyv puts the argument
 * tuple last, after any `extraData` bytes it points back to.
 */
export function decodeDepositArgs(data) {
  const bytes = typeof data === "string" ? fromHex(data) : Uint8Array.from(data);
  if (bytes.length < 40) throw new Error("Deposit arguments are too short.");
  const root = bytes.length - 40;
  return Object.freeze({
    amountLux: readUintLe(bytes, root, 8),
    minGasLimit: Number(readUintLe(bytes, root + 28, 4)),
    to: normalizeEvmAddress(
      `0x${Array.from(bytes.slice(root + 8, root + 28), (b) => b.toString(16).padStart(2, "0")).join("")}`,
    ),
  });
}

/** What the wallet shows as the dApp's own (unverified) description. */
export function depositDisplay({ amountLux, recipient }) {
  return {
    label: `Bridge ${formatUnits(amountLux, 9)} DUSK to ${networkName(config, "dusk-evm")}`,
    recipient,
  };
}

/**
 * The deposit as Dusk Wallet receives it: the review shows this request, and
 * the same request is sent.
 */
export async function depositRequest({ amountLux, node, recipient }) {
  if (!config.duskEvm.enabled)
    throw new Error("DuskEVM deposits are not configured for this deployment.");
  const to = normalizeEvmAddress(recipient);
  return {
    contractId: config.duskEvm.l1StandardBridgeContractId,
    depositLux: BigInt(amountLux),
    display: depositDisplay({ amountLux, recipient: to }),
    fnArgs: encodeDepositArgs({
      amountLux,
      minGasLimit: BRIDGE_DEPOSIT_MIN_GAS_LIMIT,
      to,
    }),
    fnName: DEPOSIT_FN_NAME,
    gas: await gasAtNodePrice(DEPOSIT_GAS_LIMIT, node),
  };
}
