# Dusk Bridge

A dedicated bridge dApp for moving DUSK between Ethereum, BNB Smart Chain,
Dusk mainnet and DuskEVM.

The application coordinates bridge transactions but never owns wallet keys:

- Dusk Connect talks to a compatible Dusk wallet extension.
- An EVM provider will handle Ethereum, BSC and DuskEVM approvals.
- The source-chain wallet signs each transaction.

Keeping this application separate prevents the EVM bridge dependency tree from
becoming part of the Dusk wallet extension. The extension can link here and
remain a narrowly scoped wallet and signer.

## Initial scope

- Ethereum → Dusk mainnet
- BSC → Dusk mainnet
- Dusk mainnet → BSC
- Dusk mainnet → DuskEVM
- DuskEVM → Dusk mainnet

Contract addresses, chain identifiers and transaction encodings must be pinned
before transaction submission is enabled. The current application deliberately
implements only route selection and Dusk wallet discovery.

## Development

```sh
npm install
npm run dev
```

Run the checks with:

```sh
npm run check
```

