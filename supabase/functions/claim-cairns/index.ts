// POST /functions/v1/claim-cairns: pay out the cairns of the achievements reached (once each),
// checked on the runs stored in the account. Answers { added: [reasons], balance }.
// The logic is claimCairns in ../_shared/cairns.js; this file only connects it to HTTP and Supabase.
import { admin, cors, json, makeDb, userOf } from "../_shared/server.ts";
import { claimCairns } from "../_shared/cairns.js";

// Deno.serve runs this function for every HTTP request.
Deno.serve(async (req) => {
  // CORS preflight: the browser asks first whether the call is allowed.
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  // Find the signed-in user from the request's token; 401 when there is none.
  const sb = admin();
  const user = await userOf(req, sb);
  if (!user) return json(req, 401, { error: "Please sign in." });
  try {
    return json(req, 200, await claimCairns(makeDb(sb), user));
  } catch (e) {
    // Log the details on the server, give the browser a plain message.
    console.error(e);
    return json(req, 500, { error: "Could not check your achievements." });
  }
});
