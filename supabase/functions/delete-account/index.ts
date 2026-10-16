// POST /functions/v1/delete-account: deletes the signed-in user. Their runs, cairns and analyses
// go with them (the tables reference auth.users with ON DELETE CASCADE). The right to erasure.
// Deleting a user needs the service role (admin), which the browser does not have; that is why
// this is a server function rather than a call from the app.
import { admin, cors, json, userOf } from "../_shared/server.ts";

// Deno.serve runs this function for every HTTP request.
Deno.serve(async (req) => {
  // CORS preflight: the browser asks first whether the call is allowed.
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  // Only the signed-in user can delete, and only their own account (the id comes from the token).
  const sb = admin();
  const user = await userOf(req, sb);
  if (!user) return json(req, 401, { error: "Please sign in." });
  const { error } = await sb.auth.admin.deleteUser(user);
  if (error) { console.error(error); return json(req, 500, { error: "Could not delete the account." }); }
  return json(req, 200, { deleted: true });
});
