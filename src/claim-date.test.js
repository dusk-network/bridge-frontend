import assert from "node:assert/strict";
import test from "node:test";

import { beforeProofText, claimText, proveNowText } from "./claim-date.js";
import { formatDateTime } from "./format.js";

// What the pages say about a claim date. The dates are worked out by
// @dusk-network/networks/duskevm, whose tests hold the shared vectors; these
// are its worked examples' dates.
const AMS = "Europe/Amsterdam";
// On a 24-hour clock, as of the examples' day (28 Oct 2026): a later day reads "2 Nov, 04:20 CET".
const when = (ms) => formatDateTime(ms, { locale: "en-GB", now: Date.UTC(2026, 9, 28), timeZone: AMS });

test("after the proof: the date, about until its game resolves, at the soonest once that's late", () => {
  // wallet-both.dusk's 1 DUSK withdrawal, its game in progress, then resolved.
  assert.equal(claimText({ at: Date.UTC(2026, 10, 2, 3, 20, 39), exact: false, overdue: false }, when), "Claim from about 2 Nov, 04:20 CET");
  assert.equal(claimText({ at: Date.UTC(2026, 10, 2, 3, 24, 19), exact: true, overdue: false }, when), "Claim from 2 Nov, 04:24 CET");
  // Its game more than an hour late to resolve: final at the soonest a finality from now.
  assert.equal(
    claimText({ at: Date.UTC(2026, 10, 2, 3, 57, 39), exact: false, overdue: true }, when),
    "Waiting for DuskEVM to settle this proof. Claim from 2 Nov, 04:57 CET at the soonest.",
  );
  assert.equal(claimText({ at: null }, when), "");
});

test("on the prove review: when a proof made now can be claimed", () => {
  // Against a resolved game, exactly the maturity from the tip (28 Oct, 03:09:49 UTC).
  const proveNow = { at: Date.UTC(2026, 10, 4, 3, 9, 49), exact: true, overdue: false };
  assert.equal(proveNowText(proveNow, when), "If you prove now, you can claim from 4 Nov, 04:09 CET");
  // Against the newest game, not resolved yet: the earliest.
  assert.match(proveNowText({ ...proveNow, exact: false }, when), /^If you prove now, you can claim from about /u);
  assert.equal(proveNowText(null, when), "");
});

test("before the proof, the wait comes from what the chain said", () => {
  assert.equal(beforeProofText({ maturity: 604_800, prove: 1_700 }), "Claim 7 days after you prove. You can prove about 30 minutes after sending.");
  assert.equal(beforeProofText({ maturity: 302_400 }), "Claim 3 days 12 hours after you prove.");
  assert.equal(beforeProofText(null), "");
});
