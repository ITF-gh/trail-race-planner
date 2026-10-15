// POST /functions/v1/delete-account: deletes the signed-in user. Their runs, cairns and analyses
// go with them (the tables reference auth.users with ON DELETE CASCADE). The right to erasure.
import { admin, cors, json, userOf } from "../_shared/server.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const sb = admin();
  const user = await userOf(req, sb);
  if (!user) return json(req, 401, { error: "Please sign in." });
  const { error } = await sb.auth.admin.deleteUser(user);
  if (error) { console.error(error); return json(req, 500, { error: "Could not delete the account." }); }
  return json(req, 200, { deleted: true });
});
