# Online accounts and the AI analysis: setup

The online part (sign-in, run log in the account, cairns, AI analysis) is OFF until
`CLOUD.url` and `CLOUD.anonKey` are filled in `src/ui/cloud.js`. Until then the app works
exactly as before, with the run log on the device only.

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

Authentication > Providers > Email: enabled (magic link). The free plan sends a few emails per
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

## 6. Switch the app on

Project settings > API: copy the Project URL and the `anon` public key into `CLOUD` in
`src/ui/cloud.js` (the anon key is meant to be public: Row Level Security protects the data).
Push to `main`; the Pages workflow publishes it.

## Giving cairns for an event

Achievement cairns are paid by the server (`claim-cairns`), once per achievement. For an event
(a challenge, a launch gift), insert a ledger row in the SQL editor; the unique index pays each
event once per account:

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
