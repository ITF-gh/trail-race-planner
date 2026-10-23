-- The AI step (Boss, 2026-10-23): the edelweiss ledger and the AI requests open for the server
-- functions, and 4 free edelweiss for every account (accounts stay by invitation).
-- Run once in the SQL editor. Safe to run again.
--
-- What changes:
--   1. edelweiss_ledger and ai_jobs: the "closed" lock is lifted. The browser still cannot write
--      them (no insert or update policy: only the server functions, with the service role, can).
--      The runs table stays closed.
--   2. A new ledger reason 'welcome': +4 edelweiss, once per account.
--   3. Every new account gets its 4 edelweiss when it is created (a trigger on auth.users), and
--      every account that already exists gets them now.
--   4. ai_jobs gets a "mode" column: which AI made the answer (prep_race or prep_run).

-- 1. Open the two tables for the server functions only.
drop trigger if exists ledger_closed on public.edelweiss_ledger;
drop trigger if exists ai_jobs_closed on public.ai_jobs;

-- 2. The welcome reason, once per account.
-- The old reason rule is found by what it checks (its name depends on how the table was made).
do $body$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.edelweiss_ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%reason%' loop
    execute format('alter table public.edelweiss_ledger drop constraint %I', c);
  end loop;
end;
$body$;
alter table public.edelweiss_ledger add constraint edelweiss_ledger_reason_check
  check (reason ~ '^(ach|event):[a-z0-9_-]{1,40}$' or reason in ('ai', 'refund', 'welcome'));
create unique index if not exists edelweiss_one_welcome on public.edelweiss_ledger (user_id) where reason = 'welcome';

-- 3. The gift, at account creation. security definer: runs with its owner's rights, because the
-- account is created by Supabase Auth, which has no right on the ledger.
create or replace function public.welcome_edelweiss() returns trigger
language plpgsql security definer set search_path = public as $body$
begin
  insert into public.edelweiss_ledger (user_id, delta, reason) values (new.id, 4, 'welcome')
    on conflict (user_id) where reason = 'welcome' do nothing;
  return new;
end;
$body$;
drop trigger if exists welcome_edelweiss on auth.users;
create trigger welcome_edelweiss after insert on auth.users for each row execute function public.welcome_edelweiss();
-- The accounts that already exist.
insert into public.edelweiss_ledger (user_id, delta, reason)
  select id, 4, 'welcome' from auth.users
  on conflict (user_id) where reason = 'welcome' do nothing;

-- 4. Which AI made each answer.
alter table public.ai_jobs add column if not exists mode text check (mode in ('prep_race', 'prep_run'));
