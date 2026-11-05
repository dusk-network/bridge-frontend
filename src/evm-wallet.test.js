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
  let chain = "0x1";
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    async request(request) {
      requests.push(request);
      if (request.method === "eth_accounts")
        return ["0x0000000000000000000000000000000000000001"];
      if (request.method === "eth_chainId") return chain;
      if (request.method === "wallet_switchEthereumChain") {
        chain = request.params[0].chainId;
        return null;
      }
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

test("a chain the wallet adds is selected too, and the page shows the chain the wallet says it's on", async () => {
  const added = new Set();
  let chain = 1;
  // Whether a switch to an added chain selects it: a wallet can say yes and stay.
  let selects = true;
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    async request({ method, params }) {
      if (method === "eth_accounts") return ["0x0000000000000000000000000000000000000001"];
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      const id = Number.parseInt(params?.[0]?.chainId, 16);
      if (method === "wallet_switchEthereumChain") {
        if (!added.has(id)) throw Object.assign(new Error("Unrecognized chain ID."), { code: 4902 });
        if (selects) chain = id;
        return null;
      }
      // Added, not selected, as some wallets do.
      if (method === "wallet_addEthereumChain") return void added.add(id);
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const wallet = await import(`./evm-wallet.js?added=${Date.now()}`);
  const shown = [];
  wallet.subscribeEvmWallet((state) => shown.push(state.chainId));
  await wallet.initializeEvmWallet();
  const walletChain = async () => Number.parseInt(await globalThis.ethereum.request({ method: "eth_chainId" }), 16);

  await wallet.ensureEvmChain({ chainId: 745, chainName: "DuskEVM Testnet", rpcUrl: "https://rpc.testnet.evm.dusk.network" });
  // The page shows the chain the wallet says, and it's the one asked for.
  assert.equal(shown.at(-1), await walletChain());
  assert.equal(shown.at(-1), 745);

  // One that adds a chain but stays where it is: the page says where, and goes no further.
  selects = false;
  await assert.rejects(wallet.ensureEvmChain({ chainId: 11_155_111, chainName: "Sepolia", rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" }), /Sepolia/u);
  assert.equal(shown.at(-1), await walletChain());
  assert.equal(shown.at(-1), 745);
  delete globalThis.ethereum;
});

test("a wallet that says yes to a switch and stays where it is doesn't count as switched", async () => {
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    async request({ method }) {
      if (method === "eth_accounts") return ["0x0000000000000000000000000000000000000001"];
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") return null;
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const wallet = await import(`./evm-wallet.js?stays=${Date.now()}`);
  await wallet.initializeEvmWallet();

  await assert.rejects(wallet.ensureEvmChain({ chainId: 745_745, chainName: "BSC test chain", rpcUrl: "https://anvil.testnet.dusk.network" }), /still on another chain\. Switch it to BSC test chain/u);
  assert.equal(wallet.getEvmState().chainId, 1);
  delete globalThis.ethereum;
});
