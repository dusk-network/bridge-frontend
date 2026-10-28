import assert from "node:assert/strict";
import test from "node:test";

const createProvider = () => ({
  on() {},
  removeListener() {},
  async request({ method }) {
    if (method === "eth_accounts" || method === "eth_requestAccounts")
      return ["0x0000000000000000000000000000000000000001"];
    if (method === "eth_chainId") return "0x1";
    throw new Error(`Unexpected method: ${method}`);
  },
});

test("connects to a legacy injected EVM provider", async () => {
  globalThis.ethereum = createProvider();
  const wallet = await import(`./evm-wallet.js?legacy=${Date.now()}`);

  const state = await wallet.connectEvmWallet();

  assert.equal(state.account, "0x0000000000000000000000000000000000000001");
  assert.equal(state.chainId, 1);
  delete globalThis.ethereum;
});

test("discovers and connects to an EIP-6963 provider", async () => {
  const events = new EventTarget();
  globalThis.addEventListener = events.addEventListener.bind(events);
  globalThis.dispatchEvent = events.dispatchEvent.bind(events);
  events.addEventListener("eip6963:requestProvider", () => {
    events.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: { provider: createProvider() },
      }),
    );
  });
  const wallet = await import(`./evm-wallet.js?eip6963=${Date.now()}`);

  const state = await wallet.connectEvmWallet();

  assert.equal(state.account, "0x0000000000000000000000000000000000000001");
  assert.equal(state.chainId, 1);
  delete globalThis.addEventListener;
  delete globalThis.dispatchEvent;
});
