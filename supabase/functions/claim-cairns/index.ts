// POST /functions/v1/claim-cairns: pay out the cairns of the achievements reached (once each),
// checked on the runs stored in the account. Answers { added: [reasons], balance }.
import { admin, cors, json, makeDb, userOf } from "../_shared/server.ts";
import { claimCairns } from "../_shared/cairns.js";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const sb = admin();
  const user = await userOf(req, sb);
  if (!user) return json(req, 401, { error: "Please sign in." });
  try {
    return json(req, 200, await claimCairns(makeDb(sb), user));
  } catch (e) {
    console.error(e);
    return json(req, 500, { error: "Could not check your achievements." });
  }
});
