import { driverJson, fromHex, toHex } from "./data-driver.js";

// Multicall for Dusk takes at most 256 calls and 64 KiB in or out per query;
// bridge screens make far fewer reads, so a smaller batch leaves headroom.
const MAX_BATCH = 64;

/**
 * Contract reads made in the same tick go to the node as one Multicall for
 * Dusk `aggregate` query; a lone read is sent directly. Each inner call is
 * encoded and decoded with its own contract's data driver.
 */
export function createContractReader({ node, multicall = null }) {
  let queue = [];

  async function direct({ contract, fnName, input }) {
    const driver = await contract.driver();
    const output = await node.contractCall(contract.id, fnName, input);
    return driver.decodeOutputFn(fnName, output);
  }

  async function aggregate(batch) {
    const envelopeDriver = await multicall.driver();
    const calls = batch.map(({ contract, fnName, input }) => ({
      contract: contract.id,
      fn_args: toHex(input),
      fn_name: fnName,
      gas_limit: "0",
    }));
    const reply = envelopeDriver.decodeOutputFn(
      "aggregate",
      await node.contractCall(
        multicall.id,
        "aggregate",
        envelopeDriver.encodeInputFn("aggregate", driverJson(calls)),
      ),
    );
    if (!Array.isArray(reply?.results) || reply.results.length !== batch.length)
      throw new Error("Multicall reply doesn't match its calls.");
    return reply.results;
  }

  async function settle(batch) {
    if (!multicall?.id || batch.length === 1) {
      await Promise.all(
        batch.map((item) => direct(item).then(item.resolve, item.reject)),
      );
      return;
    }
    let results;
    try {
      results = await aggregate(batch);
    } catch {
      // The whole query failed (no multicall here, node error): read one by one.
      await Promise.all(
        batch.map((item) => direct(item).then(item.resolve, item.reject)),
      );
      return;
    }
    await Promise.all(
      batch.map(async (item, index) => {
        const result = results[index];
        try {
          if (!Object.hasOwn(result ?? {}, "Ok")) throw callError(result?.Err);
          const driver = await item.contract.driver();
          item.resolve(driver.decodeOutputFn(item.fnName, fromHex(result.Ok)));
        } catch (error) {
          item.reject(error);
        }
      }),
    );
  }

  function flush() {
    const batch = queue;
    queue = [];
    for (let start = 0; start < batch.length; start += MAX_BATCH)
      void settle(batch.slice(start, start + MAX_BATCH));
  }

  function read(contract, fnName, args) {
    return contract.driver().then(
      (driver) =>
        new Promise((resolve, reject) => {
          queue.push({
            contract,
            fnName,
            input: driver.encodeInputFn(fnName, driverJson(args)),
            reject,
            resolve,
          });
          if (queue.length === 1) setTimeout(flush, 0);
        }),
    );
  }

  return Object.freeze({ read });
}

function callError(error) {
  if (error && typeof error === "object" && "Panic" in error)
    return new Error(String(error.Panic));
  return new Error(
    typeof error === "string" ? `Contract call failed: ${error}` : "Contract call failed.",
  );
}

/** `contract.call.<fn>(args)`, the shape the withdrawal logic reads with. */
export function contractFacade(reader, contract) {
  return Object.freeze({
    call: new Proxy(
      {},
      {
        // Not thenable, so the facade can be passed through promises.
        get: (_target, fnName) =>
          fnName === "then"
            ? undefined
            : (args) => reader.read(contract, String(fnName), args),
      },
    ),
    id: contract.id,
  });
}
