// Hyperlane's routes between Dusk and an EVM chain: DUSK, locked on Dusk and
// minted there, and tokens issued on Dusk (EURd, USDd), locked in a
// collateral route. Testnet's run between Dusk testnet and Sepolia. Their
// address book is the deployment's record (hyperlane-testnet.json), copied
// from it, never derived. What the routes' calls carry is written here byte
// for byte, as the deployed contracts read it (dusk-tx in
// dusk-network/hyperlane-dusk sends the same).

import { decodeBase58, isAccount } from "@dusk-network/networks/account";
import { getAddress, isAddress, keccak256, parseAbi, zeroAddress } from "viem";
import { sepolia } from "viem/chains";

import testnetBook from "./hyperlane-testnet.json" with { type: "json" };

/** Each network's deployment record, where there is one. Mainnet has none yet. */
const BOOKS = Object.freeze({ testnet: testnetBook });

/** The EVM chains a record can name, as viem defines them. */
const CHAINS = Object.freeze({ sepolia });

/** DUSK, as the native route moves it: 9 decimals, one unit a Lux, on both sides. */
export const DUSK_TOKEN = Object.freeze({ decimals: 9, name: "Dusk", symbol: "DUSK" });

/**
 * The data driver that encodes the routes' and the Mailboxes' queries and
 * decodes their events, built from dusk-network/hyperlane-dusk at ef912e9
 * (`make data-driver`, `--features js`). It doesn't encode `transfer_remote`.
 */
export const HYPERLANE_DRIVER = Object.freeze({
  commit: "ef912e9ab5bf024227d82eee1b1a63b80cf99557",
  file: "hyperlane_dusk_data_driver.wasm",
  sha256: "bd4f3025efaf38135b1d72297d73f23e83c3ca7ebfdf29ea454d9f83c4c37eef",
});

/**
 * How long a transfer usually takes, from its transaction's block to its
 * delivery: the medians of 107 testnet transfers on 18 Nov 2026, 21 seconds
 * to Sepolia (at most 36) and 59 back (at most 71).
 */
export const HYPERLANE_SECONDS = Object.freeze({ in: 60, out: 20 });

/**
 * Gas for the routes' calls on Dusk, at the node's price. A failed call is
 * charged its whole limit, so each has its own, with room over what it
 * spends: a transfer 2.13M to 2.22M (107 testnet transfers, 18 Nov 2026), an
 * approval 1.84M, a claim 1.87M to 1.91M (dusk-tx's limit, 3M, is 1.5 times
 * the costliest route's), and a claim for another account about 59M, its key
 * decoded on chain (dusk-tx's 80M).
 */
export const HYPERLANE_GAS = Object.freeze({
  approve: Object.freeze({ limit: 3_000_000n, typical: 1_850_000n }),
  claim: Object.freeze({ limit: 3_000_000n, typical: 1_900_000n }),
  claimFor: Object.freeze({ limit: 80_000_000n, typical: 59_000_000n }),
  transfer: Object.freeze({ limit: 5_000_000n, typical: 2_200_000n }),
});

/** What a `transferRemote` on Sepolia spends, until it's estimated: 236,000 to 265,000 on testnet. */
export const EVM_TRANSFER_GAS_FALLBACK = 300_000n;

/** The largest amount a route carries: a u64 of the token's smallest unit. */
export const U64_MAX = 2n ** 64n - 1n;

/** Whether a route can carry `units`: above 0, and within a u64. */
export const carries = (units) => typeof units === "bigint" && units > 0n && units <= U64_MAX;

const isContractId = (id) => /^[0-9a-f]{64}$/u.test(String(id ?? ""));

/**
 * The route ID a token's transfer goes by: `dusk-to-sepolia` and
 * `sepolia-to-dusk` for DUSK, with the token after it for the others
 * (`dusk-to-sepolia-eurd`).
 */
export const hyperlaneRouteId = (chain, symbol, direction) =>
  `${direction === "out" ? `dusk-to-${chain}` : `${chain}-to-dusk`}${symbol === DUSK_TOKEN.symbol ? "" : `-${symbol.toLowerCase()}`}`;

/**
 * This network's Hyperlane routes, from its deployment's record: the Dusk
 * and EVM domains, each side's Mailbox, and per token its route and token on
 * Dusk and its token on the EVM chain. `wanted` keeps the tokens a
 * deployment runs, by symbol in lower case; all of them unless set. The EVM
 * chain is the one of this network's `evmNetworks` with the record's chain
 * ID, where the page reads it and links to its explorer. Without a record,
 * that chain, or a token, none run.
 */
