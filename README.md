# Dusk Bridge

A dedicated bridge dApp for moving DUSK between Ethereum, BNB Smart Chain,
Dusk and DuskEVM, and on testnet DUSK, EURd and USDd between Dusk and Sepolia
through Hyperlane.

The application coordinates bridge transactions but never owns wallet keys:

- Dusk Connect talks to a compatible Dusk wallet extension, for the account,
  signing and sending only. With more than one installed, or without the one
  chosen here before, Connect Dusk Wallet asks which to use. Once connected,
  its account in the top bar offers another profile, or to disconnect: a
  wallet whose own profile switch doesn't reach the page (Dusk Wallet 0.3.0)
  is changed there. A disconnect the wallet refuses is said, and no other
  profile is asked for until one succeeds.
- An injected EVM wallet handles Ethereum, BSC and DuskEVM approvals.
- Reown AppKit provides browser-wallet discovery and WalletConnect when
  `VITE_REOWN_PROJECT_ID` is configured.
- The source-chain wallet signs each transaction.
- Chain state is read from the deployment's own Dusk node and EVM RPCs, not
  through a wallet. Hyperlane's routes are the exception: Sepolia is read
  through the EVM wallet while it's on Sepolia, since a public RPC can answer
  from a block or two back.

Keeping this application separate prevents the EVM bridge dependency tree from
becoming part of the Dusk wallet extension. The extension can link here and
remain a narrowly scoped wallet and signer.

## Routes

One deployment serves one network (`VITE_BRIDGE_PROFILE`), and every route
stays on that network's counterparts. There are three routes, and a fourth on
testnet:

- **BNB Smart Chain ↔ Dusk**, both ways: BEP20 DUSK migrates to Dusk, and
  DUSK sent to the bridge account is paid out as BEP20 DUSK;
- **Ethereum → Dusk**, one way, since the ERC20 contract can't mint: ERC20
  DUSK migrates to Dusk;
