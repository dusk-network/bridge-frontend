import assert from "node:assert/strict";
import test from "node:test";

import { beforeProofText, claimFrom, claimText, contractClock, proveNowText, wallTime } from "./claim-date.js";
import { formatDateTime } from "./format.js";

// The shared test vectors for when a DuskEVM withdrawal can be claimed.
//
// Testnet's deployed contracts count Dusk block height × 10. The tip, as read
// on 28 Oct 2026: block 4,704,959 at 1,793,156,989 s, so a contract time S is
// at 1,746,107,399 + S on the wall clock.
const TIP = Object.freeze({ height: 4_704_959n, timestamp: 1_793_156_989n });
// The Portal's delays and the game's clock limit, as deployed on testnet.
const TIMING = Object.freeze({ finalitySeconds: 302_400n, maturitySeconds: 604_800n, maxClockSeconds: 302_400n });
// wallet-both.dusk's 1 DUSK withdrawal: proved at block 4,687,744; its game,
// created at block 4,687,605, can resolve from block 4,717,845.
const PROVEN_AT = 46_877_440n;
const GAME = Object.freeze({ createdAt: 46_876_050n, resolvedAt: 0n, status: 0 });
const iso = (ms) => new Date(ms).toISOString().replace(".000", "");
const AMS = "Europe/Amsterdam";
const when = (ms) => formatDateTime(ms, { timeZone: AMS });

test("the worked example: claimable on Mon 2 Nov, 03:20 to 03:32 UTC", () => {
  // In progress: the earliest, the proof's maturity, as an estimate.
  const now = claimFrom({ game: GAME, provenAt: PROVEN_AT, timing: TIMING, tip: TIP });
  assert.deepEqual({ ...now, at: iso(now.at) }, { at: "2026-11-02T03:20:39Z", exact: false, overdue: false });
  // Resolved 139 blocks or less after its earliest: still the maturity.
  // At the resolver's median (161 blocks) and 90th percentile (205), later: exact.
  const resolvedAfter = (blocks) =>
    claimFrom({ game: { ...GAME, resolvedAt: GAME.createdAt + TIMING.maxClockSeconds + 10n * blocks, status: 2 }, provenAt: PROVEN_AT, timing: TIMING, tip: TIP });
  assert.deepEqual([139n, 161n, 205n].map((blocks) => iso(resolvedAfter(blocks).at)), ["2026-11-02T03:20:39Z", "2026-11-02T03:24:19Z", "2026-11-02T03:31:39Z"]);
  assert.equal(resolvedAfter(161n).exact, true);
  // As the web wallet's History said it, but now from the chain: 04:20 CET.
  assert.equal(claimText(now, when), "Claim from about Mon 2 Nov, 04:20 CET");
  assert.equal(claimText(resolvedAfter(161n), when), "Claim from Mon 2 Nov, 04:24 CET");
});

test("a resolved game: exact, the later of the proof's maturity and the game's finality", () => {
  // The 1,008 DUSK withdrawal: proved at block 4,525,232, its game resolved
  // at 4,555,501; claimable since block 4,585,741 (~14 Oct, 08:00 UTC).
  const claim = claimFrom({ game: { createdAt: 45_250_000n, resolvedAt: 45_555_010n, status: 2 }, provenAt: 45_252_320n, timing: TIMING, tip: TIP });
  assert.deepEqual({ ...claim, at: iso(claim.at) }, { at: "2026-10-14T08:00:09Z", exact: true, overdue: false });
  // Proving now against a resolved game: exactly the maturity from now.
  const proveNow = claimFrom({ game: { createdAt: 45_250_000n, resolvedAt: 45_555_010n, status: 2 }, timing: TIMING, tip: TIP });
  assert.equal(proveNow.at, Number(TIP.timestamp + TIMING.maturitySeconds) * 1_000);
  // The tip is 28 Oct, 03:09:49 UTC.
  assert.equal(proveNowText(proveNow, when), "If you prove now, you can claim from Wed 4 Nov, 04:09 CET");
});