export function hyperlaneConfig(profile, { evmNetworks = {}, wanted = null } = {}) {
  const book = BOOKS[profile];
  const chain = book && CHAINS[book.evm_chain]?.id === book.evm_domain ? CHAINS[book.evm_chain] : null;
  const network = chain ? Object.values(evmNetworks).find((each) => each.configured && each.chainId === chain.id) : null;
  if (!network) return Object.freeze({ enabled: false, tokens: Object.freeze([]) });
  const native = {
    decimals: DUSK_TOKEN.decimals,
    dusk: { route: book.dusk.warp_native, token: null },
    evm: { token: book.evm.token },
    name: DUSK_TOKEN.name,
    native: true,
    symbol: DUSK_TOKEN.symbol,
  };
  const issued = Object.values(book.token_routes ?? {}).map((each) => ({
    decimals: each.decimals,
    dusk: { route: each.dusk.route, token: each.dusk.token },
    evm: { token: each.evm.token },
    name: each.name,
    native: false,
    symbol: each.symbol,
  }));
  // Every EVM contract in the book, whichever tokens run: none of them is a recipient anyone could spend from.
  const evmContracts = Object.freeze([native, ...issued].map((token) => token.evm.token).filter((address) => isAddress(address)).map((address) => getAddress(address)).concat(getAddress(book.evm.mailbox)));
  const tokens = [native, ...issued]
    .filter((token) => !wanted || wanted.includes(token.symbol.toLowerCase()))
    .filter(
      (token) =>
        isContractId(token.dusk.route) && (token.native || isContractId(token.dusk.token)) && isAddress(token.evm.token) && Number.isInteger(token.decimals),
    )
    .map((token) =>
      Object.freeze({
        ...token,
        dusk: Object.freeze(token.dusk),
        evm: Object.freeze({ token: getAddress(token.evm.token) }),
        routes: Object.freeze({
          in: hyperlaneRouteId(book.evm_chain, token.symbol, "in"),
          out: hyperlaneRouteId(book.evm_chain, token.symbol, "out"),
        }),
      }),
    );
  return Object.freeze({
    chain,
    dusk: Object.freeze({ domain: book.dusk_domain, igp: book.dusk.igp, mailbox: book.dusk.mailbox }),
    driver: Object.freeze({ sha256: HYPERLANE_DRIVER.sha256, url: `/drivers/${HYPERLANE_DRIVER.file}` }),
    enabled: tokens.length > 0,
    evm: Object.freeze({ domain: book.evm_domain, mailbox: getAddress(book.evm.mailbox) }),
    evmContracts,
    // Where the EVM chain is in this network's file: "ethereum" on testnet, which is Sepolia there.
    network: network.id,
    seconds: HYPERLANE_SECONDS,
    source: Object.freeze({ ...book.source }),
    tokens: Object.freeze(tokens),
  });
}

