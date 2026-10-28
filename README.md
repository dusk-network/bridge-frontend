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
stays on that network's counterparts. There are three routes:

- **BNB Smart Chain ↔ Dusk**, both ways: BEP20 DUSK migrates to Dusk, and
  DUSK sent to the bridge account is paid out as BEP20 DUSK;
- **Ethereum → Dusk**, one way, since the ERC20 contract can't mint: ERC20
  DUSK migrates to Dusk;
- **Dusk ↔ DuskEVM**, both ways, with DuskEVM's own deposit and withdrawal.

| Mainnet | Testnet |
| --- | --- |
| BNB Smart Chain → Dusk | |
| Dusk → BNB Smart Chain | |
| Ethereum → Dusk | Ethereum (Sepolia) → Dusk, not running |
| | Dusk → Ethereum (Sepolia), not running |
| Dusk → DuskEVM, once configured | Dusk → DuskEVM |
| DuskEVM → Dusk, once configured | DuskEVM → Dusk |

Each chain has one name per network: Dusk and DuskEVM keep theirs next to the
network badge, and Ethereum and BNB Smart Chain name their testnet in
brackets. DUSK on them is named by its token standard: ERC20 DUSK and BEP20
DUSK.

The migration contracts and the operated Dusk → BSC account are pinned to the
values used by the Dusk Web Wallet and documentation, and so are the accounts
that pay out each chain's migrations on mainnet: `2427XSRs…` for Ethereum, and
for BSC the Dusk → BSC bridge account. DuskEVM routes appear only when its
contract IDs and endpoints are configured; mainnet has none until DuskEVM
mainnet is live.

Nothing has been paid out on the testnet Sepolia routes since 11 Feb 2026, so
they're shown as not running: listed, disabled, and never opened unless a link
names one. `VITE_PAUSED_ROUTES` lists the routes shown that way (testnet:
`ethereum-to-dusk,dusk-to-ethereum`); `none` runs them again. Transfers already
sent on a paused route are still followed.

The app supports:

- the ERC20/BEP20 approve-and-migrate sequence;
- native Dusk-to-BSC transfers with a validated EVM memo;
- native Dusk-to-DuskEVM deposits;
- DuskEVM withdrawal initiation, proof and claim on Dusk; and
- following every transfer to its end, with links to both explorers.

Amounts move in whole Lux (9 decimals), the precision Dusk holds.

## Pages

- **Start**: the bridge card, with each route's time and cost, and on a phone
  without Dusk Wallet whether it works there. Under it, for DUSK on Ethereum or
  BNB Smart Chain, a link per chain that opens its route to Dusk.
- **A task**: the amount, where it goes, and the quote: what you send, the
  network fee as a maximum and its usual cost, the bridge fee, what you
  receive and when. One line says what becomes public.
- **Review**: the checked facts (balances, gas, where the payout goes), then
  each wallet step with the lines its window will show, in its order and
  words, raw values decoded next to them and every recipient in full. Cancel
  and confirm are equal. A Dusk call is built before the review, so the call
  data's sha256 shown is the one Dusk Wallet prints (older versions show a
  bridge call only as its bytes), and the reviewed request is what is sent.
- **Receipt**, at `#/transfer/<hash>`: the steps with times, explorer links
  and hashes, both transactions in full, the fees paid and the receipt link.
  It shows no balances: the link is safe to share. A withdrawal waiting for
  its claim counts down, says when a clock change falls inside the wait, and
  offers an .ics file made in the browser ("Add to calendar").
- **My transfers**: the connected accounts' transfers, read from the networks
  (below), plus any sent or looked up on this device. "Look up a transfer"
  finds a transfer's route from its hash alone.
- **Contracts**: every address and contract ID each route uses, in full,
  with copy buttons and explorer links, and an operator only where the
  deployment names one.

## My transfers

The list is the same on any device: it comes from the networks, a bounded
number of requests per visit, and what was read is kept per network and
account so the next visit asks only for what is new.

