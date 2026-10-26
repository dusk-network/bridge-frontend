// Discovery for the connected accounts, one run at a time. A run that ends
// after the accounts changed keeps what it found, but not its time or its
// coverage: those were for the accounts before, and the new ones are read
// right after it.

const keyOf = ({ dusk, evm }) => `${dusk ?? ""}|${String(evm ?? "").toLowerCase()}`;

/**
 * @param {object} options
 * @param {() => { dusk: string|null, evm: string|null }} options.accounts the connected accounts now
 * @param {(accounts: { dusk: string|null, evm: string|null }) => Promise<{ errors?: unknown[], sources?: object }>} options.read
 *   reads the networks for `accounts` and keeps what it finds
 * @param {number} options.freshMs how long a run counts as recent
 * @param {() => void} [options.onChange] called when a run starts and ends
 * @param {() => number} [options.now]
 */
export function createDiscoveryRuns({ accounts, freshMs, now = Date.now, onChange = () => {}, read }) {
  let state = { at: 0, errors: [], key: "", running: false, sources: {} };

  async function run({ more = false } = {}) {
    const who = accounts();
    if (!who.dusk && !who.evm) return;
    // One at a time: the running one looks at the accounts when it ends.
    if (state.running) return;
    const key = keyOf(who);
    if (!more && key === state.key && state.at > 0 && now() - state.at < freshMs) return;
    const before = state;
    state = { ...state, errors: [], key, running: true };
    onChange();
    let outcome;
    try {
      outcome = await read(who);
    } catch (error) {
      outcome = { errors: [error] };
    }
    const changed = keyOf(accounts()) !== key;
    state = changed
      ? { at: 0, errors: [], key: "", running: false, sources: {} }
      : {
          at: now(),
          errors: outcome?.errors ?? [],
          key,
          running: false,
          sources: outcome?.sources ?? (before.key === key ? before.sources : {}),
        };
    onChange();
    if (changed) await run();
  }

  return Object.freeze({
    /** The last run's time, errors and coverage, and whether one is running. */
    get state() {
      return state;
    },
    /** The next run reads the networks, however recent the last one. */
    expire() {
      state = { ...state, at: 0 };
    },
    run,
  });
}
