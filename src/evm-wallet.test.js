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

test("Add DUSK asks the wallet to show the chain's DUSK, on that chain, and isn't offered again once it did", async () => {
  // This browser's storage, kept past a reload.
  const kept = new Map();
  globalThis.localStorage = { getItem: (key) => kept.get(key) ?? null, removeItem: (key) => kept.delete(key), setItem: (key, value) => kept.set(key, String(value)) };
  const requests = [];
  let chain = "0x1";
  let accounts = ["0x0000000000000000000000000000000000000001"];
  let answer = () => true;
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    async request(request) {
      requests.push(request);
      if (request.method === "eth_accounts" || request.method === "eth_requestAccounts") return accounts;
      if (request.method === "eth_chainId") return chain;
      if (request.method === "wallet_switchEthereumChain") return void (chain = request.params[0].chainId);
      if (request.method === "wallet_watchAsset") return answer();
      throw new Error(`Unexpected method: ${request.method}`);
    },
  };
  const bsc = { chainId: 56, chainName: "BNB Smart Chain", rpcUrl: "https://bsc-rpc.publicnode.com", tokenContract: "0xB2BD0749DBE21f623d9BABa856D3B0f0e1BFEc9C" };
  const wallet = await import(`./evm-wallet.js?dusk=${Date.now()}`);
  await wallet.connectEvmWallet();
  assert.equal(wallet.canAddDusk(bsc), true);

  // Asked on the token's own chain, which the wallet is asked for first: DUSK, 18 decimals, the network's token.
  const watch = { method: "wallet_watchAsset", params: { options: { address: bsc.tokenContract, decimals: 18, symbol: "DUSK" }, type: "ERC20" } };
  const asked = () => requests.splice(0).filter(({ method }) => method.startsWith("wallet_"));
  // Refused in the wallet: nothing, and it's still offered.
  answer = () => {
    throw Object.assign(new Error("User rejected the request."), { code: 4001 });
  };
  requests.length = 0;
  assert.equal(await wallet.addDusk(bsc), false);
  assert.deepEqual(asked(), [{ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] }, watch]);
  assert.equal(wallet.canAddDusk(bsc), true);

  // Added, on the chain the wallet is on now.
  answer = () => true;
  assert.equal(await wallet.addDusk(bsc), true);
  assert.deepEqual(asked(), [watch]);
  // Not offered again for that address and chain, also after a reload; another address, or another chain, still is.
  assert.equal(wallet.canAddDusk(bsc), false);
  const reloaded = await import(`./evm-wallet.js?dusk-reloaded=${Date.now()}`);
  await reloaded.initializeEvmWallet();
  assert.equal(reloaded.canAddDusk(bsc), false);
  assert.equal(reloaded.canAddDusk({ ...bsc, chainId: 745_745, tokenContract: "0xBCEe5c06Eda885A6471a0E87f513e7492d411B61" }), true);
  accounts = ["0x0000000000000000000000000000000000000002"];
  await reloaded.initializeEvmWallet();
  assert.equal(reloaded.canAddDusk(bsc), true);

  // A wallet that answers it has no such request isn't asked again; one with no token to add, nor.
  answer = () => {
    throw Object.assign(new Error("The method wallet_watchAsset does not exist."), { code: -32601 });
  };
  assert.equal(await reloaded.addDusk(bsc), false);
  assert.equal(reloaded.canAddDusk(bsc), false);
  assert.equal(wallet.canAddDusk({ ...bsc, tokenContract: "" }), false);
  delete globalThis.ethereum;
  delete globalThis.localStorage;
});
