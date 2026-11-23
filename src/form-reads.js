// Balances, prices and gas estimates for the form, read in the background.
// Reads overlap: the route or an account changes, typing goes on. Each answer
// lands only if no newer read of its kind started since, so a slower, older
// answer never overwrites a newer one.

import { duskRecipientHash } from "./hyperlane.js";

const WEI_PER_LUX = 1_000_000_000n;

/**
 * @param {object} deps
 * @param {object} deps.services
 * @param {() => void} [deps.onChange] balances or estimates changed
 * @param {() => void} [deps.onPrice] the gas price moved, read again on its own
 */
export function createFormReads({ services, onChange = () => {}, onPrice = () => {} }) {
  // `hyperlane` is what a Hyperlane route's form reads, and `escrow` what
  // each of its routes holds for the connected Dusk account. `networkBusy`:
  // what waits on Dusk asks more than the gas price pays, so a transaction
  // there may take longer.
  const reads = { duskBalance: null, escrow: null, gasPrice: 1n, hyperlane: null, l2: null, migration: null, networkBusy: false };
  // The node's price and whether it's busy; a node that only gives its price isn't busy.
  const networkGas = async () => (services.node.networkGas ? services.node.networkGas() : { busy: false, price: await services.node.gasPrice() });
  let loads = 0;
  let estimates = 0;
  // Loads and estimates both write `hyperlane`: only the one started last does.
  let hyperlaneReadsStarted = 0;
  // So with `escrow`, read with the form or again on its own.
  let escrowReadsStarted = 0;
  // And with `l2`, a withdrawal's state, read for the amount, recipient and
  // account as they were when it started: an older read never puts its
  // state back over a newer one's.
  let l2ReadsStarted = 0;

  /**
   * Reads what the form for `route` needs, for the connected accounts.
   * `gas` is what estimates need: the amount in wei and the Dusk recipient.
   * `escrowFor` is the Dusk account whose escrow on Hyperlane's routes is
   * read: the connected one unless given.
   */
  async function load({ dusk, escrowFor = dusk, evm, gas = {}, route }) {
    const mine = ++loads;
    estimates += 1;
    // Its place among the reads of `hyperlane` or `l2`, taken as it starts: a later load or estimate comes after it.
    const started = route.mode === "hyperlane" ? ++hyperlaneReadsStarted : null;
    const l2Started = route.mode === "duskevm-withdrawal" ? ++l2ReadsStarted : null;
    const fresh = () => mine === loads;
    const set = (patch) => {
      if (!fresh()) return false;
      Object.assign(reads, patch);
      return true;
    };
    try {
      const { busy, price } = await networkGas();
      set({ gasPrice: price, networkBusy: busy });
    } catch {}
    // What Hyperlane's routes hold for the account, whichever route the card
    // is on; not from a load a newer one took over, which reads no route either.
    if (services.hyperlane && escrowFor && fresh()) void escrowOf(escrowFor, fresh);
    if (route.mode === "hyperlane") {
      if (!fresh()) return;
      const next = await hyperlaneReads({ dusk, evm, gas, route });
      if (started === hyperlaneReadsStarted && set({ hyperlane: next })) onChange();
      if (route.signer === "dusk" && dusk) {
        let balance = null;
        try {
          balance = await services.node.accountBalance(dusk);
        } catch {}
        if (set({ duskBalance: balance })) onChange();
      }
      return;
    }
    if (route.signer === "dusk" && dusk) {
      let balance = null;
      try {
        balance = await services.node.accountBalance(dusk);
      } catch {}
      if (set({ duskBalance: balance })) onChange();
      return;
    }
    if (route.mode === "migration" && evm) {
      let migration = null;
      try {
        migration = await services.evmReads.migrationState(route.from.id, evm);
      } catch {}
      if (!set({ migration: migration && { ...migration, gas: reads.migration?.gas ?? null } })) return;
      onChange();
      if (migration) await estimate({ evm, gas, route });
      return;
    }
    if (route.mode === "duskevm-withdrawal" && evm) {
      const l2 = await withdrawalRead(evm, gas);
      if (l2Started === l2ReadsStarted && set({ l2 })) onChange();
      return;
    }
    if (fresh()) onChange();
  }

  /**
   * The node's gas price alone, for pages without a form, and whether the
   * network is busy; whether either changed. Where one moved, what quotes it
   * is drawn again.
   */
  async function price() {
    try {
      const { busy, price: next } = await networkGas();
      const moved = next !== reads.gasPrice || busy !== reads.networkBusy;
      reads.gasPrice = next;
      reads.networkBusy = busy;
      if (moved) onPrice();
      return moved;
    } catch {
      return false;
    }
  }

  /**
   * What a Hyperlane route's form needs: from Dusk, the route's quote, and a
   * token's balance and the route's allowance; from the EVM chain, the
   * token, the gas coin, the delivery fee and the transfer's gas; and to
   * Dusk, whether the route pays the recipient already. A read that fails is
   * left out; the allowance's says so (`allowanceFailed`), since it decides
   * whether an approval comes first.
   */
  async function hyperlaneReads({ dusk, evm, gas = {}, route }) {
    const reader = services.hyperlane;
    const token = route.hyperlane;
    const settle = (promise) => promise.then((value) => value, () => null);
    if (!reader) return null;
    if (route.signer === "dusk") {
      const [fee, tokenBalance, allowance] = await Promise.all([
        settle(reader.dispatchFee(token, gas.amount && gas.recipient ? { amount: gas.amount, recipient: gas.recipient } : {})),
        token.native || !dusk ? null : settle(reader.tokenBalance(token, dusk)),
        token.native || !dusk ? null : reader.allowance(token, dusk).then((value) => ({ value }), () => ({ failed: true })),
      ]);
      return { allowance: allowance?.value ?? null, ...(allowance?.failed ? { allowanceFailed: true } : {}), fee, tokenBalance };
    }
    const hash = gas.recipientHash ?? null;
    const [state, registered] = await Promise.all([
      evm ? settle(reader.evmState(token, evm)) : null,
      hash ? settle(reader.escrow(hash, [token]).then(([one]) => one.registered)) : null,
    ]);
    const used =
      evm && state?.deliveryFeeWei !== null && state?.deliveryFeeWei !== undefined
        ? await reader.transferGas(token, { amount: gas.amount ?? 1n, owner: evm, recipient: hash ?? `0x${"00".repeat(31)}01`, value: state.deliveryFeeWei })
        : null;
    return { evm: state, gas: used, registered };
  }

  /**
   * What each Hyperlane route holds in escrow for `account`, and, where it
   * holds anything, the DUSK the account has for a claim's fee; kept while no
   * newer read started.
   */
  async function escrowOf(account, fresh) {
    const started = ++escrowReadsStarted;
    try {
      const held = await services.hyperlane.escrow(duskRecipientHash(account));
      const balance = held.some((each) => each.pending > 0n) ? await services.node.accountBalance(account).catch(() => null) : null;
      if (fresh() && started === escrowReadsStarted) {
        reads.escrow = { account, balance, held };
        onChange();
      }
    } catch {}
  }

  /** Gas estimates for the amount and recipient as they are now. */
  async function estimate({ evm, gas = {}, route }) {
    if (route.mode === "hyperlane") {
      const mine = ++estimates;
      const since = loads;
      const started = ++hyperlaneReadsStarted;
      const fresh = () => mine === estimates && since === loads;
      try {
        // A recipient typed on the way into Dusk: its escrow, in place of the connected account's.
        if (services.hyperlane && gas.escrowFor && gas.escrowFor !== reads.escrow?.account) void escrowOf(gas.escrowFor, fresh);
        const next = await hyperlaneReads({ dusk: gas.dusk, evm, gas, route });
        if (fresh() && started === hyperlaneReadsStarted) {
          reads.hyperlane = next;
          onChange();
        }
      } catch {}
      return;
    }
    if (!evm) return;
    const mine = ++estimates;
    const since = loads;
    const fresh = () => mine === estimates && since === loads;
    try {
      if (route.mode === "migration" && reads.migration) {
        const result = await services.evmReads.migrationGas(route.from.id, {
          allowanceWei: reads.migration.allowanceWei,
          amountWei: gas.amountWei ?? WEI_PER_LUX,
          duskAccount: gas.duskAccount,
          owner: evm,
        });
        if (fresh() && reads.migration) {
          reads.migration = { ...reads.migration, gas: result };
          onChange();
        }
      } else if (route.mode === "duskevm-withdrawal") {
        const started = ++l2ReadsStarted;
        const l2 = await withdrawalRead(evm, gas);
        if (fresh() && started === l2ReadsStarted) {
          reads.l2 = l2;
          onChange();
        }
      }
    } catch {}
  }

  /**
   * A withdrawal's state and the call it was read for (`call`: its amount, to
   * its Dusk account, from `evm`; none without both). Where it couldn't be
   * read at all, it says only that: no estimate for that call.
   */
  async function withdrawalRead(evm, gas) {
    let state = { estimated: false };
    try {
      state = await services.evmReads.withdrawalState(evm, gas);
    } catch {}
    return { ...state, call: gas.amountWei && gas.duskAccount ? { amountWei: gas.amountWei, duskAccount: gas.duskAccount, owner: evm } : null };
  }

  /**
   * What each Hyperlane route holds for `account`, read again on its own, as
   * a transfer to it lands in escrow: kept while no newer read started.
   */
  const escrow = (account) => (services.hyperlane && account ? escrowOf(account, () => true) : Promise.resolve());

  /** Forgets `keys`, and every read still running: an account changed. */
  function reset(keys) {
    loads += 1;
    estimates += 1;
    hyperlaneReadsStarted += 1;
    escrowReadsStarted += 1;
    for (const key of keys) reads[key] = null;
  }

  return Object.freeze({ escrow, estimate, load, price, reads, reset });
}
