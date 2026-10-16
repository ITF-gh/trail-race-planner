-- Accounts for the trail race planner: the run log, the cairn ledger and the AI analyses.
--
-- How the security works: the browser talks to these tables directly (Supabase's REST API), with
-- the signed-in user's token. Row Level Security (RLS) rules below make every row visible and
-- writable only by its owner (auth.uid() is the user id inside that token). Cairns are different:
-- the browser may READ its ledger but never write it. Only the server functions (which run with
-- the service role, a key that never leaves Supabase) add or spend cairns.
--
-- A "migration" is a script that changes the database's structure. Supabase runs the files in
-- supabase/migrations once each, in the order of the timestamp at the start of their name.
-- `if not exists` makes most statements safe to run again.
--
-- Contents: 1. runs, 2. cairn_ledger, 3. ai_jobs (three tables), 4. spend_cairn (a function),
-- 5. a switch that keeps every write closed until the online account opens.

-- 1. Run summaries (about 1 KB each, never GPS points). `rec` is the summary from runRecord().
--   user_id     the owner; defaults to the signed-in user; `references auth.users ... on delete
--               cascade` means the row is deleted automatically when the user is deleted
--   id          the run's id (the same as rec's "id" field, enforced by runs_id_matches)
--   rec         the summary as JSON (jsonb = JSON stored in a binary, searchable form)
--   primary key (user_id, id): one row per run per user
--   runs_small  refuses a summary larger than 4096 bytes, so the table cannot be filled with junk
--   (rec ->> 'id' reads the "id" field of the JSON as text)
create table if not exists public.runs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  rec jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint runs_id_matches check (rec ->> 'id' = id),
  constraint runs_small check (octet_length(rec::text) <= 4096)
);
-- Turn RLS on, then allow each of the four operations only on the user's own rows.
-- `using` filters the rows a user can see or touch; `with check` validates the rows they write.
alter table public.runs enable row level security;
create policy "runs: read own" on public.runs for select using (user_id = auth.uid());
create policy "runs: add own" on public.runs for insert with check (user_id = auth.uid());
create policy "runs: change own" on public.runs for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "runs: delete own" on public.runs for delete using (user_id = auth.uid());

-- 2. The cairn ledger: one row per movement (+1 earned, -1 spent). The balance is the sum, so
-- every cairn has a reason and nothing can be changed afterwards.
--   reason 'ach:<code>'   an achievement (paid once per account: unique index below)
--   reason 'event:<name>' a gift for an event or a challenge (added by hand or by a script)
--   reason 'ai'           one AI analysis (delta -1, ref = the analysis id)
--   reason 'refund'       the analysis failed, the cairn comes back (ref = the analysis id)
-- The checks: delta is between -1 and 10 and never 0; the reason is 'ai', 'refund', or matches
-- the regular expression (~) "ach:" or "event:" followed by 1 to 40 lowercase letters, digits,
-- _ or -. `generated always as identity` numbers the rows automatically.
create table if not exists public.cairn_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  delta integer not null check (delta between -1 and 10 and delta <> 0),
  reason text not null check (reason ~ '^(ach|event):[a-z0-9_-]{1,40}$' or reason in ('ai', 'refund')),
  ref text,
  created_at timestamptz not null default now()
);
-- "Partial" unique indexes (with `where`): the uniqueness rule applies only to the rows that
-- match. An achievement or event reason can appear once per user; a job can be refunded once.
-- A second insert breaks the rule with error 23505, which the server treats as "already paid".
create unique index if not exists cairn_once_per_reason on public.cairn_ledger (user_id, reason)
  where reason like 'ach:%' or reason like 'event:%';
create unique index if not exists cairn_one_refund on public.cairn_ledger (user_id, ref) where reason = 'refund';
-- A plain index to list a user's movements quickly, newest first.
create index if not exists cairn_by_user on public.cairn_ledger (user_id, created_at desc);
alter table public.cairn_ledger enable row level security;
create policy "cairns: read own" on public.cairn_ledger for select using (user_id = auth.uid());
-- (no insert, update or delete policy: only the service role can write)

-- 3. AI analyses: what was asked, what came back, what it cost.
--   status        'running' while Claude works, then 'done' or 'failed'
--   model, runs   the model used and the number of runs sent
--   result        the analysis as JSON (the shape of AI_SCHEMA in cairns.js), when done
--   error         why it failed, when failed
--   input_tokens, output_tokens   the size of the request and the answer (what it cost)
-- The browser can only read its own jobs (it polls its row until the status changes).
create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  model text,
  runs integer,
  result jsonb,
  error text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_jobs_by_user on public.ai_jobs (user_id, created_at desc);
alter table public.ai_jobs enable row level security;
create policy "ai: read own" on public.ai_jobs for select using (user_id = auth.uid());

-- 4. Spend one cairn, atomically. The advisory lock makes two clicks at the same moment wait for
-- each other, so the same cairn can never be spent twice. Returns false when the balance is 0.
-- Step by step: take a lock named after the user (hashtext turns 'cairns:<user id>' into a
-- number; the lock is released at the end of the transaction), add up the user's ledger
-- (coalesce gives 0 when there are no rows), refuse below 1, otherwise insert a -1 'ai' row
-- that points to the job.
-- `security definer` runs the function with its owner's rights; `set search_path = public`
-- makes it use the public tables only. The body between the $$ marks is PL/pgSQL, PostgreSQL's
-- procedural language.
create or replace function public.spend_cairn(p_user uuid, p_job uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bal integer;
begin
  perform pg_advisory_xact_lock(hashtext('cairns:' || p_user::text));
  select coalesce(sum(delta), 0) into bal from cairn_ledger where user_id = p_user;
  if bal < 1 then
    return false;
  end if;
  insert into cairn_ledger (user_id, delta, reason, ref) values (p_user, -1, 'ai', p_job::text);
  return true;
end;
$$;
-- Nobody may call it except the service role (the server functions): a browser could otherwise
-- spend cairns without starting an analysis.
revoke all on function public.spend_cairn(uuid, uuid) from public;
grant execute on function public.spend_cairn(uuid, uuid) to service_role;

-- 5. Writes are CLOSED until the account opens. Every insert or update on the three tables goes
-- through this trigger, which refuses it while writes_open() is false. Triggers also apply to the
-- service role (unlike RLS), so neither the browser nor the server functions can store anything.
-- To open, run once:  create or replace function public.writes_open() returns boolean
--                     language sql stable as $$ select true $$;
-- writes_open: a one-line switch, false for now.
-- refuse_closed_writes: the trigger function; it raises an error (which cancels the write) while
-- the switch is false, and otherwise returns `new` (the row about to be written) unchanged.
-- Deletes are not blocked, so deleting an account still works while writes are closed.
create or replace function public.writes_open() returns boolean language sql stable as $$ select false $$;
create or replace function public.refuse_closed_writes() returns trigger language plpgsql as $$
begin
  if not public.writes_open() then
    raise exception 'The online account is not open yet' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
-- One trigger per table, run `before` each inserted or updated row (`for each row`).
create trigger runs_closed before insert or update on public.runs for each row execute function public.refuse_closed_writes();
create trigger ledger_closed before insert or update on public.cairn_ledger for each row execute function public.refuse_closed_writes();
create trigger ai_jobs_closed before insert or update on public.ai_jobs for each row execute function public.refuse_closed_writes();
