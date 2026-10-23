// The online account (src/ui/cloud.js) is read-only: sign-in and reads only. No write call may
// send anything, whatever the settings. fetch is replaced by a fake that records each request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD, CL_READONLY, cloudOn, cloudWritable, cloudSendLink, cloudPutRuns, cloudDeleteRuns, cloudClaim, cloudAnalyse, cloudSignUp, cloudSendReset } from "../src/ui/cloud.js";

const sent = [];
globalThis.fetch = async (url, opts) => { sent.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => "" }; };
globalThis.location = { origin: "https://itf-gh.github.io", pathname: "/trail-race-planner/", hash: "" };

const setCloud = (c) => Object.assign(CLOUD, { url: "https://x.supabase.co", anonKey: "anon", connect: false }, c);

test("off until url, key and connect are all set", () => {
  setCloud({ url: "", connect: true });
  assert.equal(cloudOn(), false);
  setCloud({});
  assert.equal(cloudOn(), false);
  setCloud({ connect: true });
  assert.equal(cloudOn(), true);
});

test("every write is refused and sends nothing, even with an old 'open' flag", async () => {
  setCloud({ connect: true, open: true });
  assert.equal(cloudWritable(), false);
  sent.length = 0;
  for (const call of [() => cloudPutRuns([{ id: 1 }]), cloudDeleteRuns, cloudClaim, () => cloudAnalyse(null, {})]) {
    await assert.rejects(call(), { message: CL_READONLY });
  }
  assert.equal(sent.length, 0);
});

test("a sign-in link never creates an account", async () => {
  setCloud({ connect: true });
  sent.length = 0;
  await cloudSendLink("me@example.com");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.create_user, false);
});

test("sign-up and forgot password go to Supabase Auth and come back to this page", async () => {
  setCloud({ connect: true });
  sent.length = 0;
  await cloudSignUp("me@example.com", "longenough");
  await cloudSendReset("me@example.com");
  assert.match(sent[0].url, /\/auth\/v1\/signup\?redirect_to=https%3A%2F%2Fitf-gh\.github\.io%2Ftrail-race-planner%2F$/);
  assert.deepEqual(sent[0].body, { email: "me@example.com", password: "longenough" });
  assert.match(sent[1].url, /\/auth\/v1\/recover\?redirect_to=/);
  assert.deepEqual(sent[1].body, { email: "me@example.com" });
});
