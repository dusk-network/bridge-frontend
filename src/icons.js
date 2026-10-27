// Stroke icons on a 24px grid, and monochrome chain marks: Dusk is its glyph
// on a round tile, DuskEVM the same with an "EVM" tag, Ethereum its two-part
// diamond and BNB Smart Chain its centre square between two chevrons. Icons
// are decoration: every control that shows one also has a text label.

const PATHS = {
  back: ['<path d="M19 12H5"/>', '<path d="M11 6l-6 6 6 6"/>'],
  bridge: ['<path d="M4 9h14"/>', '<path d="M14 5l4 4-4 4"/>', '<path d="M20 15H6"/>', '<path d="M10 11l-4 4 4 4"/>'],
  calendar: ['<rect x="4" y="5.5" width="16" height="14.5" rx="2"/>', '<path d="M4 10h16"/>', '<path d="M8.5 3.5v4"/>', '<path d="M15.5 3.5v4"/>'],
  check: ['<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
  "chev-d": ['<path d="M6 9.5l6 6 6-6"/>'],
  "chev-r": ['<path d="M9.5 6l6 6-6 6"/>'],
  "arrow-r": ['<path d="M5 12h14"/>', '<path d="M13 6l6 6-6 6"/>'],
  close: ['<path d="M6 6l12 12"/>', '<path d="M18 6L6 18"/>'],
  copy: ['<rect x="9" y="9" width="11" height="11" rx="2"/>', '<path d="M9 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3"/>'],
  doc: ['<path d="M7 3.5h7l4.5 4.5v11.5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 7 3.5Z"/>', '<path d="M14 3.5V8h4.5"/>', '<path d="M9 13h6"/>', '<path d="M9 16.5h6"/>'],
  ext: ['<path d="M8 6h10v10"/>', '<path d="M18 6 6 18"/>'],
  eye: ['<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5-9.5-6.5-9.5-6.5Z"/>', '<circle cx="12" cy="12" r="3"/>'],
  info: ['<circle cx="12" cy="12" r="9"/>', '<path d="M12 11.5v5"/>', '<path d="M12 8h.01"/>'],
  laptop: ['<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/>', '<path d="M2.5 19h19"/>'],
  link: ['<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/>', '<path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'],
  lock: ['<rect x="5" y="10.5" width="14" height="9.5" rx="2"/>', '<path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'],
  menu: ['<path d="M4 7h16"/>', '<path d="M4 12h16"/>', '<path d="M4 17h16"/>'],
  person: ['<circle cx="12" cy="8.5" r="3.5"/>', '<path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'],
  phone: ['<rect x="7" y="3" width="10" height="18" rx="2"/>', '<path d="M11 17.5h2"/>'],
  search: ['<circle cx="11" cy="11" r="6.5"/>', '<path d="M16 16l4.5 4.5"/>'],
  share: ['<path d="M12 15V4"/>', '<path d="M8 7.5 12 3.5l4 4"/>', '<path d="M6 11v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8"/>'],
  wallet: ['<rect x="3.5" y="6" width="17" height="13" rx="2.5"/>', '<path d="M3.5 9.5h17"/>', '<path d="M16 14h1.5"/>', '<path d="M6 6l9-2.5 1 2.5"/>'],
};

// Filled, in the text colour: the chains' own shapes, without their colours.
const CHAIN_MARKS = {
  bsc: [
    '<path d="M12 9.4 14.6 12 12 14.6 9.4 12Z"/>',
    '<path d="M12 2.8 17.2 8l-1.6 1.6L12 6 8.4 9.6 6.8 8Z"/>',
    '<path d="M12 21.2 6.8 16l1.6-1.6L12 18l3.6-3.6 1.6 1.6Z"/>',
    '<path d="M4.4 10.4 6 12l-1.6 1.6L2.8 12Z"/>',
    '<path d="M19.6 10.4 21.2 12l-1.6 1.6L18 12Z"/>',
  ],
  ethereum: ['<path d="M12 1.8 5.4 12.6 12 16.5l6.6-3.9Z"/>', '<path opacity=".55" d="M5.4 13.9 12 22.2l6.6-8.3L12 17.8Z"/>'],
};

export const GLYPH =
  '<svg class="glyph" viewBox="0 0 1000 1000" aria-hidden="true" focusable="false"><path fill="currentColor" d="M514,0.2c-36.9-1-72.9,2-107.5,8.5C175,52.4,0,255.8,0,500s175.1,447.5,406.6,491.3c30.2,5.8,61.5,8.8,93.4,8.8c282.9,0,510.9-235,499.6-520.4C989.2,218.7,775,7.2,514,0.2z M522.6,899.4c-8.5,0.5-14-9.2-8.7-16C596.1,777.5,645.2,644.5,645.2,500s-49-277.6-131.4-383.4c-5.2-6.8,0.1-16.5,8.6-16C733,112.3,900,286.6,900,500S733.1,887.6,522.6,899.4z"/></svg>';

export const icon = (name, className = "") =>
  `<svg class="ic${className ? ` ${className}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${(PATHS[name] ?? []).join("")}</svg>`;

/** A chain's mark: "dusk", "dusk-evm", "ethereum" or "bsc". */
export function chainMark(network, size = "") {
  const inner =
    network === "dusk" || network === "dusk-evm"
      ? `${GLYPH}${network === "dusk-evm" ? '<span class="evm-tag">EVM</span>' : ""}`
      : `<svg class="mk-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${(CHAIN_MARKS[network] ?? []).join("")}</svg>`;
  return `<span class="cm${network === "dusk-evm" ? " evm" : ""}${size ? ` ${size}` : ""}" aria-hidden="true">${inner}</span>`;
}

/** A route: where from, an arrow, where to. */
export const pairMark = (from, to) =>
  `<span class="pair" aria-hidden="true">${chainMark(from)}${icon("arrow-r", "pa")}${chainMark(to)}</span>`;
