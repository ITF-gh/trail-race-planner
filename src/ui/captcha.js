// captcha.js: Cloudflare Turnstile bot check for the account forms; Supabase verifies each token server-side.

let capLoad = null;

/** Load the Turnstile script once (CSP allows challenges.cloudflare.com, see scripts/build.js). */
function capScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!capLoad) capLoad = new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? ok(window.turnstile) : ko(new Error("Bot check did not load")));
    s.onerror = () => { capLoad = null; ko(new Error("Bot check did not load, check your connection")); };
    document.head.appendChild(s);
  });
  return capLoad;
}

/** A fresh one-use token for site key `key`, or "" when no key is set. A box shows only if Cloudflare wants a click. */
export async function captchaToken(key) {
  if (!key) return "";
  const ts = await capScript();
  const box = document.createElement("div");
  box.className = "captcha-box";
  document.body.appendChild(box);
  let id = null;
  try {
    return await new Promise((ok, ko) => {
      id = ts.render(box, {
        sitekey: key,
        appearance: "interaction-only",
        language: document.documentElement.lang || "auto",
        callback: ok,
        "error-callback": () => ko(new Error("Bot check failed, please try again")),
        "timeout-callback": () => ko(new Error("Bot check timed out, please try again")),
      });
    });
  } finally {
    try { if (id !== null) ts.remove(id); } catch (e) { /* already gone */ }
    box.remove();
  }
}
