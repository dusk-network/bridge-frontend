const STORAGE_KEY = "dusk-bridge:activity:v1";
const MAX_ITEMS = 40;

export function readActivity(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(validItem).slice(0, MAX_ITEMS)
      : [];
  } catch {
    return [];
  }
}

export function recordActivity(item, storage = localStorage) {
  const next = [
    { ...item, createdAt: item.createdAt ?? new Date().toISOString() },
    ...readActivity(storage).filter((entry) => entry.id !== item.id),
  ].slice(0, MAX_ITEMS);
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function updateActivity(id, patch, storage = localStorage) {
  const next = readActivity(storage).map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearActivity(storage = localStorage) {
  storage.removeItem(STORAGE_KEY);
}

function validItem(item) {
  return (
    item && typeof item.id === "string" && typeof item.routeId === "string"
  );
}
