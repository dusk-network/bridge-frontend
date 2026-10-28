import assert from "node:assert/strict";
import test from "node:test";

import {
  DUSK_ACCOUNT_CHANGED,
  buildContractCallRequest,
  buildTransferRequest,
  isRecoverableDuskSessionError,
  sendDuskTransfer,
  useDuskWallet,
} from "./dusk-wallet.js";

test("native bridge value is attached as a contract deposit, with the call's gas", () => {
  const request = buildContractCallRequest({
    contractId: "11".repeat(32),
    depositLux: 42n,
    display: { label: "Bridge" },
    fnArgs: new Uint8Array([1, 255]),
    fnName: "depositETHToWithValue",
    gas: { limit: 5_000_000n, price: 1n },
  });
  assert.equal(request.deposit, "42");
  assert.equal(request.fnArgs, "0x01ff");
  assert.equal(request.contractId, `0x${"11".repeat(32)}`);
  assert.deepEqual(request.gas, { limit: "5000000", price: "1" });
  assert.equal("amount" in request, false);
  assert.equal("chainId" in request, false);
});

test("a transfer is public and carries its memo", () => {
  assert.deepEqual(buildTransferRequest({ amountLux: 5n, memo: "0xabc", to: "acct" }), {
    amount: "5",
    memo: "0xabc",
    privacy: "public",
    to: "acct",
  });
});

test("only a refused locked-session request is safe to retry", () => {
  assert.equal(isRecoverableDuskSessionError({ code: 4100 }), true);
  assert.equal(isRecoverableDuskSessionError({ code: 4900 }), false);
  assert.equal(isRecoverableDuskSessionError({ code: 4001 }), false);
  assert.equal(isRecoverableDuskSessionError(new Error("failed")), false);
});

test("a locked session's retry goes only to the account the request was made for", async () => {
  const wallet = (afterReconnect, authorized = true) => {
    const sent = [];
    let locked = authorized;
    const fake = {
      state: { authorized, chainId: "dusk:2", selectedProfile: authorized ? { account: "A" } : null },
      refresh: async () => {},
      switchChain: async () => {},
      connect: async () => {
        fake.state = { ...fake.state, authorized: true, selectedProfile: { account: afterReconnect } };
      },
      sendTransfer: async (request) => {
        sent.push(fake.state.selectedProfile.account);
        if (locked) {
          locked = false;
          throw Object.assign(new Error("locked"), { code: 4100 });
        }
        return { hash: "h" };
      },
    };
    useDuskWallet(fake);
    return sent;
  };
  const request = { amountLux: 1n, memo: "m", to: "B" };
  const same = wallet("A");
  assert.deepEqual(await sendDuskTransfer(request), { hash: "h" });
  assert.deepEqual(same, ["A", "A"]);
  // The reconnect came back as another profile: nothing is sent as it.
  const switched = wallet("B");
  await assert.rejects(sendDuskTransfer(request), { code: "DUSK_ACCOUNT_CHANGED", message: DUSK_ACCOUNT_CHANGED });
  assert.deepEqual(switched, ["A"]);
  // Reviewed for A, but the wallet had lapsed and connects as B: not sent.
  const lapsed = wallet("B", false);
  await assert.rejects(sendDuskTransfer(request, { account: "A" }), { code: "DUSK_ACCOUNT_CHANGED" });
  assert.deepEqual(lapsed, []);
  const kept = wallet("A");
  assert.deepEqual(await sendDuskTransfer(request, { account: "A" }), { hash: "h" });
  assert.deepEqual(kept, ["A", "A"]);
});
