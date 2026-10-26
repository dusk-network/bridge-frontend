import { formatUnits } from "viem";

import { activityView, friendlyWalletError, html, renderActivityItem } from "./activity-view.js";
import { entryId, findActivity, normalizeTxHash, readActivity, recordActivity, updateActivity } from "./activity.js";
import { duskToLux } from "./amount.js";
import { bridgeRoutes, getBridgeRoute } from "./bridge-routes.js";
import { config } from "./config.js";
import { submitDuskEvmDeposit } from "./dusk-deposit.js";
import { createDuskConnection, ensureDuskConnected } from "./dusk-wallet.js";
import { duskEvmNetwork, submitDuskEvmWithdrawal } from "./duskevm-withdrawal.js";
import {
  connectEvmWallet,
  ensureEvmChain,
  getEvmState,
  initializeEvmWallet,
  subscribeEvmWallet,
} from "./evm-wallet.js";
import {
  approveMigration,
  assertMigrationBalance,
  migrationSnapshot,
  parseMigrationAmount,
  submitMigration,
} from "./legacy-migration.js";
import { submitServiceTransfer } from "./service-transfer.js";
import { createServices, proofSubmitterFor } from "./services.js";
import { createScheduler, takenByAnother } from "./tracking.js";
import { normalizeEvmAddress, shortAddress } from "./validation.js";
import { roughDuration } from "./withdrawal-lifecycle.js";

export { friendlyWalletError };

/** What the hash box expects for each route's source chain. */
export function sourceHashFor(route, input) {
  const hash = normalizeTxHash(input);
  if (!hash) return null;
  const evmSource = route.signer === "evm";
  if (evmSource) return hash.startsWith("0x") ? hash : `0x${hash}`;
  return hash.replace(/^0x/u, "");
}

