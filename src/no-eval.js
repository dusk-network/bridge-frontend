// The page runs no code it makes from text: its Content-Security-Policy has
// no 'unsafe-eval' (scripts/csp.js). Zod, which AppKit checks its wallet
// frame's messages with, tests whether it may by making a function as it
// builds its schemas: the policy refuses that, and the browser reports a
// violation, though zod carries on without. Told it's jitless before it
// loads, through the config every copy of zod shares, it doesn't test.
// main.js imports this first, before anything that loads zod.
(globalThis.__zod_globalConfig ??= {}).jitless = true;
