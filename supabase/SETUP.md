# Online accounts and the AI analysis: setup

The online part (sign-in, run log in the account, cairns, AI analysis) is OFF until
`CLOUD.url` and `CLOUD.anonKey` are filled in `src/ui/cloud.js` AND `CLOUD.open` is `true`.
Until then the app works exactly as before, with the run log on the device only, and sends
nothing to the server.

**Writes are closed** on two levels until the account opens (see "Opening the account"):

- the app: `CLOUD.open: false` means no sign-in, no sync, no cairn, no AI call;
- the database: a trigger refuses every insert or update on `runs`, `cairn_ledger` and
  `ai_jobs` while `writes_open()` returns false. It also stops the server functions, so even a
  hand-made request stores nothing.

What runs where:

```
browser (GitHub Pages)  -- magic link sign-in, REST reads/writes ------>  Supabase Auth + Postgres (RLS)
                        -- claim-cairns / ai-analyse / delete-account ->  Supabase Edge Functions (Deno)
                                                                               | ANTHROPIC_API_KEY (secret)
                                                                               v
                                                                          Claude API (claude-opus-5-5)
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
to sign up", so not even an email address is stored. Email (magic link) stays enabled. The free plan sends a few emails per
hour; for real use, plug in an SMTP service (Authentication > Emails > SMTP).

## 4. The Claude API key

1. https://console.anthropic.com > Billing: add prepaid credits (and a monthly limit).
2. API keys > Create key.
3. Supabase > Edge Functions > Secrets: add `ANTHROPIC_API_KEY` = that key.

One analysis costs roughly $0.10 to $0.20 (a few thousand tokens in, a few thousand out).

## 5. Deploy the three functions

With the Supabase CLI (https://supabase.com/docs/guides/cli), from the repository folder:

```
supabase login
supabase link --project-ref <ref>
supabase functions deploy claim-cairns
supabase functions deploy ai-analyse
supabase functions deploy delete-account
```

## 6. Fill in the app (still closed)

Project settings > API: copy the Project URL and the `anon` public key into `CLOUD` in
`src/ui/cloud.js` (the anon key is meant to be public: Row Level Security protects the data).
Leave `open: false`. Push to `main`; nothing changes for runners.

## Opening the account (later, all three together)

1. SQL editor:
   `create or replace function public.writes_open() returns boolean language sql stable as $$ select true $$;`
2. Authentication > Sign In / Providers: turn ON "Allow new users to sign up".
3. `CLOUD.open: true` in `src/ui/cloud.js`, push to `main`.

To close again: the same three steps with `false` / OFF.

## Giving cairns for an event

Achievement cairns are paid by the server (`claim-cairns`), once per achievement. For an event
(a challenge, a launch gift), insert a ledger row in the SQL editor; the unique index pays each
event once per account (only once writes are open):

```sql
insert into cairn_ledger (user_id, delta, reason)
select id, 1, 'event:launch-2026' from auth.users;   -- everyone
-- or one person: values ('<user uuid>', 1, 'event:launch-2026')
```

## Useful queries

```sql
select user_id, sum(delta) as cairns from cairn_ledger group by 1;              -- balances
select status, count(*), sum(input_tokens), sum(output_tokens) from ai_jobs group by 1;  -- usage
```

## Testing the database rules locally

`npm test` covers the server logic (with a fake database and a fake Claude). The SQL rules were
checked on a local Postgres 16 with stub `auth` schema and roles: a user reads and writes only
their own runs, cannot write the ledger, and `spend_cairn` never goes below zero.
