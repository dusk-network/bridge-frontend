// A Copy button says it copied on itself: for COPIED_MS its icon is a check,
// or its words say "Copied" (style.css crossfades its two faces, .copy-swap),
// its name is "Copied", and screen readers hear "Copied" once, from the
// page's polite live region.

/** How long Copy says Copied, in ms. */
export const COPIED_MS = 1_500;

const timers = new WeakMap();
const names = new WeakMap();

/**
 * @param {Element} button - the Copy button pressed
 * @param {{ announce?: (text: string) => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [opts]
 */
export function showCopied(button, { announce, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!button) return;
  if (!names.has(button)) names.set(button, button.getAttribute("aria-label"));
  clearTimer(timers.get(button));
  button.setAttribute("data-copied", "");
  button.setAttribute("aria-label", "Copied");
  announce?.("Copied");
  timers.set(
    button,
    setTimer(() => {
      const name = names.get(button);
      names.delete(button);
      button.removeAttribute("data-copied");
      if (name == null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", name);
    }, COPIED_MS),
  );
}
