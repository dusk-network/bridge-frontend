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
| Dusk → DuskEVM, once DuskEVM is on mainnet | Dusk → DuskEVM |
| DuskEVM → Dusk, once DuskEVM is on mainnet | DuskEVM → Dusk |

Each chain has one name per network: Dusk and DuskEVM keep theirs next to the
network badge, and Ethereum and BNB Smart Chain name their testnet in
brackets. DUSK on them is named by its token standard: ERC20 DUSK and BEP20
DUSK.

The routes, and everything they use, come from the network's file in
[`@dusk-network/networks`](https://www.npmjs.com/package/@dusk-network/networks),
pinned to an exact version, as the web wallet, the wallet extension and the
explorer take them: the chains and their endpoints, the migration contracts,
the bridge account and its fee, the accounts that pay out each chain's
migrations (on mainnet `2427XSRs…` for Ethereum, and for BSC the Dusk → BSC
bridge account), DuskEVM's contracts, predeploys and drivers, and whether a
route runs. DuskEVM's routes appear where the file has them: testnet, and
mainnet once DuskEVM is live there.

A route the file says isn't running is shown as not running: listed,
disabled, and never opened unless a link names one. On testnet that's the
Sepolia routes, on which nothing has been paid out since 11 Feb 2026.
`VITE_PAUSED_ROUTES` sets the routes shown that way instead; `none` runs them
all. Transfers already sent on a paused route are still followed.

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
- **Review**: what moves and what becomes public, the checked facts
  (balances, gas, where the payout goes), then each wallet step with the
  lines its window will show, in its order and words, raw values decoded
  next to them and every recipient in full. Cancel and confirm are equal; a
  request you reject in the wallet is said in grey, not as a failure. A
  Dusk call is built before the review, so the call data's sha256 shown is
  the one Dusk Wallet prints (older versions show a bridge call only as its
  bytes), and the reviewed request is what is sent.
- **Receipt**, at `#/transfer/<hash>`: the steps with times, explorer links
  and hashes, both transactions in full, the fees paid and the receipt link.
  It shows no balances: the link is safe to share. A withdrawal waiting for
  its claim counts down, says when a clock change falls inside the wait, and
  offers an .ics file made in the browser ("Add to calendar").
- **My transfers**: the connected accounts' transfers, read from the networks
  (below), plus any sent or looked up on this device, each with whom it pays
  and its transaction's short hash. A withdrawal under way that pays another
  Dusk account is listed apart, under Sent to someone else, with a quiet
  Prove, until your account proves it. "Look up a transfer" finds a
  transfer's route from its hash alone.
- **Contracts**: every address and contract ID each route uses, in full,
  with copy buttons and explorer links.

A link can open the card on a route: `#/move/<route>`, by its ID
(`bsc-to-dusk`), by one of the three routes (`bsc`, `ethereum`, `duskevm`), or
as earlier links named it (`migrate`, `to-duskevm`, `from-duskevm`). For a
route into Dusk, `?to=<account>` hands over the Dusk account it pays, as the
web wallet's Migrate can: the card shows "Paying <account>" until it's
changed.

## My transfers

The list is the same on any device: it comes from the networks, a bounded
number of requests per visit, and what was read is kept per network and
account so the next visit asks only for what is new.

- **The Dusk account**: its archive history, synced by
  `@dusk-network/app-core/history` from the newest block down in windows
  that widen while they hold little, each step kept as it lands so the next
  visit carries on. A node on another chain (a reset testnet) starts it over.
  It gives the account's deposits into DuskEVM, its transfers to the bridge
  account, and migration payouts (transfers from a migration's payout
  account whose memo is the migration's transaction hash, of what they
  paid; an account set to pay out both chains doesn't say which a payout is
  for, so its payouts aren't listed).
- **The EVM address**: DuskEVM's L2 bridge event `ETHBridgeInitiated` filtered
  by sender, 100,000 blocks (the RPC's limit) per request from the newest
  down. Each withdrawal's Dusk recipient is decoded from its `extraData`.

## Following a transfer

Every entry is rebuilt from its route and source transaction hash, so a
receipt link or a looked-up hash opens the same transfer on any device.
Which payout or credit is a transfer's comes from
`@dusk-network/app-core/bridge`.

- **Migrations** complete when the Dusk payout appears: Messina pays out the
  migrated amount with the migration's transaction hash as the memo
  (`transactionsByMemo`). Anyone can send a transfer with that memo, so only
  the exact amount counts, and only from the chain's payout account (the
  mainnet defaults, `VITE_ETHEREUM_PAYOUT_ACCOUNT`, `VITE_BSC_PAYOUT_ACCOUNT`,
  or `VITE_MIGRATION_PAYOUT_ACCOUNT` for both). Without one, none counts.
- **Dusk → BSC** completes when the bridge pays the memo address: an ERC-20
  `Transfer` of the amount minus the fee, found with `eth_getLogs`, from the
  address the network's file says pays the route out. Without one, none
  counts.
- **Deposits** complete on their DuskEVM credit. Where the adapter's L1 RPC
  serves `duskevm_getTransactionHashByDuskHash`, the SDK follows the derived
  deposit transaction. Otherwise the bridge watches the L2 bridge's
  `ETHBridgeFinalized` event for the sender's Dusk account, the recipient and
  the amount. DuskEVM testnet takes the second path today.
- A payout or credit belongs to one transfer: two equal transfers to the same
  address each need their own, and take them in the order they were sent,
  those sent from another device too, and those this browser follows that
  the archive doesn't list yet. Where that order can't be told, the
  transfer stays in progress.
- **Withdrawals** show their three steps, sent, proved and claimed, with
  times, the claim date, and the next action. Readiness is read from the
  Portal and dispute-game state, never inferred from elapsed time.

The claim date is when the Portal takes the claim, worked out as every Dusk
app does (`@dusk-network/networks/duskevm`): the later of the proof plus the
Portal's proof maturity delay, and the proof's dispute game's resolution plus
its finality delay. Both are read on Dusk, from the Portal and the game's hub,
in one Multicall for Dusk query (once a check knows the proof's game). The
times are the contracts' own: testnet's deployed contracts count Dusk block
height × 10, which the latest block converts to a date; the others count block
time, a second later for their strict comparisons.

- Before the proof: "Claim 7 days after you prove. You can prove about 30
  minutes after sending.", with the chain's figures. Before sending, the
  review dates it too: "Claim from about 5 Nov, 12:28 CET".
- After it: "Claim from 2 Nov, 04:20 CET" once the game has resolved, and
  "Claim from about …", the earliest it can be, before that. A game left
  unresolved more than an hour past its clock is late: "Waiting for DuskEVM
  to settle this proof. Claim from … at the soonest.", with no countdown or
  calendar entry, since that date moves on with each check.
- A claim is ready once the Portal's check passes and its date has come.
- A proof goes against a game that covers the withdrawal, has already
  resolved, and that the Portal would take, where there is one: the anchor
  state registry calls it proper and respected, and it was created after the
  respected game type last changed (`respectedGameTypeUpdatedAt`), as the web
  wallet requires. Its date is then exact when the proof is made ("If you
  prove now, you can claim from …"). Otherwise the proof goes against the
  newest covering game.

Several contract reads on one screen go to the node as one Multicall for Dusk
query (`93de287b…6ce1d4`, mainnet and testnet), through
`@hdauven/dusk-multicall`; a read alone goes as it is. A read that fails
inside a batch fails alone, and one that runs out of gas there is read again
alone; a batch the node refuses is retried one read at a time.

## Times

Every page takes a route's time from one place (`src/route-times.js`), and
only this network's:

- **DuskEVM withdrawals**: the Portal's proof maturity and dispute game
  finality delays, and how often outputs come, from the gaps between the
  dispute game factory's latest games: two node queries. With
  fewer than two games of the Portal's type, the delays are still shown.
- **DuskEVM deposits**: how far DuskEVM trails Dusk, its latest block against
  Dusk's own time for the Dusk block it last took in (the L1Block predeploy).
- The chains are asked at most every 10 minutes, and their answers are kept
  a day per network.
- **Otherwise**: what this browser's own transfers on the route took (the
  middle of the last five completed in 30 days, with two at least), or the
  route's typical time in the network's file. `VITE_ETHEREUM_MIGRATION_SECONDS`,
  `VITE_BSC_MIGRATION_SECONDS`, `VITE_SERVICE_BRIDGE_DELAY_SECONDS` and
  `VITE_DUSKEVM_DEPOSIT_SECONDS` set a deployment's own; `none` clears one.

A route whose time isn't known on this network shows none.

## Gas

Dusk contract calls ask the wallet for their own limit at the node's price:
5M for a deposit, 50M plus the withdrawal's own gas for a proof or claim. A
claim that would need more than `VITE_GAS_LIMIT_UPPER` isn't sent. Transfers
to the bridge account carry the wallet's public-transfer limit, 2.5M, at the
node's price. The quote shows each limit as "up to" and the measured usual
cost next to it. The node's price is the one the page last read: the quote,
the review and the request all use it, so each step shows one fee.

## Configuration

Copy `.env.example` to `.env.local`. Empty values mean the network file's
value, so `VITE_BRIDGE_PROFILE=testnet` alone runs every testnet route. The
other keys are local overrides: a deployment's own endpoints, contracts,
accounts, fee or times for the file's routes, or fewer routes. A chain or a
route the file doesn't have can't be added. DuskEVM's contract IDs in the
file come from its address book (duskevm-genesis); they are never guessed
from EVM addresses. The anchor state registry
(`VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID`) is optional. Without it
(`none`), a proof goes against the newest covering game.

The same keys can be provided before the app loads through
`window.__DUSK_BRIDGE_CONFIG__`, which allows one immutable build to be
deployed with environment-specific configuration.

For local testnet use:

```dotenv
VITE_BRIDGE_PROFILE=testnet
```

The page writes times, IDs and fees as every Dusk app does
(`@dusk-network/networks/format`): times in English words on the viewer's
clock, with the zone ("Today, 14:05 CET", records in full: "Wed 28 Oct
2026, 14:05 CET"); Dusk contract IDs without 0x and EVM addresses with their
checksum, shortened as 6…6 for Dusk IDs, accounts and hashes and as 0x and
4…4 for EVM addresses and transactions; the most a fee can be rounded up,
and the fee a transfer paid exact in its receipt's details.

The footer and About this page link the Terms of use and Privacy policy the
network's file names, as the explorer does. A deployment can link its own
(`VITE_TERMS_URL`, `VITE_PRIVACY_URL`).

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
