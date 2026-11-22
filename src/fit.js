// An amount in the card's field, under To, on a button or in a review is
// never clipped and never breaks over lines, at any width and in any
// language's separators: where it doesn't fit at its size, it's drawn
// smaller. In the card, one that doesn't fit beside its token even then takes
// a line of its own, the token under it. The page fits them as it draws them,
// as the window changes width, and once its fonts are in.

/** The smallest size an amount in the card keeps beside its token, in px: smaller, it takes a line of its own. */
const BESIDE_MIN = 22;
/** What a field keeps for its caret past the last digit, in px. */
const CARET = 2;
/** What a font size is rounded down to, in px. */
const STEP = 0.25;

let ruler = null;

/** The width `text` takes in `el`'s font, as the page draws it. */
function textWidth(text, el) {
  const page = el.ownerDocument;
  if (!ruler?.isConnected) {
    // Out of sight and out of the page's width: a box of no size that hides what's in it.
    const box = page.createElement("div");
    box.setAttribute("aria-hidden", "true");
    Object.assign(box.style, { height: "0", left: "0", overflow: "hidden", pointerEvents: "none", position: "fixed", top: "0", visibility: "hidden", width: "0" });
    ruler = page.createElement("span");
    ruler.style.whiteSpace = "pre";
    box.append(ruler);
    page.body.append(box);
  }
  const style = getComputedStyle(el);
  for (const key of ["fontFamily", "fontKerning", "fontSize", "fontStretch", "fontStyle", "fontWeight", "letterSpacing", "textTransform", "wordSpacing"]) ruler.style[key] = style[key];
  for (const key of ["fontFeatureSettings", "fontVariantLigatures", "fontVariantNumeric"]) ruler.style[key] = style[key];
  ruler.textContent = text;
  return ruler.getBoundingClientRect().width;
}

const px = (value) => Number.parseFloat(value) || 0;

/** The width inside `el`'s padding. */
function contentWidth(el) {
  const style = getComputedStyle(el);
  return el.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
}

/** Draws `el` smaller until `width()` fits `room`, from the size it has now. */
function shrink(el, room, width) {
  for (let tries = 0; tries < 4; tries += 1) {
    const need = width();
    if (need <= room) return;
    const size = px(getComputedStyle(el).fontSize);
    el.style.fontSize = `${Math.max(STEP, Math.floor(((size * room) / need) / STEP) * STEP)}px`;
  }
}

/**
 * The card's field or what arrives under To, in its row with its token: as
 * it is where it fits, smaller beside the token down to BESIDE_MIN, else on
 * a line of its own, as small as it needs.
 */
function fitRow(row) {
  const field = row.querySelector("input, .out");
  if (!field) return;
  row.classList.remove("long");
  field.style.removeProperty("font-size");
  const input = field.tagName === "INPUT";
  const text = input ? field.value : field.textContent;
  const width = () => textWidth(text, field) + (input ? CARET : 0);
  if (text && contentWidth(field) > 0 && width() > contentWidth(field)) {
    if ((px(getComputedStyle(field).fontSize) * contentWidth(field)) / width() < BESIDE_MIN) {
      row.classList.add("long");
      field.style.fontSize = `${BESIDE_MIN}px`;
    }
    shrink(field, contentWidth(field), width);
  }
  // What fits shows from its first digit.
  if (input) field.scrollLeft = 0;
}

/**
 * The room a number has in `box`, `data-fit`'s element: its width inside
 * its padding, less the padding of what's between, and of what stands
 * beside it in a row that doesn't wrap, as a review button's "1 of 2".
 */
function roomIn(el, box) {
  let room = contentWidth(box);
  for (let node = el; node && node !== box; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) break;
    const style = getComputedStyle(parent);
    if (parent !== box) room -= px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth);
    if (style.display.includes("flex") && !style.flexDirection.startsWith("column") && style.flexWrap === "nowrap")
      for (const other of parent.children) if (other !== node) room -= other.getBoundingClientRect().width + px(style.columnGap);
  }
  return room;
}

/** A number in a label or a review's amount (`data-fit`, the box whose width it has): smaller where it's wider than that. */
function fitNumber(el) {
  el.style.removeProperty("font-size");
  const box = el.closest(el.dataset.fit);
  const room = box ? roomIn(el, box) : 0;
  if (room > 0) shrink(el, room, () => el.getBoundingClientRect().width);
}

/** Fits every amount in `scope` (`fitRow`, `fitNumber`) to the room it has now. */
export function fitAmounts(scope) {
  if (!scope?.querySelectorAll || typeof globalThis.getComputedStyle !== "function") return;
  for (const row of scope.querySelectorAll("[data-fit-row]")) fitRow(row);
  for (const el of scope.querySelectorAll("[data-fit]")) fitNumber(el);
}
