import "./style.css";

import { createAppController } from "./app-controller.js";

const app = document.querySelector("#app");

if (!app) throw new Error("Application root is missing");

createAppController(app)
  .start()
  .catch((error) => {
    app.textContent = error instanceof Error ? error.message : String(error);
  });
