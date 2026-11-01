import { formatEvmAddress } from "@dusk-network/networks/format";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
} from "viem";
import { config } from "./config.js";

const listeners = new Set();
const discoveredProviders = [];
// EIP-6963 announces each wallet with its name ("MetaMask", "Rabby Wallet").
const providerNames = new WeakMap();
let provider = null;
let account = null;
// Whether the page's side picks the account among those the wallet lists,
// and the wallet signs as the request's `from`: a WalletConnect session
// through Reown. A browser wallet, one reached through Reown's modal too,
// picks it itself, its first; so does one whose connector AppKit doesn't name.
let reownPicks = false;
let chainId = null;
let cleanup = () => {};
let discoveryStarted = false;
let appKit = null;
let appKitPromise = null;

/** The connected wallet's own name, when it gives one. */
export function walletNameOf(candidate) {
  if (!candidate) return "";
  const announced = providerNames.get(candidate);
  if (announced) return announced;
  if (candidate.isRabby) return "Rabby";
  if (candidate.isCoinbaseWallet) return "Coinbase Wallet";
  if (candidate.isMetaMask) return "MetaMask";
  return "";
}

/** The account with its EIP-55 checksum, as every address on the page is written; wallets often give it in lower case. */
const checksummed = (value) => {
  try {
    return formatEvmAddress(value);
  } catch {
    return value;
  }
};

const state = () =>
  Object.freeze({
    account: account ? checksummed(account) : null,
    chainId,
    installed: Boolean(config.reown.projectId || findProvider()),
    provider,
    walletName: walletNameOf(provider) || (appKit?.getWalletInfo?.()?.name ?? ""),
  });

const publish = () => {
  const snapshot = state();
  for (const listener of listeners) listener(snapshot);
};

const rememberProvider = (candidate) => {
  if (
    candidate?.request &&
    !discoveredProviders.some((entry) => entry === candidate)
  )
    discoveredProviders.push(candidate);
};

function discoverProviders() {
  const injected = globalThis.ethereum;
  for (const candidate of injected?.providers ?? (injected ? [injected] : []))
    rememberProvider(candidate);

  if (!discoveryStarted && globalThis.addEventListener) {
    discoveryStarted = true;
    globalThis.addEventListener("eip6963:announceProvider", (event) => {
      const announced = event.detail?.provider;
      if (announced && typeof event.detail?.info?.name === "string")
        providerNames.set(announced, event.detail.info.name.slice(0, 40));
      rememberProvider(announced);
      publish();
    });
  }
  globalThis.dispatchEvent?.(new Event("eip6963:requestProvider"));
  return discoveredProviders;
}

const findProvider = () => {
  const injected = globalThis.ethereum;
  const candidates = injected?.providers ?? (injected ? [injected] : []);
  return (
    candidates.find((candidate) => candidate?.request) ??
    discoveredProviders[0] ??
    null
  );
};

function parseChainId(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const raw = value.includes(":") ? value.split(":").at(-1) : value;
    return Number.parseInt(raw, raw.startsWith("0x") ? 16 : 10);
  }
  return null;
}