/** The token a Hyperlane route moves, by its route ID, with which way it goes. */
export function hyperlaneToken(hyperlane, routeId) {
  for (const token of hyperlane?.tokens ?? []) {
    if (token.routes.out === routeId) return { direction: "out", token };
    if (token.routes.in === routeId) return { direction: "in", token };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const writeLe = (out, at, value, bytes) => {
  for (let index = 0; index < bytes; index += 1) out[at + index] = Number((BigInt(value) >> BigInt(8 * index)) & 0xffn);
};

const readLe = (bytes, at, length) => {
  let value = 0n;
  for (let index = length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[at + index]);
  return value;
};

const hexBytes = (hex) => Uint8Array.from(String(hex).replace(/^0x/iu, "").match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));

/** Why a recipient on the EVM chain is refused: only a 20-byte address can be paid there. */
export const NOT_AN_EVM_RECIPIENT = "Only a 20-byte EVM address can receive on the EVM side.";

/**
 * A 20-byte EVM address as Hyperlane carries a recipient, 32 bytes: 12 zero
 * bytes, then the address. Anything else, and the zero address, throws: no
 * EVM route can deliver to it, and the tokens would stay locked.
 */
export function evmRecipient(address) {
  const text = String(address ?? "").trim();
  if (!/^0x[0-9a-f]{40}$/iu.test(text) || text.toLowerCase() === zeroAddress) throw new Error(NOT_AN_EVM_RECIPIENT);
  return Uint8Array.from([...new Uint8Array(12), ...hexBytes(text)]);
}

/**
 * `transfer_remote(destination, recipient, amount)`'s 48 bytes, as the routes
 * archive them: the recipient first (bytes 0 to 31), the destination domain
 * as a little-endian u32 (32 to 35), four bytes of padding, then the amount
 * in the token's smallest unit as a little-endian u64 (40 to 47). The
 * recipient is a 20-byte EVM address (`evmRecipient`).
 */
export function transferRemoteArgs({ amount, destination, recipient }) {
  if (!carries(amount)) throw new Error("The amount must be above 0 and fit a u64.");
  if (!Number.isInteger(destination) || destination < 0 || destination > 0xffffffff) throw new Error("The destination must be a u32 domain.");
  const out = new Uint8Array(48);
  out.set(evmRecipient(recipient), 0);
  writeLe(out, 32, destination, 4);
  writeLe(out, 40, amount, 8);
  return out;
}

/**
 * What a `transfer_remote` call's bytes carry: the recipient's 32 bytes and,
 * where they're an EVM address's, the address with its checksum; the
 * destination domain; the amount. Null for bytes of another size.
 */
export function readTransferRemoteArgs(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : hexBytes(bytes);
  if (data.length !== 48) return null;
  const recipient32 = data.slice(0, 32);
  const padded = recipient32.slice(0, 12).every((byte) => byte === 0);
  const tail = `0x${Array.from(recipient32.slice(12), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return {
    amount: readLe(data, 40, 8),
    destination: Number(readLe(data, 32, 4)),
    recipient: padded && tail !== zeroAddress ? getAddress(tail) : null,
    recipient32: `0x${Array.from(recipient32, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  };
}

/**
 * A DRC20 `approve(spender, value)` for a contract spender, 208 bytes, as the
 * canonical DRC20 (dusk-network/contracts at bc1b00ee) archives it: the
 * value as a little-endian u64 (bytes 0 to 7), then the spender as its
 * principal, the tag 2 for a contract (byte 8) and its 32-byte ID (9 to 40),
 * and zeros to the end, the room its largest kind, a 193-byte key, takes.
 */
export function approveArgs({ amount, spender }) {
  if (typeof amount !== "bigint" || amount < 0n || amount > U64_MAX) throw new Error("The amount must fit a u64.");
  if (!isContractId(spender)) throw new Error("The spender must be a contract ID.");
  const out = new Uint8Array(208);
  writeLe(out, 0, amount, 8);
  out[8] = 2;
  out.set(hexBytes(spender), 9);
  return out;
}

/** A query's u64 answer, little-endian, in its 8 bytes. */
export function readU64(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 8) throw new Error("Expected a u64's 8 bytes.");
  return readLe(bytes, 0, 8);
}

/** A query's bool answer: one byte, 0 or 1. */
export function readBool(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 1 || bytes[0] > 1) throw new Error("Expected a bool's byte.");
  return bytes[0] === 1;
}

/**
 * The hash a route pays a Dusk account by: keccak256 of the 96 bytes of its
 * public key, which its base58 address decodes to. Null for anything that
 * isn't a Dusk account.
 */
export function duskRecipientHash(account) {
  if (!isAccount(account)) return null;
  return keccak256(decodeBase58(String(account).trim()));
}

// ---------------------------------------------------------------------------
// The EVM side
// ---------------------------------------------------------------------------

/** The synthetic tokens' calls and the Mailbox's, on the EVM chain. */
export const HYPERLANE_EVM_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function delivered(bytes32 messageId) view returns (bool)",
  "function quoteGasPayment(uint32 destinationDomain) view returns (uint256)",
  // HypERC20 12.3.0, as deployed on Sepolia: what a transfer charges, in each token (the zero address for ETH).
  "function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns ((address token, uint256 amount)[] quotes)",
  // The router the token sends to on a domain: Dusk's route, as 32 bytes.
  "function routers(uint32 domain) view returns (bytes32)",
  "function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32 messageId)",
  "event DispatchId(bytes32 indexed messageId)",
  "event ProcessId(bytes32 indexed messageId)",
  "event ReceivedTransferRemote(uint32 indexed origin, bytes32 indexed recipient, uint256 amount)",
  "event SentTransferRemote(uint32 indexed destination, bytes32 indexed recipient, uint256 amount)",
]);
