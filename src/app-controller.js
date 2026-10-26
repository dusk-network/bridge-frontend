import { formatUnits } from "viem";
import { readActivity, recordActivity, updateActivity } from "./activity.js";
import { duskToLux, duskToWei } from "./amount.js";
import { bridgeRoutes, getBridgeRoute } from "./bridge-routes.js";
import { config } from "./config.js";
import { submitDuskEvmDeposit } from "./dusk-deposit.js";
import {
  createDuskConnection,
  ensureDuskConnected,
  sendDuskTransfer,
} from "./dusk-wallet.js";
import { submitDuskEvmWithdrawal } from "./duskevm-withdrawal.js";
import {
  connectEvmWallet,
  ensureEvmChain,
  getEvmState,
  initializeEvmWallet,
  subscribeEvmWallet,
} from "./evm-wallet.js";
import {
  assertMigrationBalance,
  approveMigration,
  migrationSnapshot,
  parseMigrationAmount,
  submitMigration,
} from "./legacy-migration.js";
import { normalizeEvmAddress, shortAddress } from "./validation.js";
import {
  finalizeWithdrawal,
  loadWithdrawalStatus,
  proveWithdrawal,
} from "./withdrawal-finalization.js";

const html = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export function friendlyWalletError(error) {
  if (
    error?.code === 4100 ||
    /wallet (?:is )?locked/iu.test(error?.message ?? "")
  )
    return "The Dusk wallet is locked. Unlock it, reconnect, and try again.";
  if (error?.code === 4900)
    return "The Dusk wallet disconnected. Reconnect it and try again.";
  if (error?.code === 4001)
    return "The wallet request was cancelled.";
  return (
    error?.shortMessage ??
    (error instanceof Error ? error.message : String(error))
  );
}

