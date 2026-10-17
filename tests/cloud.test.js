// The online account's read-only state (src/ui/cloud.js): connected for sign-in and reading,
// but no write call may send anything. fetch is replaced by a fake that records each request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD, CL_READONLY, cloudOn, cloudWritable, cloudSendLink, cloudPutRuns, cloudDeleteRuns, cloudClaim, cloudAnalyse, cloudDeleteAccount } from "../src/ui/cloud.js";

const sent = [];
globalThis.fetch = async (url, opts) => { sent.push({ url, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => "" }; };
globalThis.location = { origin: "https://itf-gh.github.io", pathname: "/trail-race-planner/", hash: "" };

const setCloud = (c) => Object.assign(CLOUD, { url: "https://x.supabase.co", anonKey: "anon", connect: false, open: false }, c);

test("off: no url or no switch means not connected", () => {
  setCloud({ url: "" , connect: true });
  assert.equal(cloudOn(), false);
  setCloud({});
  assert.equal(cloudOn(), false);
  assert.equal(cloudWritable(), false);
});

test("read-only: connected, every write throws before any request", async () => {
  setCloud({ connect: true });
  assert.equal(cloudOn(), true);
  assert.equal(cloudWritable(), false);
  sent.length = 0;
  for (const call of [() => cloudPutRuns([{ id: 1 }]), cloudDeleteRuns, cloudClaim, () => cloudAnalyse(null, {}), cloudDeleteAccount]) {
    await assert.rejects(call(), { message: CL_READONLY });
  }
  assert.equal(sent.length, 0);
});

test("read-only: a sign-in link never creates an account", async () => {
  setCloud({ connect: true });
  sent.length = 0;
  await cloudSendLink("me@example.com");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.create_user, false);
  setCloud({ open: true });
  await cloudSendLink("me@example.com");
  assert.equal(sent[1].body.create_user, true);
});