test("an unresolved game: the earliest it can be final, as an estimate", () => {
  // Proved long after the game was created: its finality comes first.
  const late = claimFrom({ game: GAME, provenAt: 47_040_000n, timing: TIMING, tip: TIP });
  assert.equal(late.exact, false);
  assert.equal(late.at, wallTime(47_040_000n + 604_800n, "height", TIP));
  // Proved right after: createdAt + maxClockDuration + finality is later than the maturity.
  const early = claimFrom({ game: { ...GAME, createdAt: 46_877_430n }, provenAt: 46_877_440n, timing: { ...TIMING, finalitySeconds: 302_420n }, tip: TIP });
  assert.equal(early.at, wallTime(46_877_430n + 302_400n + 302_420n, "height", TIP));
  // Before proving, against the newest game: "If you prove now … about".
  const newest = claimFrom({ game: { ...GAME, createdAt: 47_048_050n }, timing: TIMING, tip: TIP });
  assert.equal(newest.exact, false);
  assert.match(proveNowText(newest, when), /^If you prove now, you can claim from about /u);
});

test("an overdue game: unresolved more than an hour past its clock, claimable at the soonest a finality from now", () => {
  const settles = GAME.createdAt + TIMING.maxClockSeconds;
  const at = (blocksPast) => {
    const height = settles / 10n + blocksPast;
    return { height, timestamp: TIP.timestamp + 10n * (height - TIP.height) };
  };
  // An hour past (360 blocks) isn't overdue yet; a block more is.
  assert.equal(claimFrom({ game: GAME, provenAt: PROVEN_AT, timing: TIMING, tip: at(360n) }).overdue, false);
  const overdue = claimFrom({ game: GAME, provenAt: PROVEN_AT, timing: TIMING, tip: at(361n) });
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.exact, false);
  // It could resolve now: final 3.5 days from now, after the maturity.
  assert.equal(overdue.at, Number(at(361n).timestamp + TIMING.finalitySeconds) * 1_000);
  assert.equal(claimText(overdue, when), "Waiting for DuskEVM to settle this proof. Claim from Mon 2 Nov, 04:57 CET at the soonest.");
});

test("a master-style deployment: block timestamps, compared strictly, so a second later", () => {
  const tip = { height: 5_600_000n, timestamp: 1_793_400_000n };
  const game = { createdAt: 1_792_990_000n, resolvedAt: 1_793_300_000n, status: 2 };
  assert.equal(contractClock(game.createdAt, tip), "timestamp");
  assert.equal(contractClock(GAME.createdAt, TIP), "height");
  const claim = claimFrom({ game, provenAt: 1_793_000_000n, timing: TIMING, tip });
  // The proof matures at 1,793,604,800, after the game's finality at 1,793,602,400: one second later.
  assert.deepEqual(claim, { at: 1_793_604_801_000, exact: true, overdue: false });
  // Resolved late: the game's finality is the later gate, a second after the delay.
  const late = claimFrom({ game: { ...game, resolvedAt: 1_793_400_000n }, provenAt: 1_793_000_000n, timing: TIMING, tip });
  assert.equal(late.at, (1_793_400_000 + 302_400 + 1) * 1_000);
  // Unresolved: an estimate, from the proof's maturity here.
  const open = claimFrom({ game: { ...game, resolvedAt: 0n, status: 0 }, provenAt: 1_793_000_000n, timing: TIMING, tip: { ...tip, timestamp: 1_793_000_100n } });
  assert.deepEqual(open, { at: (1_793_000_000 + 604_800 + 1) * 1_000, exact: false, overdue: false });
});

test("no date when the challenger won, or the hub doesn't know the game", () => {
  assert.deepEqual(claimFrom({ game: { ...GAME, status: 1 }, provenAt: PROVEN_AT, timing: TIMING, tip: TIP }), { at: null, exact: false, overdue: false });
  assert.deepEqual(claimFrom({ game: { createdAt: 0n, resolvedAt: 0n, status: 0 }, provenAt: PROVEN_AT, timing: TIMING, tip: TIP }), { at: null, exact: false, overdue: false });
  assert.equal(claimText({ at: null }, when), "");
  assert.equal(proveNowText(null, when), "");
});

test("before the proof, the wait comes from what the chain said", () => {
  assert.equal(beforeProofText({ maturity: 604_800, prove: 1_700 }), "Claim 7 days after you prove. You can prove about 30 minutes after sending.");
  assert.equal(beforeProofText({ maturity: 302_400 }), "Claim 3 days 12 hours after you prove.");
  assert.equal(beforeProofText(null), "");
});