- **Dusk ↔ DuskEVM**, both ways, with DuskEVM's own deposit and withdrawal;
- **Dusk ↔ Sepolia through Hyperlane**, on testnet: DUSK, EURd and USDd, each
  both ways ([Hyperlane](#hyperlane)).

| Mainnet | Testnet |
| --- | --- |
| BNB Smart Chain → Dusk | |
| Dusk → BNB Smart Chain | |
| Ethereum → Dusk | Sepolia → Dusk, not running |
| | Dusk → Sepolia, not running |
| Dusk → DuskEVM, once DuskEVM is on mainnet | Dusk → DuskEVM |
| DuskEVM → Dusk, once DuskEVM is on mainnet | DuskEVM → Dusk |
| | Dusk → Sepolia through Hyperlane: DUSK, EURd, USDd |
| | Sepolia → Dusk through Hyperlane: DUSK, EURd, USDd |

Each chain has one name per network: Dusk and DuskEVM keep theirs next to the
network badge, and Ethereum and BNB Smart Chain go by what the network's file
calls them there, as the web wallet and the extension do. DUSK on them is named
by its token standard: ERC20 DUSK and BEP20 DUSK. An EVM wallet on a chain this
network doesn't route goes by what another network's file calls it, as Ethereum
on testnet.

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
- DuskEVM withdrawal initiation, proof and claim on Dusk;
- Hyperlane transfers both ways, with an approval first for EURd and USDd
  where needed, and claims of what a route holds in escrow; and
- following every transfer to its end, with links to both explorers.

DUSK moves in whole Lux (9 decimals), the precision Dusk holds. EURd and USDd
move in their own 6 decimals, the same on both sides.

## Hyperlane

Testnet's Hyperlane deployment runs between Dusk testnet (Hyperlane domain
1146442572) and Sepolia (11155111), with three routes: DUSK, locked in a
native route on Dusk and minted as a token on Sepolia (9 decimals both
sides), and EURd and USDd, issued on Dusk as canonical DRC20s and locked in a
collateral route each (6 decimals). Sepolia is viem's `sepolia`, and the
network file's chain with its ID, so it keeps one name, its RPC and its
explorer. Sepolia's own routes stay listed as they were, not running.

Its address book is the deployment's record,
`deploy/out/dusk-testnet-sepolia/deployment.json` in
[hyperlane-dusk](https://github.com/dusk-network/hyperlane-dusk), copied into
`src/hyperlane-testnet.json` under the record's own paths, with the record's
sha256: each side's Mailbox, Dusk's gas paymaster, and per token its route,
its token on Dusk and its token on Sepolia. Nothing is derived.
`node scripts/check-hyperlane-book.mjs <deployment.json>` compares the two.
Mainnet has no deployment. The Hyperlane data driver
(`public/drivers/hyperlane_dusk_data_driver.wasm`, built from hyperlane-dusk
at ef912e9 with `make data-driver`) is pinned by its SHA-256 and runs only
when it matches; it writes the routes' and Mailboxes' queries and reads their
answers and events.

On the card, a pair that moves more than one token offers them beside the
amount; where Sepolia's own DUSK route runs too, each DUSK says what
arrives. A transfer is checked before any wallet opens, since a Dusk call
that fails pays its whole gas limit:

- **Dusk → Sepolia**: `transfer_remote` on the token's route, its 48 bytes
  as the routes read them (the recipient first, a 20-byte address padded to
  32, then the domain and the amount). Its deposit is the route's own quote,
  `quote_transfer_remote`, read as the request is built and again as it's
  signed, and for DUSK the amount too. A quote that moved since the review
  is shown, and nothing is sent until it's confirmed again. EURd and USDd
  are approved for the route first, exactly the amount, only where the
  route's allowance is short: the token's `approve`, and the transfer once
  that's in a block; the approval's fee counts in the transfer's network fee
  on its receipt, and its review shows the bridge fee read with it: one that
  moved by the time it's sent is shown again first. Until the allowance is
  read there's nothing to review, and one that couldn't be read is said,
  with Try again: the steps are never guessed. Before each step, and again
  as it's sent: an amount above 0 that fits a u64, a 20-byte EVM recipient,
  the routers both ways (the route's to the book's Sepolia token, and that
  token's `routers` for Dusk to the route) and the route's kind
  (`state_version` 5 for DUSK's native route, 7 for a collateral route that
  locks the book's token), read again for every request, as either owner can
  enroll another router, the Mailbox's room for a new payer, the token held
  and not paused, DUSK for the fees, and both steps' gas limits within
  `VITE_GAS_LIMIT_UPPER`.
- **Sepolia → Dusk**: `transferRemote(1146442572, recipient, amount)` on the
  Sepolia token, which burns it, with its whole charge as the token quotes
  it (`quoteTransferRemote`, HypERC20 12.3.0) as the call's value, read as
  it's sent, and simulated as the page reads Sepolia. A fee in the token on
  top of the amount, which the page can't show yet, is refused. At review
  and again as it's sent, the routers both ways are checked, and Dusk's
  token isn't paused, since the route couldn't pay it out. A fee that moved
  since the review shows on all of it, its fee, checks and wallet lines, and
  nothing is sent until it's confirmed again. The recipient is the Dusk
  account's hash, keccak256 of its 96-byte key; the review lists the account
  it stands for, and reads for it whether it waits for a claim. Sepolia is
  among the chains a WalletConnect wallet is offered. A send cancelled or
  replaced in the wallet ends there.
- **Escrow**: a route holds the first transfer to a Dusk account until it's
  claimed, which also registers the account, so later ones arrive directly.
  The card shows what each route holds for the connected Dusk account
  (`pending_balance`), with Claim: `claim_pending`, signed by that account.
  On the way into Dusk, a recipient typed, or handed over in a link
  (`?to=`), shows that account's instead, with Claim for it:
  `claim_pending_for` its key, from any Dusk account, which pays only the
  network fee. An account without DUSK for its own claim's fee is given that
  link, for another account to claim it with. A transfer's receipt offers
  the claim too, either way, and says it waits to be claimed. While a
  transfer to the account is on its way, the card reads what the routes hold
  every 15 seconds, and at once when a check finds it held. A claim is built
  again as it's sent: what it pays out changed, it's reviewed again. Sent,
  it's followed by its transaction, on the card and on every transfer it
  pays out, across reloads, until that's in a block or failed, or isn't
  found in ten minutes; meanwhile neither the card nor a receipt offers
  another. One that failed on Dusk says so, and what it cost, on the receipt
  and in the list. A claim of EURd or USDd isn't sent while the token is
  paused. A transfer to an account the route doesn't pay yet
  (`is_registered`) says so on its review and receipt.
- **Following**: a transfer's message ID is the Mailbox's on the sending
  side, Dusk's `dispatch_id` event in the transfer's own transaction or
  Sepolia's `DispatchId` log in its receipt. It's on its way until the other
  side's Mailbox says it's delivered (`delivered`), with Sepolia's
  transaction where its `ProcessId` log is found; an RPC can trail the
  chain, so one that arrived without it is looked at again on its receipt,
  and while the page follows it, until it's found or 20 checks have passed.
  Sepolia is read through the EVM wallet while it's on Sepolia, and the
  deployment's RPC otherwise, or where the wallet can't answer the read: a
  public RPC behind a load balancer can answer from a block or two back. A
  call the wallet reverts is its answer, never asked of the RPC again. A
  read that says it isn't delivered, or finds no receipt, never ends a
  transfer, and one that arrived is only looked at again for its delivering
  transaction, never for whether it arrived. On Dusk, the transaction that
  delivered it is the origin of the Mailbox's `process_id` event for its
  message, found in the blocks since the check before (`contractEvents` per
  height) or, for one not watched, around a minute after it was sent; the
  receipt links it. A transfer to Dusk then waits for its claim where the
  route holds it.
- **Times**: about 20 seconds to Sepolia and a minute back, the medians of
  107 testnet transfers on 18 Nov 2026, until this browser's own transfers
  say otherwise: back, to their delivery, however long a claim waited.
  Under a minute, a time is written to the 10 seconds: "~20 s".
- **Links**: the Dusk testnet explorer and sepolia.etherscan.io. Hyperlane's
  own explorer doesn't index Dusk.

A transfer is looked up by its hash on either side. Activity lists those
sent or looked up here; it doesn't read Hyperlane transfers from the
networks yet.

## Pages

- **Start**: the bridge card, with each route's time and cost, and on a phone
  without Dusk Wallet whether it works there. Under it, for DUSK on Ethereum or
  BNB Smart Chain, a link per chain that opens its route to Dusk.
- **A task**: the amount, where it goes, and under the card one line with the
  route's time and its fees, summed where they're paid in one coin (the most
  a Dusk fee can be, an EVM chain's as estimated); the split is behind the
  line, as is a withdrawal's claim date. With the EVM wallet on another chain
  than the route sends from, as the wallet itself says, the button offers to
  switch it, here and on the review. Nothing goes out from another chain.
  Under the route, how it's doing, read once as its card opens and kept 10
  minutes (`bridgeStatus`), where it could make someone wait: "Payouts late:
  last 3 hours ago", or "Can pay 120 DUSK now: yours may wait" where a
  balance can't pay what's sent. It's only said: nothing waits for it, and
  nothing it says stops anyone from sending. On the way into Dusk, what the
  migration contract may still take from the EVM wallet, read on the chain
  and kept nowhere, shows above the form as an open approval, with Finish,
  the review of what it still lets go, and Revoke, an approval of 0 reviewed
  as any request is. Where a pair moves more than one token, as Hyperlane's
  do, the token is chosen beside the amount; what Hyperlane's routes hold in
  escrow for the account shows above the form, with Claim.
- **Review**: what moves, whom it pays, in full, and in one line what
  becomes public; then what could cost money, said once (another account
  paid, a first transfer held until claimed, an earlier approval that covers
  the amount and what stays approved, one an approval replaces), the fees
  and the time, and the steps where there are two. A check (balances, gas)
  is said only where it fails, as what keeps Confirm off. What the wallet's
  window shows, its contract, spender, method and raw units, is the window's
  own, and not repeated. Cancel and confirm are equal; a request you reject
  in the wallet is said in grey, not as a failure. A Dusk call is built
  before Confirm can be pressed, and the reviewed request is what is sent.
- **Receipt**, at `#/transfer/<hash>`: what moved and whom it paid, in full,
  the steps with times, explorer links and transaction IDs, what its fees
  came to, the receipt link to copy, and, under Details, both transactions,
  short and in full on copy, and its amounts as
  every Dusk app says them (`transferLedger`): what you sent, the bridge fee,
  the network fee and what you received, to the Lux, and gas as wallets write
  it. A migration's gas counts the approval it spent, whichever app signed
  it and whenever, as its chain says (`migrationFacts`), whose transaction is
  listed beside the migration's, and says which it counts: the migration
  alone where an earlier transfer spent that approval first, and, saying so,
  where the approval can't be read, as once the RPC no longer gives logs that
  old. One cancelled in the wallet counts the approval sent for it, until a
  migration this browser knows of spends that approval and counts it
  instead. It shows no balances: the link is safe to share. While a transfer
  is on its way, "Notify me" asks the browser for a notification, only
  then, and it stays chosen on this device. Whoever isn't looking at the page
  when one ends gets that, and the tab's title says so until they're back; where
  notifications are refused or a page can't send them, as on most phones, it's
  the title alone, and the receipt says so. A transfer's end is told, to
  screen readers and in the title, only for one the page saw on its way: sent
  from it, or still on its way when it checked; old ones found as the page
  opens are listed, not read out. A withdrawal waiting for
  its claim counts down, says when a clock change falls inside the wait, and
  offers an .ics file made in the browser ("Add to calendar"). A transfer to
  BNB Smart Chain that arrived at the connected EVM wallet offers "Add DUSK to
  MetaMask", the wallet's own request to show the token (`wallet_watchAsset`:
  the network file's token, DUSK, 18 decimals), as the way back's form does
  beside the balance while the wallet holds none. Only a wallet that takes
  the request is offered it; one that added DUSK isn't offered it again for
  that address and chain in this browser, and a refusal says nothing. Once
  it's added, "DUSK added to MetaMask." takes the offer's place for the visit.
- **Activity**: the connected accounts' transfers, read from the networks
  (below), plus any sent or looked up on this device, each with whom it pays
  and its transaction's short ID. A withdrawal under way that pays another
  Dusk account is listed apart, under Sent to someone else, with a quiet
  Prove, until your account proves it. "Look up a transfer" finds a
  transfer's route from its transaction ID alone.
- **About**: every address and contract ID each route uses, short, in full
  on hover and on copy, with explorer links; what each does, behind Details.

A link can open the card on a route: `#/move/<route>`, by its ID
(`bsc-to-dusk`), by one of the three routes (`bsc`, `ethereum`, `duskevm`), or
as earlier links named it (`migrate`, `to-duskevm`, `from-duskevm`). For a
route into Dusk, `?to=<account>` hands over the Dusk account it pays, as the
web wallet's Migrate can: the card shows "Paying <account>" until it's
changed.

## Activity

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
  down, synced by `@dusk-network/app-core/duskevm-withdrawals`. Each
  withdrawal's Dusk recipient is decoded from its `extraData`. And the
  transfers from Dusk that pay it, from any account: those to a bridge account
  with the address as the memo, from the archive's memo index
  (`transactionsByMemo`), in one request, and one more for when those found
  for the first time were sent, so the list orders them by it.

## Following a transfer

Every entry is rebuilt from its route and source transaction hash, so a
receipt link or a looked-up hash opens the same transfer on any device.
Which payout or credit is a transfer's comes from
`@dusk-network/app-core/bridge`. A transfer on its way is checked every 15
seconds, every minute while the page is in the background, and every 5
seconds while its receipt is open around when it usually arrives: from a
minute before its usual time until five minutes after. An approval or a
migration the EVM wallet speeds up goes by the transaction mined in its
place, as does the receipt open on it; one cancelled or replaced there moved
nothing, and says so.

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
  Portal and dispute-game state, never inferred from elapsed time. Where each
  one is, its proof and its claim come from
  `@dusk-network/app-core/duskevm-withdrawals`, which reads every call back
  against the withdrawal before the page hands it to Dusk Wallet.

The claim date is when the Portal takes the claim, worked out as every Dusk
app does (`@dusk-network/networks/duskevm`): the later of the proof plus the
Portal's proof maturity delay, and the proof's dispute game's resolution plus
its finality delay. Both are read on Dusk, from the Portal and the game's hub,
in one Multicall for Dusk query (once a check knows the proof's game). The
times are the contracts' own: testnet's deployed contracts count Dusk block
height × 10, which the latest block converts to a date; the others count block
time, a second later for their strict comparisons.

- Before the proof: "~7 days: send, prove after ~30 min, claim 7 days
  later" under the card, with the chain's figures. Before sending, the
  review dates it: "Claim from about 5 Nov, 12:28 CET".
- After it: "Claim from 2 Nov, 04:20 CET" once the game has resolved, and
  "Claim from about …", the earliest it can be, before that. A game left
  unresolved more than an hour past its clock is late: "Waiting for DuskEVM
  to settle this proof. Claim from … at the soonest.", with no countdown or
  calendar entry, since that date moves on with each check.
- A claim is ready once the Portal's check passes, its game has resolved for
  the defender and the Portal still takes it, and its date has come. A proof
  whose game the Portal refuses (blacklisted, retired, no longer respected,
  or won by the challenger) is made again.
- A proof goes against a game that covers the withdrawal, has already
  resolved, and that the Portal would take, where there is one: the anchor
  state registry calls it proper and respected, and it was created after the
  respected game type last changed (`respectedGameTypeUpdatedAt`), as the web
  wallet requires. Its date is then exact when the proof is made ("If you
  prove now, you can claim from …"). Otherwise the proof goes against the
  newest covering game the Portal takes a proof against.

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
  Hyperlane's routes take their measured times ([Hyperlane](#hyperlane)).

A route whose time isn't known on this network shows none.

## Gas

Dusk contract calls ask the wallet for their own limit at the node's price:
5M for a deposit, 50M plus the withdrawal's own gas for a proof or claim. A
claim that would need more than `VITE_GAS_LIMIT_UPPER` isn't sent. A
Hyperlane transfer takes 5M (it spends 2.13M to 2.22M), an approval 3M
(1.84M), a claim of a route's escrow 3M (1.9M), and one for another account
80M, its key decoded on chain (about 59M), each refused where it's past
`VITE_GAS_LIMIT_UPPER`. Transfers
to the bridge account carry the wallet's public-transfer limit, 2.5M, at the
node's price. The quote shows each limit as "up to", as Dusk Wallet does.
The node's price is the one the page last read: the quote, the review and
the request all use it, so each step shows one fee.

## Configuration

Copy `.env.example` to `.env.local`. Empty values mean the network file's
value, so `VITE_BRIDGE_PROFILE=testnet` alone runs every testnet route. The
other keys are local overrides: a deployment's own endpoints, contracts,
accounts, fee or times for the file's routes, or fewer routes. A chain or a
route the file doesn't have can't be added. DuskEVM's contract IDs in the
file come from its address book (duskevm-genesis); they are never guessed
from EVM addresses. The anchor state registry
(`VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID`) is optional. Without it
(`none`), a proof goes against the newest covering game the Portal hasn't
blacklisted and the challenger hasn't won.

The same keys can be provided before the app loads through
`window.__DUSK_BRIDGE_CONFIG__`, which allows one immutable build to be
deployed with environment-specific configuration. Such a build leaves
`VITE_PAGE_POLICY` unset: its page then carries no Content-Security-Policy,
as one made from the build's settings would refuse the addresses given at
runtime, and its host sends one for those.

For local testnet use:

```dotenv
VITE_BRIDGE_PROFILE=testnet
```

`VITE_HYPERLANE_TOKENS` keeps the Hyperlane tokens listed, by symbol
(`dusk,eurd`), all of them unless set; `none` runs none. `VITE_PAUSED_ROUTES`
pauses any of their routes by ID (`dusk-to-sepolia-usdd`).

The page writes times, IDs and fees as every Dusk app does
(`@dusk-network/networks/format`): times in English words on the viewer's
clock, with the zone ("Today, 14:05 CET", "28 Oct, 14:05 CET", the year
only where it isn't this one); Dusk contract IDs without 0x and EVM
addresses with their checksum, shortened as 6…6 after any 0x
("0x0d7f01…DE6ea5", "rz2gFT…3VGXyt"), and as 4…4 in Activity's rows; whom
a transfer pays in full on its review and receipt; the most a fee can be
rounded up. Amounts go by `@dusk-network/app-core/amounts`, as most wallets
write them: a row in Activity and the form's balance line up to 4 decimals,
EURd and USDd to the cent, rounded down, with every digit on hover; Max, the
review and the receipt to the Lux, gas paid as a row writes it.

The footer and About this page link the Terms of use and Privacy policy the
network's file names, as the explorer does. A deployment can link its own
(`VITE_TERMS_URL`, `VITE_PRIVACY_URL`).

Some page content appears only when configured, since none of it is guessed:
a support contact (`VITE_SUPPORT_URL`, `VITE_SUPPORT_LABEL`), the other
network's bridge site (`VITE_MAINNET_BRIDGE_URL`, `VITE_TESTNET_BRIDGE_URL`),
a Status link, and a guide per route (`VITE_DOCS_MIGRATION_URL`,
`VITE_DOCS_SERVICE_URL`, `VITE_DOCS_DUSKEVM_URL`; the docs' bridge guides
describe the web wallet's bridge).

The page uses the web wallet's Söhne files.

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

`node scripts/compare-withdrawals.mjs <checkout>` compares, on testnet, the
proofs and claims this checkout and another hand Dusk Wallet for user2's
withdrawals, byte for byte, with a stand-in wallet that signs nothing. CI
doesn't run it.

`node scripts/hyperlane-live.mjs check <dusk account> <sepolia address>
[amount]` checks, on testnet, each Hyperlane route as the page does before
a send, and reads what a transfer of each token costs both ways and what the
accounts hold for it, a read that failed said as unknown; `follow <hash>`
follows one as its receipt does, to the Dusk transaction that delivered it.
Neither signs or sends anything. CI doesn't run them.

## Trust boundaries

- Wallet extensions retain keys and display every signing request.
- The browser talks directly to configured Dusk and EVM RPC endpoints. For
  Hyperlane's routes, it reads Sepolia through the EVM wallet while the wallet
  is on Sepolia.
- Data drivers run only when they match their pinned SHA-256.
- Local storage contains transaction metadata, what was read for My
  transfers, what each migration paid on its own chain once it's final, the
  chains' times, how each route was doing, per network and
  account, whether this device was asked to notify, and where DUSK was added
  to an EVM wallet; no keys and none of
  your balances. Where the browser denies the
  page storage, they're kept in memory while the page is open.
- Contract IDs, RPC endpoints and this site's origin are deployment trust
  inputs. Review them before publishing.

## Deploying

Each network has its own site on Cloudflare (`wrangler.jsonc`), deployed by
the Deploy workflow:

| Site | Network | Deployed from |
| --- | --- | --- |
| `https://bridge.testnet.dusk.network` | testnet | `main`, as it's pushed |
| `https://bridge.dusk.network` | mainnet | a `bridge-v*` tag, once `DEPLOY_MAINNET` is `true` |

Each is built with its settings in `deployments.json`, never with secrets:
Vite builds every `VITE_` setting into the code. They name the profile, the
endpoints its network's file gives (a test holds them to it, so a bump of
`@dusk-network/networks` that moves one moves them too), the sites' own
addresses, the Reown project, and `VITE_PAGE_POLICY=true`, so the built page
carries its Content-Security-Policy (`scripts/csp.js`, from what
`src/config.js` makes of those settings): its own scripts alone, with
WebAssembly, and requests only to its Dusk node, its EVM chains' RPCs,
DuskEVM's where its routes run, Dusk Domains' site and WalletConnect.
Cloudflare sends it as a header too, with frame-ancestors. `deploy/worker.js`
answers what no file does: the page's routes are in its fragment, so anything
else is a 404. The workflow runs the commit's tests and production audit
(`npm run check`) itself before it attests or deploys anything.

To release mainnet:

1. Set the version (`npm version 1.0.0 --no-git-tag-version`) in a pull
   request, and merge it.
2. Make the repository public, so the Deploy workflow attests the release's
   build.
3. Tag the merge `bridge-v1.0.0` and push the tag. The workflow refuses a tag
   that doesn't name `package.json`'s version.
4. The tag deploys only while the `DEPLOY_MAINNET` repository variable is
   `true`. One pushed before that deploys nothing: once the variable is set,
   run the Deploy workflow on the tag. Once mainnet is live, add
   `VITE_MAINNET_BRIDGE_URL` to testnet's settings, so testnet links to it.

Each build writes `dist/build-manifest.json`, served beside the app: the
version, commit, settings and every file's SHA-256. To rebuild what a site
serves and compare, from a clone:

```sh
node scripts/verify-build.js https://bridge.dusk.network/ [--attested]
```

A site is its address's root: a transfer's link (`/#/transfer/…`) is the
same site, and any other path or a query is refused, as is a build with
uncommitted changes. The script builds only a commit from where the site is
deployed from, fetched from this repository on GitHub whatever `origin` is:
for testnet, one in `main`'s history; for mainnet, the commit of the
release's `bridge-v*` tag. Any other site's needs `--trusted-ref <ref>`, a
branch, tag or commit you trust whose history has it. The site must be built
with the settings `deployments.json` lists for it at that commit; where your
checkout's differ, the script says so as drift, which fails nothing.

`--attested` first checks with GitHub's CLI that the Deploy workflow built
the manifest from the commit it names, from `main` for testnet or the
release's tag for mainnet. The workflow attests a build only while the
repository is public. To serve testnet's build as Cloudflare does, built with
its settings in a mode of their own, which no other build reads, and with
Wrangler from its own lockfile:

```sh
npm ci --ignore-scripts --prefix deploy
node scripts/deployment-env.js https://bridge.testnet.dusk.network/ > .env.testnet.local
npm run build -- --mode testnet && node deploy/stage.js
deploy/node_modules/.bin/wrangler dev --env testnet
```
