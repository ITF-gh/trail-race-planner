// core-copy.js: copy src/core to supabase/functions/_shared/core, where the server functions
// import it (same engine on the server as in the app). The copy is not kept in git: npm test and
// npm run build make it, and the "Deploy Supabase functions" workflow runs npm test first.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const to = join(root, "supabase/functions/_shared/core");
rmSync(to, { recursive: true, force: true });
cpSync(join(root, "src/core"), to, { recursive: true });
