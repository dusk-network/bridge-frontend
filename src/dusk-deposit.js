import { duskEvmDepositConfigured, config } from "./config.js";
import { sendDuskContractCall } from "./dusk-wallet.js";
import { normalizeEvmAddress } from "./validation.js";

export const BRIDGE_DEPOSIT_MIN_GAS_LIMIT = 200_000;
const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

function hexToBytes(input, expectedLength) {
  const value = String(input).replace(/^0x/u, "");
  if (!/^(?:[0-9a-f]{2})+$/iu.test(value))
    throw new Error("Expected hexadecimal bytes.");
  const bytes = Uint8Array.from(
    value.match(/../gu).map((byte) => Number.parseInt(byte, 16)),
  );
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

export async function submitDuskEvmDeposit({ amountLux, recipient }) {
  if (!duskEvmDepositConfigured())
    throw new Error("DuskEVM deposits are not configured for this deployment.");
  return sendDuskContractCall({
    chainId: config.duskEvm.l1ChainId,
    contractId: config.duskEvm.l1StandardBridgeContractId,
    depositLux: amountLux,
    fnArgs: encodeDepositArgs({
      amountLux,
      minGasLimit: BRIDGE_DEPOSIT_MIN_GAS_LIMIT,
      to: recipient,
    }),
    fnName: "depositETHToWithValue",
  });
}
