import { driverJson } from "./data-driver.js";

// Multicall for Dusk takes at most 256 calls and 64 KiB in or out per query;
// bridge screens make far fewer reads, so a smaller batch leaves headroom.
export const MAX_BATCH = 64;

/**
 * `contract.call.<fn>(args)`, the shape the withdrawal logic reads with. Each
 * read is encoded and decoded with its contract's data driver and sent
 * through the node, whose fetch sends the reads made in one task as one
 * Multicall for Dusk `aggregate` query.
 */
export function contractFacade(node, contract) {
  async function read(fnName, args) {
    const driver = await contract.driver();
    const output = await node.contractCall(contract.id, fnName, driver.encodeInputFn(fnName, driverJson(args)));
    return driver.decodeOutputFn(fnName, output);
  }
  return Object.freeze({
    call: new Proxy(
      {},
      {
        // Not thenable, so the facade can be passed through promises.
        get: (_target, fnName) => (fnName === "then" ? undefined : (args) => read(String(fnName), args)),
      },
    ),
    id: contract.id,
  });
}
