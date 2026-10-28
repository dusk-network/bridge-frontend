import assert from "node:assert/strict";
import test from "node:test";

import { createLookupFlow } from "./lookup-flow.js";

test("only the latest lookup counts, and only while its page is open", async () => {
  const answers = new Map();
  let open = true;
  const flow = createLookupFlow({
    isOpen: () => open,
    resolve: (hash) => new Promise((resolve) => answers.set(hash, resolve)),
  });
  // A newer lookup overtakes an older one, whichever answers first.
  const first = flow.find("a");
  const second = flow.find("b");
  answers.get("b")({ hash: "b", routeId: "dusk-to-dusk-evm" });
  answers.get("a")({ hash: "a", routeId: "dusk-to-dusk-evm" });
  assert.deepEqual(await first, { stale: true });
  assert.deepEqual(await second, { found: { hash: "b", routeId: "dusk-to-dusk-evm" } });

  // Leaving the page drops the answer, and so does opening it again.
  const left = flow.find("c");
  open = false;
  answers.get("c")({ hash: "c", routeId: "dusk-to-dusk-evm" });
  assert.deepEqual(await left, { stale: true });
  open = true;
  const reopened = flow.find("d");
  flow.cancel();
  answers.get("d")(null);
  assert.deepEqual(await reopened, { stale: true });
});
