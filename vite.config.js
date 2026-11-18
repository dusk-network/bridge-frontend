import { defineConfig } from "vite";

import { contentSecurityPolicy } from "./scripts/csp.js";

// The built page carries its Content-Security-Policy, for the settings it's
// built with (scripts/csp.js), wherever it's served.
export default defineConfig({
  plugins: [contentSecurityPolicy()],
});