async function initializeReown() {
  if (appKit || !config.reown.projectId) return appKit;
  if (appKitPromise) return appKitPromise;
  appKitPromise = Promise.all([
    import("@reown/appkit"),
    import("@reown/appkit-adapter-wagmi"),
  ]).then(([{ createAppKit }, { WagmiAdapter }]) => {
    const network = ({
      chainId: id,
      chainName: name,
      currency: nativeCurrency,
      explorerUrl,
      rpcUrl,
    }) => ({
      blockExplorers: {
        default: { name: `${name} Explorer`, url: explorerUrl },
      },
      caipNetworkId: `eip155:${id}`,
      chainNamespace: "eip155",
      id,
      name,
      nativeCurrency,
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    });
    // Only this deployment's networks: Ethereum, BNB Smart Chain and DuskEVM, as configured.
    const evmIds = new Set([
      ...config.migrations,
      ...(config.service ? [config.service.network] : []),
    ]);
    const networks = [
      ...[...evmIds].map((id) => network(config.evmNetworks[id])),
      ...(config.duskEvm.enabled
        ? [
            network({
              chainId: config.duskEvm.chainId,
              chainName: config.duskEvm.name,
              currency: { decimals: 18, name: "Dusk", symbol: "DUSK" },
              explorerUrl: config.duskEvm.explorerUrl,
              rpcUrl: config.duskEvm.rpcUrl,
            }),
          ]
        : []),
    ];
    const adapter = new WagmiAdapter({
      networks,
      projectId: config.reown.projectId,
    });
    const origin = globalThis.location?.origin ?? "https://bridge.dusk.network";
    appKit = createAppKit({
      adapters: [adapter],
      enableBaseAccount: false,
      enableCoinbase: false,
      features: {
        analytics: false,
        email: false,
        onramp: false,
        socials: [],
        swaps: false,
      },
      metadata: {
        description: "Bridge DUSK between supported networks.",
        icons: [`${origin}/dusk-glyph.svg`],
        name: "Dusk Bridge",
        url: origin,
      },
      networks,
      projectId: config.reown.projectId,
      themeMode: "dark",
      themeVariables: {
        "--w3m-accent": "#71b1ff",
        "--w3m-border-radius-master": "2px",
      },
    });
    // AppKit 1.8 drops enableBaseAccount from createAppKit's options, so its wagmi
    // adapter would still add Base Account, whose SDK calls Coinbase when it
    // loads. The adapter reads the option once it has set up its own
    // connectors, after this line.
    appKit.updateOptions({ enableBaseAccount: false });
    // AppKit's type for the connector the account came through, read again
    // on each connect and provider change: `WALLET_CONNECT` for a session.
    const walletConnect = () => Boolean(provider) && appKit.getWalletProviderType?.() === "WALLET_CONNECT";
    const connected = appKit.getAccount("eip155");
    provider = connected?.isConnected ? appKit.getWalletProvider() : null;
    reownPicks = walletConnect();
    account = connected?.isConnected ? (connected.address ?? null) : null;
    chainId = connected?.isConnected ? parseChainId(appKit.getChainId()) : null;
    if (provider) watch(provider);
    appKit.subscribeProviders((providers) => {
      provider = providers.eip155 ?? null;
      reownPicks = walletConnect();
      if (provider) watch(provider);
      publish();
    });
    appKit.subscribeAccount(({ address, isConnected }) => {
      account = isConnected ? (address ?? null) : null;
      if (!isConnected) {
        provider = null;
        chainId = null;
      }
      reownPicks = walletConnect();
      publish();
    }, "eip155");
    appKit.subscribeNetwork(({ chainId: nextChainId }) => {
      chainId = parseChainId(nextChainId);
      publish();
    });
    return appKit;
  });
  return appKitPromise;
}

async function refresh() {
  if (!provider) return state();
  const [accounts, currentChain] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  account = accounts?.[0] ?? null;
  chainId = parseChainId(currentChain);
  publish();
  return state();
}

function watch(nextProvider) {
  cleanup();
  const accountsChanged = (accounts) => {
    account = accounts?.[0] ?? null;
    publish();
  };
  const chainChanged = (next) => {
    chainId = parseChainId(next);
    publish();
  };
  const disconnected = () => {
    account = null;
    publish();
  };
  nextProvider.on?.("accountsChanged", accountsChanged);
  nextProvider.on?.("chainChanged", chainChanged);
  nextProvider.on?.("disconnect", disconnected);
  cleanup = () => {
    nextProvider.removeListener?.("accountsChanged", accountsChanged);
    nextProvider.removeListener?.("chainChanged", chainChanged);
    nextProvider.removeListener?.("disconnect", disconnected);
  };
}

export async function initializeEvmWallet() {
  discoverProviders();
  const discovered = findProvider();
  if (!discovered) {
    publish();
    return state();
  }
  provider = discovered;
  reownPicks = false;
  watch(provider);
  return refresh();
}

