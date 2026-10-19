import { html, useState } from "../lib/h.js";
import { auth, loginError, connect } from "../lib/store.js";
import { Button, Field } from "../ui/index.js";

export function Login() {
  const sso = auth.value.mode === "oidc";
  const [code, setCode] = useState("");
  const submit = (e) => {
    e.preventDefault();
    loginError.value = "";
    connect(code).catch((error) => (loginError.value = error.message));
  };
  return html`<main class="login">
    <div>
      <img src="/icon.svg" width="40" height="40" alt="" />
      <h1>T3 Factory</h1>
      <p>${sso ? "Sign in with an authorized account to control the factory." : "Pair this device with your Mac to control the factory."}</p>
      ${sso
        ? html`<${Button} variant="primary" onClick=${() => (location.href = auth.value.loginUrl + "?returnTo=" + encodeURIComponent(location.pathname + location.search))}>Sign in with SSO<//>`
        : html`<form onSubmit=${submit}>
            <${Field} label="Pairing code or link">
              <input value=${code} onInput=${(e) => setCode(e.target.value)} autocomplete="off" autocapitalize="off" spellcheck="false" required />
            <//>
            <${Button} variant="primary" type="submit">Connect<//>
            <p class="hint" style="margin-top:16px">Run <code>t3-factory web-pair</code> on your Mac. Links expire after 10 minutes.</p>
          </form>`}
      ${loginError.value && html`<p class="alert" role="alert">${loginError.value}</p>`}
    </div>
  </main>`;
}
