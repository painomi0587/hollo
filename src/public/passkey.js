// Glue between Hollo's auth/login pages and @simplewebauthn/browser.
// The library is vendored in simplewebauthn-browser.umd.js (which exposes
// `window.SimpleWebAuthnBrowser`) and is loaded immediately before this
// script.  Both are dropped into a page only on the auth dashboard and
// the public login screen — the rest of the dashboard stays zero-JS.
//
// To upgrade the vendored library, run:
//   cp node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js \
//      src/public/simplewebauthn-browser.umd.js
"use strict";

(function () {
  const lib = window.SimpleWebAuthnBrowser;
  if (lib == null) return;

  function setStatus(el, message, isError) {
    if (el == null) return;
    el.textContent = message;
    el.classList.toggle("text-red-600", Boolean(isError));
    el.classList.toggle("dark:text-red-400", Boolean(isError));
  }

  async function postJson(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body == null ? "{}" : JSON.stringify(body),
    });
    // The auth-gated /auth/passkeys/* endpoints can answer with a
    // redirect to /login when the session is gone (e.g., the user
    // logged out in another tab and then triggered an enrollment
    // here).  fetch() follows that redirect, so response.ok stays
    // true and the final HTML page lands here.  Detect it and send
    // the browser to /login itself instead of trying to parse HTML
    // as JSON.
    if (response.redirected) {
      window.location.assign(response.url);
      throw new Error("Session expired; redirecting to sign in.");
    }
    if (!response.ok) {
      let detail;
      try {
        detail = await response.json();
      } catch (_err) {
        detail = null;
      }
      const error = new Error(
        (detail && detail.error) ||
          "Request failed with status " + response.status,
      );
      error.status = response.status;
      throw error;
    }
    // 204 No Content (used by the registration-finish endpoint on success)
    // has an empty body and would throw if we asked for JSON.
    if (response.status === 204) return null;
    const len = response.headers.get("Content-Length");
    if (len === "0") return null;
    return response.json();
  }

  function bindEnroll(form) {
    if (form == null) return;
    const status = document.getElementById("passkey-enroll-status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const nicknameInput = form.querySelector('input[name="nickname"]');
      const nickname = nicknameInput ? nicknameInput.value.trim() : "";
      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) submitButton.disabled = true;
      setStatus(status, "Follow the prompts on your device…", false);
      try {
        const options = await postJson("/auth/passkeys/registration/begin");
        const registrationResponse = await lib.startRegistration({
          optionsJSON: options,
        });
        await postJson("/auth/passkeys/registration/finish", {
          nickname: nickname,
          registrationResponse: registrationResponse,
        });
        setStatus(status, "Passkey added.", false);
        window.location.reload();
      } catch (err) {
        const name = err && err.name ? err.name : "";
        const message =
          name === "NotAllowedError"
            ? "Enrollment was cancelled."
            : err && err.message
              ? err.message
              : "Could not enroll a passkey.";
        setStatus(status, message, true);
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  function bindSignIn(button) {
    if (button == null) return;
    const status = document.getElementById("passkey-signin-status");
    button.addEventListener("click", async () => {
      const next = button.getAttribute("data-next") || "";
      button.disabled = true;
      setStatus(status, "Choose a passkey on your device…", false);
      try {
        const options = await postJson("/login/passkey/begin");
        const authenticationResponse = await lib.startAuthentication({
          optionsJSON: options,
        });
        const result = await postJson("/login/passkey/finish", {
          next: next,
          authenticationResponse: authenticationResponse,
        });
        window.location.assign(result.redirect || "/");
      } catch (err) {
        const name = err && err.name ? err.name : "";
        const message =
          name === "NotAllowedError"
            ? "Sign-in was cancelled."
            : err && err.message
              ? err.message
              : "Could not sign in with a passkey.";
        setStatus(status, message, true);
        button.disabled = false;
      }
    });
  }

  function init() {
    bindEnroll(document.getElementById("passkey-enroll-form"));
    bindSignIn(document.getElementById("passkey-signin-button"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
