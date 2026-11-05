// Says when a transfer ends to whoever isn't looking at this page: in the tab's
// title always, and by a browser notification once they chose that. The
// browser is asked only when they press for it, never as the page opens.

import { pageStorage } from "./page-storage.js";

const KEY = "dusk-bridge:notify:v1";

/** What the receipt says, for each state but "offer", which offers it. */
export const NOTICE_WORDS = Object.freeze({
  on: "You'll get a notification when it arrives.",
  refused: "Notifications aren't allowed for this site, so this tab's title will say when it arrives.",
  unavailable: "This tab's title will say when it arrives.",
});

/**
 * @param {object} [deps]
 * @param {() => boolean} [deps.available] whether this browser can notify from a page: most phones can't
 * @param {(href: string) => void} [deps.onOpen] a notification was pressed
 */
export function createArrivalNotice({ available = () => true, onOpen = () => {} } = {}) {
  let refused = false;
  // The tab's own title, while it says what ended.
  let plainTitle = null;

  const api = () => (available() ? (globalThis.Notification ?? null) : null);
  const wanted = () => pageStorage().getItem(KEY) === "on";
  const looking = () => globalThis.document?.visibilityState === "visible" && Boolean(globalThis.document.hasFocus?.());

  /** "offer" until they chose, then "on" or "refused"; "unavailable" where a page can't notify. */
  function state() {
    if (!api()) return "unavailable";
    if (wanted() && api().permission === "granted") return "on";
    return refused ? "refused" : "offer";
  }

  return Object.freeze({
    /** They pressed for it: the browser is asked, if it hasn't been answered yet. */
    async choose() {
      if (!api()) return state();
      const answer = (await api().requestPermission()) ?? api().permission;
      refused = answer !== "granted";
      if (!refused) {
        try {
          pageStorage().setItem(KEY, "on");
        } catch {}
      }
      return state();
    },
    /** A transfer ended. Whoever is looking at the page sees it there. */
    ended({ href, id, title }) {
      if (looking()) return;
      const page = globalThis.document;
      if (page) {
        plainTitle ??= page.title;
        page.title = `${title} · ${plainTitle}`;
      }
      if (state() !== "on") return;
      try {
        const notice = new (api())(title, { icon: "/dusk-glyph.svg", tag: id });
        notice.onclick = () => {
          globalThis.focus?.();
          onOpen(href);
          notice.close?.();
        };
      } catch {
        // Some browsers notify only through a service worker: the title says it.
      }
    },
    /** They're back: the title is the tab's own again. */
    seen() {
      if (plainTitle === null || !looking()) return;
      globalThis.document.title = plainTitle;
      plainTitle = null;
    },
    state,
    stop() {
      refused = false;
      try {
        pageStorage().removeItem(KEY);
      } catch {}
    },
  });
}
