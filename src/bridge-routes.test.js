import assert from "node:assert/strict";
import test from "node:test";

import { bridgeRoutes, getBridgeRoute } from "./bridge-routes.js";

test("the supported routes are unique and cross a Dusk/EVM boundary", () => {
  assert.equal(new Set(bridgeRoutes.map(({ id }) => id)).size, 5);

  for (const route of bridgeRoutes) {
    assert.notEqual(route.from.id, route.to.id);
    assert.notEqual(route.from.kind, route.to.kind);
  }
});

test("each route delegates signing to its source wallet", () => {
  for (const route of bridgeRoutes) {
    assert.equal(route.signer, route.from.kind);
  }
});

test("routes can be selected by their stable identifier", () => {
  assert.equal(getBridgeRoute("dusk-to-bsc")?.to.id, "bsc");
  assert.equal(getBridgeRoute("unsupported"), undefined);
});

