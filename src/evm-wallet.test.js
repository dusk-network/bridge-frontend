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

test("requests the route's EVM source chain", async () => {
  const requests = [];
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    async request(request) {
      requests.push(request);
      if (request.method === "eth_accounts")
        return ["0x0000000000000000000000000000000000000001"];
      if (request.method === "eth_chainId") return "0x1";
      if (request.method === "wallet_switchEthereumChain") return null;
      throw new Error(`Unexpected method: ${request.method}`);
    },
  };
  const wallet = await import(`./evm-wallet.js?switch=${Date.now()}`);
  await wallet.initializeEvmWallet();
  await wallet.ensureEvmChain({ chainId: 11_155_111 });

  assert.deepEqual(
    requests.find(({ method }) => method === "wallet_switchEthereumChain")
      ?.params,
    [{ chainId: "0xaa36a7" }],
  );
  delete globalThis.ethereum;
});

test("an account the wallet gives in lower case is used with its checksum's capitals", async () => {
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    async request({ method }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return ["0x75685f9d88749b583732b40d56fe007cd404b72d"];
      if (method === "eth_chainId") return "0x2e9";
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const wallet = await import(`./evm-wallet.js?checksum=${Date.now()}`);

  assert.equal((await wallet.connectEvmWallet()).account, "0x75685f9D88749B583732B40d56fe007cD404b72D");
  assert.equal(wallet.getEvmState().account, "0x75685f9D88749B583732B40d56fe007cD404b72D");
  delete globalThis.ethereum;
});
