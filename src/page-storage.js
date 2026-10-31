// Where the page keeps what it sends, follows and reads: this browser's
// localStorage, or, where the browser denies the page Web Storage (site data
// blocked, where reading `localStorage` itself throws), memory, while the
// page is open.

let memory = null;

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function memoryStorage() {
  const items = new Map();
  return Object.freeze({
    getItem: (key) => items.get(String(key)) ?? null,
    removeItem: (key) => void items.delete(String(key)),
    setItem: (key, value) => void items.set(String(key), String(value)),
  });
}

/** Whether the page can keep anything in this browser past the visit. */
export const webStorageAllowed = () => Boolean(browserStorage());

/** localStorage, or this visit's memory where the browser denies it. */
export const pageStorage = () => browserStorage() ?? (memory ??= memoryStorage());
