# Dusk Bridge

A dedicated bridge dApp for moving DUSK between Ethereum, BNB Smart Chain,
Dusk mainnet and DuskEVM.

The application coordinates bridge transactions but never owns wallet keys:

- Dusk Connect talks to a compatible Dusk wallet extension.
- An injected EVM wallet handles Ethereum, BSC and DuskEVM approvals.
- Reown AppKit provides browser-wallet discovery and WalletConnect when
  `VITE_REOWN_PROJECT_ID` is configured.
- The source-chain wallet signs each transaction.

Keeping this application separate prevents the EVM bridge dependency tree from
becoming part of the Dusk wallet extension. The extension can link here and
remain a narrowly scoped wallet and signer.

## Routes

- Ethereum → Dusk mainnet
- BSC → Dusk mainnet
- Dusk mainnet → BSC
- Dusk L1 → DuskEVM
- DuskEVM → Dusk L1

The legacy Ethereum/BSC migration contract addresses and the operated
mainnet-to-BSC account are pinned to the same values used by the Dusk Web
Wallet and documentation. DuskEVM is currently a testnet deployment; its Dusk
contract IDs must be supplied by the deployment environment.

The app supports:

- the ERC20/BEP20 approve-and-migrate sequence;
- native Dusk-to-BSC transfers with a trimmed, validated EVM memo;
- native Dusk-to-DuskEVM deposits;
- DuskEVM withdrawal initiation, current-state lookup, proof submission and
  finalization; and
- resumable local activity without storing keys or secrets.

Withdrawal readiness is read from the portal and dispute-game state. It is not
inferred from elapsed time.

## Configuration

Copy `.env.example` to `.env.local`. The DuskEVM contract IDs come from the
trusted deployment address book. They are deliberately not guessed from EVM
addresses.

The same keys can be provided before the app loads through
`window.__DUSK_BRIDGE_CONFIG__`, which allows one immutable build to be
deployed with environment-specific configuration.

## Development

```sh
npm install
npm run dev
```

Run the checks with:

```sh
npm run check
```

`npm run check` runs the focused transaction/encoding tests, creates a
production bundle, and audits production dependencies at high severity.

## Trust boundaries

- Wallet extensions retain keys and display every signing request.
- The browser talks directly to configured Dusk and EVM RPC endpoints.
- Local storage contains transaction metadata only.
- Contract IDs, RPC endpoints and this site's origin are deployment trust
  inputs. Review them before publishing.