- **The Dusk account**: its archive history (`moonlightHistory`, sender and
  receiver in one request), synced from the newest block down in windows
  that widen while they hold little, with the extension's resumable coverage.
  It gives the account's deposits into DuskEVM, its transfers to the bridge
  account, and migration payouts (incoming transfers whose memo is an EVM
  transaction hash that called a configured migration contract).
- **The EVM address**: DuskEVM's L2 bridge event `ETHBridgeInitiated` filtered
  by sender, 100,000 blocks (the RPC's limit) per request from the newest
  down. Each withdrawal's Dusk recipient is decoded from its `extraData`.

## Following a transfer

Every entry is rebuilt from its route and source transaction hash, so a
receipt link or a looked-up hash opens the same transfer on any device.

- **Migrations** complete when the Dusk payout appears: Messina pays out the
  migrated amount with the migration's transaction hash as the memo
  (`transactionsByMemo`). Anyone can send a transfer with that memo, so only
  the exact amount counts, and only from the chain's payout account where one
  is known (the mainnet defaults, `VITE_ETHEREUM_PAYOUT_ACCOUNT`,
  `VITE_BSC_PAYOUT_ACCOUNT`, or `VITE_MIGRATION_PAYOUT_ACCOUNT` for both).
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

## Times

Every page takes a route's time from one place (`src/route-times.js`), and
only this network's:

- **DuskEVM withdrawals**: the Portal's proof maturity and dispute game
  finality delays, and how often outputs come, from the gaps between the
  dispute game factory's latest games: two Multicall for Dusk queries.
- **DuskEVM deposits**: how far DuskEVM trails Dusk, its latest block against
  Dusk's own time for the Dusk block it last took in (the L1Block predeploy).
- The chains are asked at most every 10 minutes, and their answers are kept
  a day per network.
- **Otherwise**: what this browser's own transfers on the route took (the
  middle of the last five completed in 30 days, with two at least), or the
  profile's value in `src/config.js`, which says where each number comes
  from. `VITE_ETHEREUM_MIGRATION_SECONDS`, `VITE_BSC_MIGRATION_SECONDS`,
  `VITE_SERVICE_BRIDGE_DELAY_SECONDS` and `VITE_DUSKEVM_DEPOSIT_SECONDS` set a
  deployment's own; `none` clears one.

A route whose time isn't known on this network shows none.

## Gas

Dusk contract calls ask the wallet for their own limit at the node's price:
5M for a deposit, 50M plus the withdrawal's own gas for a proof or claim. A
claim that would need more than `VITE_GAS_LIMIT_UPPER` isn't sent. Transfers
to the bridge account carry the wallet's public-transfer limit, 2.5M, at the
node's price. The quote shows each limit as "up to" and the measured usual
cost next to it.

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

The footer and About this page say the bridge is operated by Dusk, and link
Dusk's Terms of use and Privacy policy, as the explorer does. A deployment can
name its own (`VITE_TERMS_URL`, `VITE_PRIVACY_URL`), or another operator for a
route (`VITE_MIGRATION_OPERATOR`, `VITE_SERVICE_OPERATOR`,
`VITE_DUSKEVM_OPERATOR`), which the Contracts sheet and the footer then name.

Some page content appears only when configured, since none of it is guessed:
a support contact (`VITE_SUPPORT_URL`, `VITE_SUPPORT_LABEL`), the other
network's bridge site (`VITE_MAINNET_BRIDGE_URL`, `VITE_TESTNET_BRIDGE_URL`),
a Status link, and a guide per route (`VITE_DOCS_MIGRATION_URL`,
`VITE_DOCS_SERVICE_URL`, `VITE_DOCS_DUSKEVM_URL`; the docs' bridge guides
describe the web wallet's bridge).

The page uses the system's fonts: the Söhne files the mockups used aren't
licensed for this repository.

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
- Local storage contains transaction metadata, what was read for My
  transfers and the chains' times, per network and account; no keys and no
  balances.
- Contract IDs, RPC endpoints and this site's origin are deployment trust
  inputs. Review them before publishing.