export async function connectEvmWallet() {
  const modal = await initializeReown();
  if (modal) {
    await modal.open({
      view: modal.getAccount("eip155")?.isConnected ? "Account" : "Connect",
    });
    return state();
  }
  discoverProviders();
  provider = provider ?? findProvider();
  if (!provider) throw new Error("Install an EVM wallet extension first.");
  reownPicks = false;
  watch(provider);
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  account = accounts?.[0] ?? null;
  if (!account) throw new Error("The EVM wallet did not expose an account.");
  chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
  publish();
  return state();
}

export async function ensureEvmChain(network) {
  if (!provider) await connectEvmWallet();
  const hexChainId = `0x${network.chainId.toString(16)}`;
  const select = () =>
    provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
  let added = false;
  try {
    await select();
  } catch (error) {
    if (error?.code !== 4902 || !network.rpcUrl) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          blockExplorerUrls: network.explorerUrl
            ? [network.explorerUrl]
            : undefined,
          chainId: hexChainId,
          chainName: network.chainName ?? network.name,
          nativeCurrency: network.currency ?? {
            decimals: 18,
            name: "DUSK",
            symbol: "DUSK",
          },
          rpcUrls: [network.rpcUrl],
        },
      ],
    });
    // Adding a chain needn't select it.
    await select();
    added = true;
  }
  // Once added, the chain the wallet says it's on, not the one asked for.
  chainId = added ? parseChainId(await provider.request({ method: "eth_chainId" })) : network.chainId;
  publish();
  if (chainId !== network.chainId)
    throw new Error(`Your wallet is still on another chain. Switch it to ${network.chainName ?? network.name} and try again.`);
}

/** Why an EVM request isn't sent: since its review, the wallet switched account. */
export const EVM_ACCOUNT_CHANGED = "Your EVM wallet switched to another account, so nothing was sent. Review it again.";

/**
 * `reviewed` as the wallet's `accounts` hold it now, or undefined: the
 * wallet's selected account, its first; or, in a WalletConnect session
 * through Reown, where the page's side picks the account, any the wallet
 * lists.
 */
export function heldAccount(accounts, reviewed, { reownPicks: picks = false } = {}) {
  const same = (value) => Boolean(value && reviewed) && String(value).toLowerCase() === String(reviewed).toLowerCase();
  return picks ? accounts.find(same) : same(accounts[0]) ? accounts[0] : undefined;
}

/**
 * The account a request goes out from: `reviewed`, the one it was reviewed
 * for, asked of the wallet again right before sending. The wallet can switch
 * account while its chain-switch dialog is open, and say so only later: then
 * nothing is sent.
 */
export async function reviewedEvmAccount(reviewed) {
  const accounts = (await provider?.request({ method: "eth_accounts" })) ?? [];
  const current = heldAccount(accounts, reviewed, { reownPicks });
  // As the page last heard it, and as the wallet says now.
  if (String(account ?? "").toLowerCase() !== String(reviewed ?? "").toLowerCase() || !reviewed || !current)
    throw Object.assign(new Error(EVM_ACCOUNT_CHANGED), { code: "EVM_ACCOUNT_CHANGED" });
  return current;
}

export function getEvmClients(network) {
  if (!provider || !account) throw new Error("Connect an EVM wallet first.");
  const chain = defineChain({
    id: network.chainId,
    name: network.chainName ?? network.name,
    nativeCurrency: network.currency ?? {
      decimals: 18,
      name: "DUSK",
      symbol: "DUSK",
    },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: network.explorerUrl
      ? { default: { name: "Explorer", url: network.explorerUrl } }
      : undefined,
  });
  return {
    account,
    chain,
    publicClient: createPublicClient({
      chain,
      transport: http(network.rpcUrl),
    }),
    walletClient: createWalletClient({
      account,
      chain,
      transport: custom(provider),
    }),
  };
}

export const getEvmState = state;
export const subscribeEvmWallet = (listener) => {
  listeners.add(listener);
  listener(state());
  return () => listeners.delete(listener);
};
