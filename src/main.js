import "./style.css";

import { bridgeRoutes } from "./bridge-routes.js";
import { createDuskConnection } from "./dusk-wallet.js";

const app = document.querySelector("#app");

if (!app) {
  throw new Error("Application root is missing");
}

const routeOptions = bridgeRoutes
  .map(
    ({ from, id, to }) =>
      `<option value="${id}">${from.label} → ${to.label}</option>`
  )
  .join("");

app.innerHTML = `
  <main>
    <header class="masthead">
      <span class="wordmark">DUSK</span>
      <button id="connect-dusk" type="button">Connect Dusk wallet</button>
    </header>

    <section class="hero">
      <p class="eyebrow">Cross-network transfer</p>
      <h1>Move DUSK without moving your keys.</h1>
      <p class="lede">
        The bridge coordinates each route. Your connected wallets retain custody
        and approve every transaction.
      </p>
    </section>

    <section class="bridge-card" aria-labelledby="bridge-title">
      <div>
        <p class="eyebrow">Route</p>
        <h2 id="bridge-title">Choose the networks</h2>
      </div>

      <label>
        Bridge direction
        <select id="route">${routeOptions}</select>
      </label>

      <div class="wallet-status">
        <span>Dusk wallet</span>
        <strong id="dusk-status">Checking extension…</strong>
      </div>

      <p class="notice">
        EVM wallet support and transaction submission will be added after the
        signing interfaces and contract configuration are pinned.
      </p>
    </section>
  </main>
`;

const connectButton = document.querySelector("#connect-dusk");
const duskStatus = document.querySelector("#dusk-status");

const setConnectionState = (state) => {
  const profile = state.selectedProfile;

  duskStatus.textContent = profile
    ? `Connected: ${profile.name ?? "Profile"}`
    : state.installed
      ? "Extension available"
      : "No compatible extension detected";
  connectButton.disabled = !state.installed;
};

createDuskConnection()
  .then((connection) => {
    setConnectionState(connection.state);
    connection.subscribe(setConnectionState);

    connectButton.addEventListener("click", () => {
      connection.connect().catch((error) => {
        duskStatus.textContent = error?.message ?? "Connection rejected";
      });
    });
  })
  .catch((error) => {
    duskStatus.textContent = error?.message ?? "Unable to initialize Dusk Connect";
    connectButton.disabled = true;
  });

