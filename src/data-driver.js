// Runs a contract's data-driver WASM: JSON in, rkyv bytes out, and back.
// The FFI matches the data drivers Dusk Forge builds (and Dusk Connect runs).

const OUT_START = 64 * 1024;
const OUT_MAX = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function fromHex(hex) {
  const value = String(hex).replace(/^0x/iu, "");
  if (value.length % 2 !== 0 || /[^0-9a-f]/iu.test(value))
    throw new TypeError("Expected hexadecimal bytes.");
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1)
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export async function sha256Hex(bytes) {
  return toHex(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
  );
}

/** Arguments as the driver reads them: JSON with bigints as decimal strings. */
export function driverJson(args) {
  return args === undefined || args === null
    ? "null"
    : JSON.stringify(args, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
}

export async function loadDataDriver(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, { env: {} });
  const ffi = instance.exports;
  if (!ffi.memory || typeof ffi.alloc !== "function")
    throw new Error("Invalid data driver: missing memory or alloc.");
  const memory = ffi.memory;

  const put = (data) => {
    const ptr = ffi.alloc(data.length);
    new Uint8Array(memory.buffer, ptr, data.length).set(data);
    return ptr;
  };
  const free = (ptr, len) => {
    try {
      ffi.dealloc(ptr, len);
    } catch {
      // The driver owns its allocator; a failed free only leaks scratch space.
    }
  };
  const readOut = (ptr, size) => {
    const length = new DataView(memory.buffer, ptr, 4).getUint32(0, true);
    if (length > size - 4) throw new Error(`Invalid output size: ${length}`);
    return new Uint8Array(memory.buffer, ptr + 4, length).slice();
  };
  const lastError = () => {
    const size = 4 * 1024;
    const ptr = ffi.alloc(size);
    try {
      ffi.get_last_error(ptr, size);
      return decoder.decode(readOut(ptr, size));
    } catch {
      return "";
    } finally {
      free(ptr, size);
    }
  };
  const callOut = (call) => {
    for (let size = OUT_START; size <= OUT_MAX; size *= 2) {
      const ptr = ffi.alloc(size);
      try {
        const code = call(ptr, size);
        if (code === 0) return readOut(ptr, size);
        const error = lastError();
        if (/buffer.*small|insufficient|out_size/iu.test(error) && size < OUT_MAX)
          continue;
        throw new Error(error || `Data driver call failed (${code}).`);
      } finally {
        free(ptr, size);
      }
    }
    throw new Error("Data driver output is too large.");
  };
  const withBytes = (data, use) => {
    const ptr = put(data);
    try {
      return use(ptr, data.length);
    } finally {
      free(ptr, data.length);
    }
  };
  const twoInputs = (exportName, first, second) =>
    withBytes(encoder.encode(first), (aPtr, aLen) =>
      withBytes(second, (bPtr, bLen) =>
        callOut((outPtr, outSize) =>
          ffi[exportName](aPtr, aLen, bPtr, bLen, outPtr, outSize),
        ),
      ),
    );

  try {
    ffi.init?.();
  } catch {
    // Drivers without global state have nothing to initialise.
  }

  return Object.freeze({
    encodeInputFn: (fnName, json) =>
      twoInputs("encode_input_fn", String(fnName), encoder.encode(json)),
    decodeOutputFn: (fnName, bytes) =>
      JSON.parse(decoder.decode(twoInputs("decode_output_fn", fnName, bytes))),
    decodeInputFn: (fnName, bytes) =>
      JSON.parse(decoder.decode(twoInputs("decode_input_fn", fnName, bytes))),
  });
}

/**
 * Loads each driver once, from the app's own files, and refuses one whose
 * SHA-256 differs from the pinned value.
 */
export function createDriverLoader({ fetch = globalThis.fetch } = {}) {
  const cache = new Map();
  return function load(url, sha256) {
    const key = `${url}#${sha256}`;
    if (!cache.has(key)) {
      const pending = (async () => {
        const response = await fetch(url);
        if (!response.ok)
          throw new Error(`The data driver ${url} is unavailable.`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (sha256 && (await sha256Hex(bytes)) !== sha256.toLowerCase())
          throw new Error(`The data driver ${url} doesn't match its pinned hash.`);
        return loadDataDriver(bytes);
      })();
      pending.catch(() => cache.delete(key));
      cache.set(key, pending);
    }
    return cache.get(key);
  };
}
