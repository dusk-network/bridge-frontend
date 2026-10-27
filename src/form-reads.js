// Balances, prices and gas estimates for the form, read in the background.
// Reads overlap: the route or an account changes, typing goes on. Each answer
// lands only if no newer read of its kind started since, so a slower, older
// answer never overwrites a newer one.

const WEI_PER_LUX = 1_000_000_000n;

export function createFormReads({ services, onChange = () => {} }) {
  const reads = { duskBalance: null, gasPrice: 1n, l2: null, migration: null };
  let loads = 0;
  let estimates = 0;

  /**
   * Reads what the form for `route` needs, for the connected accounts.
   * `gas` is what estimates need: the amount in wei and the Dusk recipient.
   */
  async function load({ dusk, evm, gas = {}, route }) {
    const mine = ++loads;
    estimates += 1;
    const fresh = () => mine === loads;
    const set = (patch) => {
      if (!fresh()) return false;
      Object.assign(reads, patch);
      return true;
    };
    try {
      set({ gasPrice: await services.node.gasPrice() });
    } catch {}
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
      let l2 = null;
      try {
        l2 = await services.evmReads.withdrawalState(evm, gas);
      } catch {}
      if (set({ l2 })) onChange();
      return;
    }
    if (fresh()) onChange();
  }

  /** The node's gas price alone, for pages without a form; whether it changed. */
  async function price() {
    try {
      const next = await services.node.gasPrice();
      if (next === reads.gasPrice) return false;
      reads.gasPrice = next;
      return true;
    } catch {
      return false;
    }
  }

  /** A gas price read elsewhere, as a review's request: the latest, for every page. */
  function usePrice(price) {
    reads.gasPrice = price;
    return price;
  }

  /** Gas estimates for the amount and recipient as they are now. */
  async function estimate({ evm, gas = {}, route }) {
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
        const l2 = await services.evmReads.withdrawalState(evm, gas);
        if (fresh()) {
          reads.l2 = l2;
          onChange();
        }
      }
    } catch {}
  }

  /** Forgets `keys`, and every read still running: an account changed. */
  function reset(keys) {
    loads += 1;
    estimates += 1;
    for (const key of keys) reads[key] = null;
  }

  return Object.freeze({ estimate, load, price, reads, reset, usePrice });
}
