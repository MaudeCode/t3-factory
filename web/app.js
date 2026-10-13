import { html, render } from "./lib/h.js";
import { initialize, subscribe } from "./lib/store.js";
import { App } from "./views/App.js";

render(html`<${App} />`, document.getElementById("root"));
initialize();
subscribe();
