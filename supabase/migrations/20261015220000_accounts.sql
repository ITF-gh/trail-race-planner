-- Accounts for the trail race planner: the run log, the cairn ledger and the AI analyses.
--
-- How the security works: the browser talks to these tables directly (Supabase's REST API), with
-- the signed-in user's token. Row Level Security (RLS) rules below make every row visible and
-- writable only by its owner (auth.uid() is the user id inside that token). Cairns are different:
-- the browser may READ its ledger but never write it. Only the server functions (which run with
-- the service role, a key that never leaves Supabase) add or spend cairns.

-- 1. Run summaries (about 1 KB each, never GPS points). `rec` is the summary from runRecord().
create table if not exists public.runs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  rec jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint runs_id_matches check (rec ->> 'id' = id),
  constraint runs_small check (octet_length(rec::text) <= 4096)
);
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
create table if not exists public.cairn_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  delta integer not null check (delta between -1 and 10 and delta <> 0),
  reason text not null check (reason ~ '^(ach|event):[a-z0-9_-]{1,40}$' or reason in ('ai', 'refund')),
  ref text,
  created_at timestamptz not null default now()
);
create unique index if not exists cairn_once_per_reason on public.cairn_ledger (user_id, reason)
  where reason like 'ach:%' or reason like 'event:%';
create unique index if not exists cairn_one_refund on public.cairn_ledger (user_id, ref) where reason = 'refund';
create index if not exists cairn_by_user on public.cairn_ledger (user_id, created_at desc);
alter table public.cairn_ledger enable row level security;
create policy "cairns: read own" on public.cairn_ledger for select using (user_id = auth.uid());
-- (no insert, update or delete policy: only the service role can write)

-- 3. AI analyses: what was asked, what came back, what it cost.
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
revoke all on function public.spend_cairn(uuid, uuid) from public;
grant execute on function public.spend_cairn(uuid, uuid) to service_role;

-- 5. Writes are CLOSED until the account opens. Every insert or update on the three tables goes
-- through this trigger, which refuses it while writes_open() is false. Triggers also apply to the
-- service role (unlike RLS), so neither the browser nor the server functions can store anything.
-- To open, run once:  create or replace function public.writes_open() returns boolean
--                     language sql stable as $$ select true $$;
create or replace function public.writes_open() returns boolean language sql stable as $$ select false $$;
create or replace function public.refuse_closed_writes() returns trigger language plpgsql as $$
begin
  if not public.writes_open() then
    raise exception 'The online account is not open yet' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger runs_closed before insert or update on public.runs for each row execute function public.refuse_closed_writes();
create trigger ledger_closed before insert or update on public.cairn_ledger for each row execute function public.refuse_closed_writes();
create trigger ai_jobs_closed before insert or update on public.ai_jobs for each row execute function public.refuse_closed_writes();