export function createAppController(root, { services = createServices() } = {}) {
  let routeSyncPromise = null;
  let sourceChainSwitchInFlight = false;
  const model = {
    activity: readActivity(),
    amount: "",
    busy: false,
    busyEntry: null,
    confirmed: false,
    dusk: null,
    duskState: { installed: false, selectedProfile: null },
    error: "",
    evmState: getEvmState(),
    lookupHash: "",
    migration: null,
    notice: "",
    recipient: config.defaultDuskRecipient,
    recipientTouched: false,
    routeId: bridgeRoutes[0]?.id ?? "",
    success: "",
  };
  const route = () => getBridgeRoute(model.routeId);
  const duskState = () => model.dusk?.state ?? model.duskState;
  const duskAccount = () => duskState().selectedProfile?.account ?? "";

  async function checkEntry(id) {
    const entry = findActivity(id);
    const entryRoute = entry && getBridgeRoute(entry.routeId);
    // An entry from a route this deployment doesn't offer isn't followed.
    if (!entry || !entryRoute) return null;
    try {
      const patch = await services.tracking.refresh(entry, entryRoute, { others: model.activity });
      // Checks run side by side: a payout another transfer took meanwhile
      // isn't this one's. It's looked for again on the next check.
      model.activity = takenByAnother(entry, patch, readActivity())
        ? updateActivity(id, { lastCheckedAt: Date.now() })
        : updateActivity(id, { ...patch, lastCheckedAt: Date.now(), trackingError: null });
    } catch (error) {
      model.activity = updateActivity(id, {
        lastCheckedAt: Date.now(),
        trackingError: error instanceof Error ? error.message : String(error),
      });
    }
    render();
    return findActivity(id);
  }
  const scheduler = createScheduler({ check: checkEntry });

  function addEntry(entry) {
    model.activity = recordActivity(entry);
    scheduler.track(entryId(entry.routeId, entry.hash));
  }

  const destination = () => {
    const mode = route()?.mode;
    if (mode === "migration") return model.recipient.trim() || duskAccount();
    if (mode === "duskevm-withdrawal") return duskAccount();
    return model.recipient.trim() || (model.evmState.account ?? "");
  };

  const defaultRecipient = () => {
    const mode = route()?.mode;
    if (mode === "migration") return config.defaultDuskRecipient;
    if (mode === "service-transfer" || mode === "duskevm-deposit")
      return model.evmState.account ?? "";
    return "";
  };

  const evmSourceNetwork = (selected) =>
    selected.mode === "migration"
      ? config.evmNetworks[selected.from.id]
      : selected.mode === "duskevm-withdrawal"
        ? duskEvmNetwork()
        : null;

  async function ensureSelectedSourceChain() {
    const selected = route();
    if (sourceChainSwitchInFlight || !selected) return;
    sourceChainSwitchInFlight = true;
    try {
      if (selected.signer === "evm") {
        const network = evmSourceNetwork(selected);
        if (
          network &&
          model.evmState.account &&
          model.evmState.provider &&
          model.evmState.chainId !== network.chainId
        )
          await ensureEvmChain(network);
      } else if (duskAccount() && duskState().chainId !== config.dusk.chainId) {
        await ensureDuskConnected(config.dusk.chainId);
      }
    } finally {
      sourceChainSwitchInFlight = false;
    }
  }

  async function synchronizeSelectedRoute() {
    const routeId = model.routeId;
    if (routeSyncPromise) {
      await routeSyncPromise;
      if (model.routeId !== routeId) return synchronizeSelectedRoute();
      return;
    }
    routeSyncPromise = (async () => {
      await ensureSelectedSourceChain();
      const selected = route();
      if (selected?.id === routeId && selected.mode === "migration" && model.evmState.account)
        model.migration = await migrationSnapshot(config.evmNetworks[selected.from.id]);
    })();
    try {
      await routeSyncPromise;
    } finally {
      routeSyncPromise = null;
    }
    if (model.routeId !== routeId) await synchronizeSelectedRoute();
  }

  function resetForm() {
    Object.assign(model, {
      amount: "",
      confirmed: false,
      error: "",
      lookupHash: "",
      migration: null,
      notice: "",
      recipient: defaultRecipient(),
      recipientTouched: false,
      success: "",
    });
  }

  async function act(fn, wallet = "dusk") {
    Object.assign(model, { busy: true, error: "", notice: "", success: "" });
    render();
    try {
      await fn();
    } catch (error) {
      model.error = friendlyWalletError(error, wallet);
    } finally {
      model.busy = false;
      render();
    }
  }

  const requireConfirmation = () => {
    if (!model.confirmed)
      throw new Error("Confirm that you checked the route, amount, and destination.");
  };

  async function headBlock(network) {
    try {
      return BigInt(await services.rpc(network, "eth_blockNumber", [])).toString();
    } catch {
      return undefined;
    }
  }

  async function submit() {
    const selected = route();
    await act(async () => {
      requireConfirmation();
      const recipient = destination();
      const amountLux = duskToLux(model.amount);
      if (selected.mode === "service-transfer") {
        const scanFrom = await headBlock(selected.to.id);
        const { hash, to } = await submitServiceTransfer({ amountLux, destination: recipient });
        addEntry({ amountLux: amountLux.toString(), destination: to, hash, routeId: selected.id, scanFrom });
      } else if (selected.mode === "duskevm-deposit") {
        const to = normalizeEvmAddress(recipient);
        const scanFrom = await headBlock("dusk-evm");
        const { hash } = await submitDuskEvmDeposit({
          amountLux,
          node: services.node,
          recipient: to,
        });
        addEntry({ amountLux: amountLux.toString(), destination: to, hash, routeId: selected.id, scanFrom });
      } else if (selected.mode === "duskevm-withdrawal") {
        const result = await submitDuskEvmWithdrawal({ amount: model.amount });
        addEntry({
          amountLux: amountLux.toString(),
          destination: result.duskAccount,
          hash: result.hash,
          proofSubmitter: proofSubmitterFor(result.duskAccount),
          routeId: selected.id,
          stage: "submitted",
        });
      } else throw new Error("Use the approve and migrate actions for this route.");
      model.success = "Sent. Follow it under Recent activity.";
      model.confirmed = false;
    }, selected.signer);
  }

  async function approve() {
    await act(async () => {
      requireConfirmation();
      const network = config.evmNetworks[route().from.id];
      model.migration = await migrationSnapshot(network);
      assertMigrationBalance(model.migration.balance, model.amount);
      await approveMigration(network, model.amount);
      model.migration = await migrationSnapshot(network);
      model.success = "Approval confirmed. You can migrate now.";
    }, "evm");
  }

  async function migrate() {
    await act(async () => {
      requireConfirmation();
      const selected = route();
      const network = config.evmNetworks[selected.from.id];
      const amount = parseMigrationAmount(model.amount);
      model.migration = await migrationSnapshot(network);
      assertMigrationBalance(model.migration.balance, model.amount);
      if (!model.migration || model.migration.allowance < amount)
        throw new Error("Approve this amount first.");
      const recipient = destination();
      const hash = await submitMigration(network, model.amount, recipient);
      addEntry({
        amountLux: (amount / 1_000_000_000n).toString(),
        destination: recipient,
        hash,
        routeId: selected.id,
      });
      model.success = "Sent. Follow it under Recent activity.";
      model.confirmed = false;
    }, "evm");
  }

  async function lookup() {
    await act(async () => {
      const selected = route();
      const hash = sourceHashFor(selected, model.lookupHash);
      if (!hash) throw new Error("Enter a valid transaction hash.");
      addEntry({ hash, routeId: selected.id });
      model.lookupHash = "";
      model.notice = "Added to Recent activity.";
    });
  }

  async function withdrawalAction(id, kind) {
    const entry = findActivity(id);
    if (!entry || !services.withdrawals) return;
    model.busyEntry = id;
    await act(async () => {
      await ensureDuskConnected(config.dusk.chainId);
      try {
        const hash =
          kind === "prove"
            ? await services.withdrawals.proveWithdrawal(entry.hash)
            : await services.withdrawals.finalizeWithdrawal(entry.hash);
        model.activity = updateActivity(id, {
          actionError: null,
          pendingAction: kind,
          pendingHash: hash,
          proofSubmitter: proofSubmitterFor(duskAccount()),
          stage: kind === "prove" ? "prove_submitted" : "finalize_submitted",
        });
        scheduler.track(id);
      } catch (error) {
        model.activity = updateActivity(id, { actionError: error?.message ?? String(error) });
        throw error;
      }
    });
    model.busyEntry = null;
    render();
  }

  const routeOptions = () =>
    bridgeRoutes
      .map(
        (item) =>
          `<option value="${item.id}" ${item.id === model.routeId ? "selected" : ""}>${html(item.from.label)} → ${html(item.to.label)}</option>`,
      )
      .join("");

  const activityMarkup = () =>
    !model.activity.length
      ? '<p class="empty">No recent activity.</p>'
      : `<ol class="activity-list">${model.activity
          .map((item) =>
            renderActivityItem(
              item,
              activityView(item, { cfg: config, route: getBridgeRoute(item.routeId) }),
              { busy: model.busy && model.busyEntry === item.id },
            ),
          )
          .join("")}</ol>`;

  function routeFields(selected) {
    const connectedEvm = model.evmState.account ?? "";
    if (selected.mode === "migration")
      return `<label>Dusk recipient<input name="recipient" autocomplete="off" placeholder="Dusk account" value="${html(model.recipient)}"></label><div class="balance-row"><span>Balance</span><strong>${model.migration ? html(`${formatUnits(model.migration.balance, 18)} DUSK`) : "—"}</strong><button type="button" class="text-button" data-action="load-migration">Refresh</button></div><p class="hint">Approval is required before migration.</p>`;
    if (selected.mode === "service-transfer")
      return `<label>Destination address<input name="recipient" autocomplete="off" placeholder="${html(connectedEvm || "0x…")}" value="${html(model.recipient)}"></label><p class="hint warning">${html(formatUnits(config.service.feeLux, 9))} DUSK fee · usually completes within ${html(roughDuration(config.service.delaySeconds))}.</p>`;
    if (selected.mode === "duskevm-deposit")
      return `<label>Destination address<input name="recipient" autocomplete="off" placeholder="${html(connectedEvm || "0x…")}" value="${html(model.recipient)}"></label>`;
    return `<p class="hint warning">Withdrawals must later be proven and finalized on Dusk.</p>`;
  }

  function actionMarkup(selected) {
    const signer = selected.signer === "dusk" ? duskAccount() : model.evmState.account;
    const disabled = model.busy || !model.confirmed || !model.amount || !signer || !destination();
    if (selected.mode !== "migration")
      return `<button type="button" class="submit" data-action="submit" ${disabled ? "disabled" : ""}>${model.busy && !model.busyEntry ? "Waiting for wallet…" : "Submit"}</button>`;
    let approved = false;
    try {
      approved = Boolean(model.migration && model.migration.allowance >= parseMigrationAmount(model.amount));
    } catch {}
    return `<div class="actions"><button type="button" data-action="approve" ${disabled || approved ? "disabled" : ""}>${approved ? "Approved" : "1. Approve"}</button><button type="button" data-action="migrate" ${disabled || !approved || !destination() ? "disabled" : ""}>2. Migrate</button></div>`;
  }

  function lookupMarkup(selected) {
    const placeholder = selected.signer === "evm" ? "0x…" : "Dusk transaction hash";
    return `<section class="withdrawal-manager"><h3>Track a transfer</h3><label>Transaction hash<input name="lookupHash" autocomplete="off" placeholder="${placeholder}" value="${html(model.lookupHash)}"></label><div class="actions"><button type="button" class="secondary" data-action="lookup" ${model.busy || !model.lookupHash ? "disabled" : ""}>Check status</button></div></section>`;
  }

  function render() {
    const selected = route();
    const duskStatus = duskAccount()
      ? shortAddress(duskAccount())
      : duskState().installed
        ? duskState().authorized
          ? "Unlock wallet"
          : "Connect wallet"
        : "Not installed";
    const masthead = `<header class="masthead"><a class="brand" href="#"><img src="/dusk-glyph.svg" alt=""><span><strong>Dusk</strong><small>Bridge</small></span></a><div class="wallet-actions"><button type="button" class="wallet-button" data-action="connect-dusk"><small>Dusk</small>${html(duskStatus)}</button><button type="button" class="wallet-button" data-action="connect-evm"><small>EVM</small>${html(model.evmState.account ? shortAddress(model.evmState.account) : "Connect wallet")}</button></div></header>`;
    if (!selected) {
      root.innerHTML = `<div class="shell">${masthead}<main><div class="page-heading"><h1>Bridge</h1><p>No routes are configured for this network.</p></div></main></div>`;
      return;
    }
    const sourceWalletNotice =
      selected.signer === "dusk" && !duskAccount()
        ? `<p class="message notice">${duskState().installed ? "Unlock and reconnect the Dusk wallet to continue." : "Install the Dusk wallet extension to continue."}</p>`
        : selected.signer === "evm" && !model.evmState.account
          ? '<p class="message notice">Connect an EVM wallet to continue.</p>'
          : "";
    root.innerHTML = `<div class="shell">${masthead}
      <main><div class="page-heading"><h1>Bridge</h1><p>Move DUSK between networks.</p></div><section class="bridge-card" aria-labelledby="bridge-title"><h2 id="bridge-title">Transfer</h2><label>Route<span class="select-wrap"><select name="route">${routeOptions()}</select></span></label><div class="network-strip"><div><small>From</small><strong>${html(selected.from.label)}</strong></div><span aria-hidden="true">→</span><div><small>To</small><strong>${html(selected.to.label)}</strong></div></div>${sourceWalletNotice}<label>Amount<span class="input-wrap"><input name="amount" inputmode="decimal" placeholder="0.0" value="${html(model.amount)}"><b>DUSK</b></span></label>${routeFields(selected)}<div class="review"><dl><div><dt>Wallet</dt><dd>${html(selected.signer === "dusk" ? shortAddress(duskAccount()) : shortAddress(model.evmState.account))}</dd></div><div><dt>Recipient</dt><dd data-review-recipient>${html(destination() || "—")}</dd></div></dl><label class="confirm"><input type="checkbox" name="confirmed" ${model.confirmed ? "checked" : ""}>I checked the amount and recipient.</label></div>${model.error ? `<p class="message error" role="alert">${html(model.error)}</p>` : ""}${model.success ? `<p class="message success" role="status">${html(model.success)}</p>` : ""}${actionMarkup(selected)}${lookupMarkup(selected)}${model.notice ? `<p class="hint">${html(model.notice)}</p>` : ""}</section><section class="activity"><div class="section-heading"><h2>Recent activity</h2><span>Stored on this device</span></div>${activityMarkup()}</section></main><footer><a href="https://docs.dusk.network/learn/guides/" target="_blank" rel="noreferrer">Bridge guide</a></footer></div>`;
  }

  root.addEventListener("input", (event) => {
    const { name } = event.target;
    if (name === "amount" || name === "recipient") {
      if (name === "amount") model.amount = event.target.value;
      else {
        model.recipient = event.target.value;
        model.recipientTouched = true;
      }
      Object.assign(model, { confirmed: false, error: "", notice: "", success: "" });
      // Update in place: a re-render here would swap the element the user is
      // about to click (the checkbox, a button) and the click would be lost.
      const checkbox = root.querySelector('input[name="confirmed"]');
      if (checkbox) checkbox.checked = false;
      for (const message of root.querySelectorAll(".message.error, .message.success")) message.remove();
      for (const button of root.querySelectorAll('[data-action="submit"], [data-action="approve"], [data-action="migrate"]'))
        button.disabled = true;
      const recipient = root.querySelector("[data-review-recipient]");
      if (recipient) recipient.textContent = destination() || "—";
    }
    if (name === "lookupHash") {
      model.lookupHash = event.target.value;
      const button = root.querySelector('[data-action="lookup"]');
      if (button) button.disabled = model.busy || !model.lookupHash;
    }
    if (name === "confirmed") model.confirmed = event.target.checked;
  });
  root.addEventListener("change", (event) => {
    // Text fields are already in the model (see "input"); re-rendering on
    // their change, which fires as focus moves to a button, loses the click.
    if (event.target.name === "route") {
      model.routeId = event.target.value;
      resetForm();
      void act(synchronizeSelectedRoute, route()?.signer);
      render();
    } else if (event.target.name === "confirmed") render();
  });
  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    const action = target?.dataset.action;
    if (!action) return;
    ({
      approve,
      "connect-dusk": () =>
        act(async () => {
          await model.dusk.connect();
          await synchronizeSelectedRoute();
        }),
      "connect-evm": () =>
        act(async () => {
          model.evmState = await connectEvmWallet();
          await synchronizeSelectedRoute();
        }, "evm"),
      "load-migration": () =>
        act(async () => {
          model.migration = await migrationSnapshot(config.evmNetworks[route().from.id]);
        }, "evm"),
      lookup,
      migrate,
      submit,
      "withdrawal-finalize": () => withdrawalAction(target.dataset.id, "finalize"),
      "withdrawal-prove": () => withdrawalAction(target.dataset.id, "prove"),
    })[action]?.();
  });

  return {
    async start() {
      render();
      for (const entry of model.activity)
        if (entry.status === "pending" || !entry.status) scheduler.track(entry.id);
      const [dusk] = await Promise.all([createDuskConnection(), initializeEvmWallet()]);
      model.dusk = dusk;
      dusk.subscribe((state) => {
        const previousAccount = model.duskState.selectedProfile?.account ?? null;
        if (state.selectedProfile?.account !== previousAccount) {
          model.confirmed = false;
          model.success = "";
          if (state.selectedProfile?.account) model.error = "";
          // Whose proof counts depends on the account: look again.
          for (const entry of model.activity)
            if (entry.status === "pending" && getBridgeRoute(entry.routeId)?.mode === "duskevm-withdrawal")
              scheduler.track(entry.id);
        }
        model.duskState = state;
        render();
      });
      subscribeEvmWallet((state) => {
        const previousAccount = model.evmState.account;
        const accountChanged = state.account !== previousAccount;
        const shouldSwitch =
          Boolean(state.account && state.provider) &&
          (state.account !== model.evmState.account || state.chainId !== model.evmState.chainId);
        if (accountChanged) {
          const mode = route()?.mode;
          if (
            (mode === "service-transfer" || mode === "duskevm-deposit") &&
            (!model.recipientTouched || model.recipient === previousAccount)
          ) {
            model.recipient = state.account ?? "";
            model.recipientTouched = false;
          }
          model.migration = null;
          model.confirmed = false;
          model.success = "";
        }
        model.evmState = state;
        render();
        if (accountChanged && state.account) void act(synchronizeSelectedRoute, "evm");
        else if (shouldSwitch) void act(ensureSelectedSourceChain, "evm");
      });
      const refreshDuskState = () => {
        if (globalThis.document?.visibilityState === "hidden") return;
        void dusk.wallet.refresh().catch(() => {});
      };
      globalThis.addEventListener?.("focus", refreshDuskState);
      globalThis.document?.addEventListener("visibilitychange", refreshDuskState);
      render();
    },
  };
}
