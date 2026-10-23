# Online accounts and the AI analysis: setup

The online part has two states in the app, set in `CLOUD` in `src/ui/cloud.js`:

| State | `CLOUD` | What works |
|---|---|---|
| Off | `url` empty, or `connect: false` | Nothing is sent: the run log stays on the device |
| Read-only (now) | `url` + `anonKey` filled, `connect: true` | Sign-in for accounts that already exist (no new account is made), reading the account's runs and edelweiss |

**The app has no write code at all** (Boss's rule, 2026-10-17: "no risk about writing, do not
connect any writing function"). Uploading runs, claiming edelweiss, the AI analysis and deleting
were taken out of `src/ui/cloud.js`; they wait in `supabase/app-writes-later.js`, which is not
part of the build. `cloud.js` also refuses any request other than a read (GET) outside the
sign-in API.

**Writes are closed** on two levels until the account opens (see "Opening the account"):

- the app: no write call exists in it (see above);
- the database: a trigger refuses every insert or update on `runs`, `edelweiss_ledger` and
  `ai_jobs` while `writes_open()` returns false. It also stops the server functions, so even a
  hand-made request stores nothing.

What runs where:

```
browser (GitHub Pages)  -- magic link sign-in, REST reads/writes ------>  Supabase Auth + Postgres (RLS)
                        -- claim-cairns / ai-analyse / delete-account ->  Supabase Edge Functions (Deno)
                                                                               | OPENAI_API_KEY (secret)
                                                                               v
                                                                          OpenAI API (gpt-4o-mini)
```

The API key lives only in the Edge Function secrets. The browser never sees it.

## 1. Create the Supabase project

1. https://supabase.com, sign in with GitHub, New project.
2. Region: **Central EU (Frankfurt)** (health data stays in the EU, simpler for GDPR).
3. Keep the database password somewhere safe.

## 2. Create the tables

SQL editor > New query > paste `supabase/migrations/20261015220000_accounts.sql` > Run.
(Or with the CLI: `supabase link --project-ref <ref>` then `supabase db push`.)

## 3. Sign-in settings

Authentication > URL Configuration:

- Site URL: `https://itf-gh.github.io/trail-race-planner/`
- Redirect URLs: add `https://itf-gh.github.io/trail-race-planner/` and `http://localhost:5173/`

Authentication > Sign In / Providers: while the account is closed, turn OFF "Allow new users
to sign up", so not even an email address is stored. To test sign-in in read-only mode, add
your own account by hand: Authentication > Users > Add user > your email. Email (magic link) stays enabled. The free plan sends a few emails per
hour; for real use, plug in an SMTP service (Authentication > Emails > SMTP).

## 4. The AI step (Boss, 2026-10-23)

1. SQL editor: run `supabase/migrations/20261023120000_ai_open.sql` (also in the project files as
   `supabase-setup/step9-ai-open.sql`). It opens the edelweiss ledger and the AI jobs to the
   server functions only, gives 4 edelweiss to every account (now and at each new account) and
   keeps the runs table closed.
2. Deploy the functions (step 5).
3. The very last step, only on Boss's go: the OpenAI key. https://platform.openai.com > Billing:
   prepaid credits and a monthly limit; API keys > Create key; Supabase > Edge Functions >
   Secrets: add `OPENAI_API_KEY` = that key. Then `ai: true` in `CLOUD` (src/ui/cloud.js).
   Without the key the function answers "not switched on yet" and spends nothing.

One request with gpt-4o-mini costs well under one cent.

## 5. Deploy the functions

From GitHub, nothing to install: add the repository secret `SUPABASE_ACCESS_TOKEN` (supabase.com >
Account > Access tokens > Generate), then GitHub > Actions > "Deploy Supabase functions" > Run
workflow. It runs the tests, then deploys delete-account, ai-analyse and claim-cairns.

Or with the Supabase CLI (https://supabase.com/docs/guides/cli), from the repository folder:

```
supabase login
supabase functions deploy delete-account --project-ref vjhzcuvxucpldhsjpqrl
supabase functions deploy ai-analyse --project-ref vjhzcuvxucpldhsjpqrl
supabase functions deploy claim-cairns --project-ref vjhzcuvxucpldhsjpqrl
```

`ai-analyse` builds its OpenAI request with the app's own prompt code: `npm run build` copies
`src/core` into `supabase/functions/_shared/core` (a test fails if the copy is out of date).

## 6. Fill in the app (read-only)

Project settings > API: copy the Project URL and the `anon` public key into `CLOUD` in
`src/ui/cloud.js` (the anon key is meant to be public: Row Level Security protects the data).
Set `connect: true`. Push to `main`: the account menu shows the
sign-in form, and a signed-in account is marked "account read-only". Never put the database
password or the `service_role` key in the app.

## Opening the account (later, all three together)

1. SQL editor:
   `create or replace function public.writes_open() returns boolean language sql stable as $$ select true $$;`
2. Authentication > Sign In / Providers: turn ON "Allow new users to sign up".
3. Put the write functions of `supabase/app-writes-later.js` back into `src/ui/cloud.js` (in
   place of the `clNoWrite` stubs), make `cloudWritable()` true, remove the GET-only guard in
   `clFetch`, deploy the functions of step 5, push to `main`. Only on Boss's go.

To close again: the same steps the other way round.

## Giving cairns for an event

Achievement cairns are paid by the server (`claim-cairns`), once per achievement. For an event
(a challenge, a launch gift), insert a ledger row in the SQL editor; the unique index pays each
event once per account (only once writes are open):

```sql
insert into edelweiss_ledger (user_id, delta, reason)
select id, 1, 'event:launch-2026' from auth.users;   -- everyone
-- or one person: values ('<user uuid>', 1, 'event:launch-2026')
```

## Useful queries

```sql
select user_id, sum(delta) as cairns from edelweiss_ledger group by 1;              -- balances
select status, count(*), sum(input_tokens), sum(output_tokens) from ai_jobs group by 1;  -- usage
```

## Testing the database rules locally

`npm test` covers the server logic (with a fake database and a fake Claude). The SQL rules were
checked on a local Postgres 16 with stub `auth` schema and roles: a user reads and writes only
their own runs, cannot write the ledger, and `spend_edelweiss` never goes below zero.