export function createAppController(root) {
  let routeSyncPromise = null;
  let sourceChainSwitchInFlight = false;
  const model = {
    activity: readActivity(),
    amount: "",
    busy: false,
    confirmed: false,
    dusk: null,
    duskState: { installed: false, selectedProfile: null },
    error: "",
    evmState: getEvmState(),
    migration: null,
    recipient: config.legacy.defaultDuskRecipient,
    recipientTouched: false,
    routeId: bridgeRoutes[0].id,
    success: "",
    withdrawalHash: "",
    withdrawalStatus: null,
  };
  const route = () => getBridgeRoute(model.routeId);
  const duskState = () => model.dusk?.state ?? model.duskState;
  const duskAccount = () => duskState().selectedProfile?.account ?? "";
  const destination = () =>
    route().mode === "migration"
      ? model.recipient.trim() || duskAccount()
      : route().mode === "duskevm-withdrawal"
        ? duskAccount()
        : model.recipient.trim() ||
          (route().mode === "service-transfer" ||
          route().mode === "duskevm-deposit"
            ? (model.evmState.account ?? "")
            : "");

  const defaultRecipient = () => {
    const mode = route().mode;
    if (mode === "migration") return config.legacy.defaultDuskRecipient;
    if (mode === "service-transfer" || mode === "duskevm-deposit")
      return model.evmState.account ?? "";
    return "";
  };

  const evmSourceNetwork = (selected) =>
    selected.mode === "migration"
      ? config.legacy.migrations[selected.from.id]
      : selected.mode === "duskevm-withdrawal"
        ? config.duskEvm
        : null;

  async function ensureSelectedSourceChain() {
    if (sourceChainSwitchInFlight) return;
    const selected = route();
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
      } else if (duskAccount()) {
        const chainId =
          selected.mode === "service-transfer"
            ? config.legacy.duskChainId
            : config.duskEvm.l1ChainId;
        if (duskState().chainId !== chainId)
          await ensureDuskConnected(chainId);
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
      if (
        selected.id === routeId &&
        selected.mode === "migration" &&
        model.evmState.account
      )
        model.migration = await migrationSnapshot(
          config.legacy.migrations[selected.from.id],
        );
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
      migration: null,
      recipient: defaultRecipient(),
      recipientTouched: false,
      success: "",
      withdrawalStatus: null,
    });
  }
  async function act(fn) {
    Object.assign(model, { busy: true, error: "", success: "" });
    render();
    try {
      await fn();
    } catch (error) {
      model.error = friendlyWalletError(error);
    } finally {
      model.busy = false;
      render();
    }
  }
  const requireConfirmation = () => {
    if (!model.confirmed)
      throw new Error(
        "Confirm that you checked the route, amount, and destination.",
      );
  };

  async function submit() {
    await act(async () => {
      requireConfirmation();
      const selected = route();
      const recipient = destination();
      let hash;
      let status = "submitted";
      if (selected.mode === "service-transfer") {
        const amountLux = duskToLux(model.amount);
        if (amountLux <= config.legacy.serviceBridgeFeeLux)
          throw new Error("The amount must exceed the 1 DUSK bridge fee.");
        ({ hash } = await sendDuskTransfer({
          amountLux,
          chainId: config.legacy.duskChainId,
          memo: normalizeEvmAddress(recipient),
          to: config.legacy.serviceBridgeAccount,
        }));
      } else if (selected.mode === "duskevm-deposit") {
        ({ hash } = await submitDuskEvmDeposit({
          amountLux: duskToLux(model.amount),
          recipient: normalizeEvmAddress(recipient),
        }));
      } else if (selected.mode === "duskevm-withdrawal") {
        const result = await submitDuskEvmWithdrawal({
          amountWei: duskToWei(model.amount),
        });
        hash = result.hash;
        status =
          result.receipt.status === "success" ? "waiting_for_output" : "failed";
        model.withdrawalHash = hash;
      } else
        throw new Error("Use the approve and migrate actions for this route.");
      model.activity = recordActivity({
        amount: model.amount,
        destination: recipient,
        id: hash,
        routeId: selected.id,
        status,
        transactionHash: hash,
      });
      model.success = `Transaction submitted: ${hash}`;
      model.confirmed = false;
    });
  }

  async function approve() {
    await act(async () => {
      requireConfirmation();
      const network = config.legacy.migrations[route().from.id];
      model.migration = await migrationSnapshot(network);
      assertMigrationBalance(model.migration.balance, model.amount);
      const hash = await approveMigration(network, model.amount);
      model.migration = await migrationSnapshot(network);
      model.success = `Approval confirmed: ${hash}`;
    });
  }
  async function migrate() {
    await act(async () => {
      requireConfirmation();
      const selected = route();
      const network = config.legacy.migrations[selected.from.id];
      const amount = parseMigrationAmount(model.amount);
      model.migration = await migrationSnapshot(network);
      assertMigrationBalance(model.migration.balance, model.amount);
      if (!model.migration || model.migration.allowance < amount)
        throw new Error("Approve this amount first.");
      const recipient = destination();
      const hash = await submitMigration(network, model.amount, recipient);
      model.activity = recordActivity({
        amount: model.amount,
        destination: recipient,
        id: hash,
        routeId: selected.id,
        status: "submitted",
        transactionHash: hash,
      });
      model.success = `Migration submitted: ${hash}`;
      model.confirmed = false;
    });
  }

  async function checkWithdrawal() {
    await act(async () => {
      model.withdrawalStatus = await loadWithdrawalStatus(
        model.withdrawalHash.trim(),
      );
      const stored = model.activity.find(
        (item) =>
          item.transactionHash?.toLowerCase() ===
          model.withdrawalHash.trim().toLowerCase(),
      );
      if (stored)
        model.activity = updateActivity(stored.id, {
          status: model.withdrawalStatus.stage,
        });
    });
  }

  async function proveSelectedWithdrawal() {
    await act(async () => {
      const hash = await proveWithdrawal(model.withdrawalHash.trim());
      model.success = `Withdrawal proof submitted on Dusk: ${hash}`;
      model.withdrawalStatus = {
        ...model.withdrawalStatus,
        stage: "prove_submitted",
      };
    });
  }

  async function finalizeSelectedWithdrawal() {
    await act(async () => {
      const hash = await finalizeWithdrawal(model.withdrawalHash.trim());
      model.success = `Withdrawal finalization submitted on Dusk: ${hash}`;
      model.withdrawalStatus = {
        ...model.withdrawalStatus,
        stage: "finalize_submitted",
      };
    });
  }

  const routeOptions = () =>
    bridgeRoutes
      .map(
        (item) =>
          `<option value="${item.id}" ${item.id === model.routeId ? "selected" : ""}>${item.from.label} → ${item.to.label}</option>`,
      )
      .join("");
  const activityMarkup = () =>
    !model.activity.length
      ? '<p class="empty">No recent activity.</p>'
      : `<ol class="activity-list">${model.activity
          .map((item) => {
            const itemRoute = getBridgeRoute(item.routeId);
            return `<li><div><strong>${html(itemRoute?.from.label)} → ${html(itemRoute?.to.label)}</strong><span>${html(item.amount)} DUSK · ${html(item.status)}</span></div><code>${html(shortAddress(item.transactionHash, 10, 8))}</code></li>`;
          })
          .join("")}</ol>`;

  function routeFields(selected) {
    const connectedEvm = model.evmState.account ?? "";
    if (selected.mode === "migration")
      return `<label>Dusk recipient<input name="recipient" autocomplete="off" placeholder="Dusk account" value="${html(model.recipient)}"></label><div class="balance-row"><span>Balance</span><strong>${model.migration ? html(`${formatUnits(model.migration.balance, 18)} DUSK`) : "—"}</strong><button type="button" class="text-button" data-action="load-migration">Refresh</button></div><p class="hint">Approval is required before migration.</p>`;
    if (selected.mode === "service-transfer")
      return `<label>Destination address<input name="recipient" autocomplete="off" placeholder="${html(connectedEvm || "0x…")}" value="${html(model.recipient)}"></label><p class="hint warning">1 DUSK fee · usually completes within one hour.</p>`;
    if (selected.mode === "duskevm-deposit")
      return `<label>Destination address<input name="recipient" autocomplete="off" placeholder="${html(connectedEvm || "0x…")}" value="${html(model.recipient)}"></label>`;
    return `<p class="hint warning">Withdrawals must later be proven and finalized on Dusk.</p>`;
  }

  function actionMarkup(selected) {
    const signer =
      selected.signer === "dusk"
        ? duskAccount()
        : model.evmState.account;
    const disabled =
      model.busy ||
      !model.confirmed ||
      !model.amount ||
      !signer ||
      !destination();
    if (selected.mode !== "migration")
      return `<button type="button" class="submit" data-action="submit" ${disabled ? "disabled" : ""}>${model.busy ? "Waiting for wallet…" : "Submit"}</button>`;
    let approved = false;
    try {
      approved = Boolean(
        model.migration &&
          model.migration.allowance >= parseMigrationAmount(model.amount),
      );
    } catch {}
    return `<div class="actions"><button type="button" data-action="approve" ${disabled || approved ? "disabled" : ""}>${approved ? "Approved" : "1. Approve"}</button><button type="button" data-action="migrate" ${disabled || !approved || !destination() ? "disabled" : ""}>2. Migrate</button></div>`;
  }

  function withdrawalManager(selected) {
    if (selected.mode !== "duskevm-withdrawal") return "";
    const stage = model.withdrawalStatus?.stage;
    return `<section class="withdrawal-manager"><h3>Resume withdrawal</h3><label>Transaction hash<input name="withdrawalHash" autocomplete="off" placeholder="0x…" value="${html(model.withdrawalHash)}"></label><div class="actions"><button type="button" class="secondary" data-action="check-withdrawal" ${model.busy || !model.withdrawalHash ? "disabled" : ""}>Check status</button>${stage === "ready_to_prove" ? '<button type="button" data-action="prove-withdrawal">Prove on Dusk</button>' : ""}${stage === "ready_to_finalize" ? '<button type="button" data-action="finalize-withdrawal">Finalize on Dusk</button>' : ""}</div>${stage ? `<p class="hint"><strong>${html(stage.replaceAll("_", " "))}</strong> · ${html(model.withdrawalStatus.statusMessage ?? "Bridge state loaded.")}</p>` : ""}</section>`;
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
    const sourceWalletNotice =
      selected.signer === "dusk" && !duskAccount()
        ? `<p class="message notice">${duskState().installed ? "Unlock and reconnect the Dusk wallet to continue." : "Install the Dusk wallet extension to continue."}</p>`
        : selected.signer === "evm" && !model.evmState.account
          ? '<p class="message notice">Connect an EVM wallet to continue.</p>'
          : "";
    root.innerHTML = `<div class="shell"><header class="masthead"><a class="brand" href="#"><img src="/dusk-glyph.svg" alt=""><span><strong>Dusk</strong><small>Bridge</small></span></a><div class="wallet-actions"><button type="button" class="wallet-button" data-action="connect-dusk"><small>Dusk</small>${html(duskStatus)}</button><button type="button" class="wallet-button" data-action="connect-evm"><small>EVM</small>${html(model.evmState.account ? shortAddress(model.evmState.account) : "Connect wallet")}</button></div></header>
      <main><div class="page-heading"><h1>Bridge</h1><p>Move DUSK between networks.</p></div><section class="bridge-card" aria-labelledby="bridge-title"><h2 id="bridge-title">Transfer</h2><label>Route<span class="select-wrap"><select name="route">${routeOptions()}</select></span></label><div class="network-strip"><div><small>From</small><strong>${html(selected.from.label)}</strong></div><span aria-hidden="true">→</span><div><small>To</small><strong>${html(selected.to.label)}</strong></div></div>${sourceWalletNotice}<label>Amount<span class="input-wrap"><input name="amount" inputmode="decimal" placeholder="0.0" value="${html(model.amount)}"><b>DUSK</b></span></label>${routeFields(selected)}<div class="review"><dl><div><dt>Wallet</dt><dd>${html(selected.signer === "dusk" ? shortAddress(duskAccount()) : shortAddress(model.evmState.account))}</dd></div><div><dt>Recipient</dt><dd>${html(destination() || "—")}</dd></div></dl><label class="confirm"><input type="checkbox" name="confirmed" ${model.confirmed ? "checked" : ""}>I checked the amount and recipient.</label></div>${model.error ? `<p class="message error" role="alert">${html(model.error)}</p>` : ""}${model.success ? `<p class="message success" role="status">${html(model.success)}</p>` : ""}${actionMarkup(selected)}${withdrawalManager(selected)}</section><section class="activity"><div class="section-heading"><h2>Recent activity</h2><span>Stored on this device</span></div>${activityMarkup()}</section></main><footer><a href="https://docs.dusk.network/learn/guides/" target="_blank" rel="noreferrer">Bridge guide</a></footer></div>`;
  }

  root.addEventListener("input", (event) => {
    if (event.target.name === "amount") {
      model.amount = event.target.value;
      model.confirmed = false;
      model.error = "";
      model.success = "";
    }
    if (event.target.name === "recipient") {
      model.recipient = event.target.value;
      model.recipientTouched = true;
      model.confirmed = false;
      model.error = "";
      model.success = "";
    }
    if (event.target.name === "withdrawalHash")
      model.withdrawalHash = event.target.value;
    if (event.target.name === "confirmed")
      model.confirmed = event.target.checked;
    if (event.target.name === "amount" || event.target.name === "recipient") {
      const checkbox = root.querySelector('input[name="confirmed"]');
      if (checkbox) checkbox.checked = false;
      for (const message of root.querySelectorAll(
        ".message.error, .message.success",
      ))
        message.remove();
    }
  });
  root.addEventListener("change", (event) => {
    if (event.target.name === "route") {
      model.routeId = event.target.value;
      resetForm();
      void act(synchronizeSelectedRoute);
    }
    render();
  });
  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    ({
      "connect-dusk": () =>
        act(async () => {
          await model.dusk.connect();
          await synchronizeSelectedRoute();
        }),
      "connect-evm": () =>
        act(async () => {
          model.evmState = await connectEvmWallet();
          await synchronizeSelectedRoute();
        }),
      "load-migration": () =>
        act(async () => {
          model.migration = await migrationSnapshot(
            config.legacy.migrations[route().from.id],
          );
        }),
      "check-withdrawal": checkWithdrawal,
      "prove-withdrawal": proveSelectedWithdrawal,
      "finalize-withdrawal": finalizeSelectedWithdrawal,
      approve,
      migrate,
      submit,
    })[action]?.();
  });

  return {
    async start() {
      render();
      const [dusk] = await Promise.all([
        createDuskConnection(),
        initializeEvmWallet(),
      ]);
      model.dusk = dusk;
      dusk.subscribe((state) => {
        const previousAccount =
          model.duskState.selectedProfile?.account ?? null;
        if (
          state.selectedProfile?.account !==
          previousAccount
        ) {
          model.confirmed = false;
          model.success = "";
          if (state.selectedProfile?.account) model.error = "";
        }
        model.duskState = state;
        render();
      });
      subscribeEvmWallet((state) => {
        const previousAccount = model.evmState.account;
        const accountChanged = state.account !== previousAccount;
        const shouldSwitch =
          Boolean(state.account && state.provider) &&
          (state.account !== model.evmState.account ||
            state.chainId !== model.evmState.chainId);
        if (accountChanged) {
          const mode = route().mode;
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
        if (accountChanged && state.account)
          void act(synchronizeSelectedRoute);
        else if (shouldSwitch) void act(ensureSelectedSourceChain);
      });
      const refreshDuskState = () => {
        if (globalThis.document?.visibilityState === "hidden") return;
        void dusk.wallet.refresh().catch(() => {});
      };
      globalThis.addEventListener?.("focus", refreshDuskState);
      globalThis.document?.addEventListener(
        "visibilitychange",
        refreshDuskState,
      );
      render();
    },
  };
}
