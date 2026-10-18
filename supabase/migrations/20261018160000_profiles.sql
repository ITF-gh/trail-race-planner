-- The runner's profile online: name, flag, a few words, badges, goals and bests, references.
-- One row per user, readable and writable by its owner only (Row Level Security).
-- This is the ONE table the app may write (Boss, 2026-10-18). runs, edelweiss_ledger and
-- ai_jobs stay locked by writes_open().
-- Heart rates and weight are NOT part of it: they stay in the browser (the check below refuses
-- any heart or weight key, at any depth of the JSON text).
create table if not exists public.profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint profiles_small check (octet_length(data::text) <= 4096),
  constraint profiles_is_object check (jsonb_typeof(data) = 'object'),
  constraint profiles_no_body check (data::text !~* '"(hr|heart|weight)')
);
alter table public.profiles enable row level security;
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles for select using (user_id = auth.uid());
drop policy if exists "profiles: add own" on public.profiles;
create policy "profiles: add own" on public.profiles for insert with check (user_id = auth.uid());
drop policy if exists "profiles: change own" on public.profiles;
create policy "profiles: change own" on public.profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No delete policy: deleting the account (auth.users) removes the row (on delete cascade).
