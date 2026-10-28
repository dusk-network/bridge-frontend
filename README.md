# Dusk Bridge

A dedicated bridge dApp for moving DUSK between Ethereum, BNB Smart Chain,
Dusk and DuskEVM.

The application coordinates bridge transactions but never owns wallet keys:

- Dusk Connect talks to a compatible Dusk wallet extension, for the account,
  signing and sending only.
- An injected EVM wallet handles Ethereum, BSC and DuskEVM approvals.
- Reown AppKit provides browser-wallet discovery and WalletConnect when
  `VITE_REOWN_PROJECT_ID` is configured.
- The source-chain wallet signs each transaction.
- Chain state is read from the deployment's own Dusk node and EVM RPCs, never
  through a wallet.

Keeping this application separate prevents the EVM bridge dependency tree from
becoming part of the Dusk wallet extension. The extension can link here and
remain a narrowly scoped wallet and signer.

## Routes

One deployment serves one network (`VITE_BRIDGE_PROFILE`), and every route
stays on that network's counterparts.

| Mainnet | Testnet |
| --- | --- |
| Ethereum → Dusk Mainnet | Sepolia → Dusk Testnet |
| BNB Smart Chain → Dusk Mainnet | |
| Dusk Mainnet → BNB Smart Chain | Dusk Testnet → Sepolia |
| Dusk → DuskEVM, once configured | Dusk Testnet → DuskEVM Testnet |
| DuskEVM → Dusk, once configured | DuskEVM Testnet → Dusk Testnet |

The old-token migration contracts and the operated Dusk → BSC account are
pinned to the values used by the Dusk Web Wallet and documentation. DuskEVM
routes appear only when its contract IDs and endpoints are configured; mainnet
has none until DuskEVM mainnet is live. The testnet old-token routes need the
Messina and Reggio testnet workers running to settle.

The app supports:

- the ERC20/BEP20 approve-and-migrate sequence;
- native Dusk-to-BSC transfers with a validated EVM memo;
- native Dusk-to-DuskEVM deposits;
- DuskEVM withdrawal initiation, proof and claim on Dusk; and
- following every transfer to its end, with links to both explorers.

Amounts move in whole Lux (9 decimals), the precision Dusk holds.

## Following a transfer

Recent activity is kept in this browser, but every entry is rebuilt from its
route and source transaction hash, so "Track a transfer" can add one back.

- **Migrations** complete when the Dusk payout appears: Messina pays out the
  migrated amount with the migration's transaction hash as the memo
  (`transactionsByMemo`). Anyone can send a transfer with that memo, so only
  the exact amount counts, and only from `VITE_MIGRATION_PAYOUT_ACCOUNT` when
  it's set.
- **Dusk → BSC** completes when the bridge pays the memo address: an ERC-20
  `Transfer` of the amount minus the fee, found with `eth_getLogs`.
- **Deposits** complete on their DuskEVM credit. Where the adapter's L1 RPC
  serves `duskevm_getTransactionHashByDuskHash`, the SDK follows the derived
  deposit transaction. Otherwise the bridge watches the L2 bridge's
  `ETHBridgeFinalized` event for the sender's Dusk account, the recipient and
  the amount. DuskEVM testnet takes the second path today.
- A payout or credit belongs to one transfer: two equal transfers to the same
  address each need their own, and take them in the order they were sent.
- **Withdrawals** show their three steps, sent, proved and claimed, with
  times, the claim time from the Portal and dispute game, and the next action.
  Readiness is read from the Portal and dispute-game state, never inferred
  from elapsed time.

Several contract reads on one screen go to the node as one Multicall for Dusk
query (`93de287b…6ce1d4`, mainnet and testnet). A read that fails inside a
batch fails alone; a batch the node refuses is retried one read at a time.

## Gas

Dusk contract calls ask the wallet for their own limit at the node's price:
5M for a deposit, 50M plus the withdrawal's own gas for a proof or claim. A
claim that would need more than `VITE_GAS_LIMIT_UPPER` isn't sent. Transfers
use the wallet's public-transfer default.

## Configuration

Copy `.env.example` to `.env.local`. Empty values mean the default. The
DuskEVM contract IDs come from the trusted deployment address book. They are
deliberately not guessed from EVM addresses.

The same keys can be provided before the app loads through
`window.__DUSK_BRIDGE_CONFIG__`, which allows one immutable build to be
deployed with environment-specific configuration.

For local testnet use:

```dotenv
VITE_BRIDGE_PROFILE=testnet
VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID=<from the address book>
VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID=<from the address book>
VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID=<from the address book>
```

`.env.example` lists the testnet values in use today.

## Development

```sh
npm install
npm run dev
```

Run the checks with:

```sh
npm run check
```

`npm run check` runs the tests, creates a production bundle, and audits
production dependencies at high severity.

## Trust boundaries

- Wallet extensions retain keys and display every signing request.
- The browser talks directly to configured Dusk and EVM RPC endpoints.
- Data drivers run only when they match their pinned SHA-256.
- Local storage contains transaction metadata only.
- Contract IDs, RPC endpoints and this site's origin are deployment trust
  inputs. Review them before publishing.
