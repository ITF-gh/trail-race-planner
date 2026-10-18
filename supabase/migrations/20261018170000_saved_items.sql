-- What a signed-in runner chooses to keep: "Save to my account" on a race plan (Prep my race),
-- a run session (Prep my run) or a run (Rewind my run). Never automatic (Boss, 2026-10-18).
-- Only the COMPUTED summary is kept (distances, climbing, times, sections), never the GPX file.
-- Readable, addable and deletable by its owner only (Row Level Security). No update: an item
-- is saved again as a new one.
create table if not exists public.saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('plan', 'session', 'run')),
  title text not null check (char_length(title) between 1 and 80),
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint saved_small check (octet_length(data::text) <= 16384),
  constraint saved_is_object check (jsonb_typeof(data) = 'object'),
  -- Same rule as the profile: no heart or weight data online.
  constraint saved_no_body check (data::text !~* '"(hr|heart|weight)')
);
create index if not exists saved_by_user on public.saved_items (user_id, created_at desc);
alter table public.saved_items enable row level security;
drop policy if exists "saved: read own" on public.saved_items;
create policy "saved: read own" on public.saved_items for select using (user_id = auth.uid());
drop policy if exists "saved: add own" on public.saved_items;
create policy "saved: add own" on public.saved_items for insert with check (user_id = auth.uid());
drop policy if exists "saved: delete own" on public.saved_items;
create policy "saved: delete own" on public.saved_items for delete using (user_id = auth.uid());

-- At most 200 items per runner, so the free storage cannot be filled by one account.
create or replace function public.saved_items_cap() returns trigger language plpgsql as $body$
begin
  if (select count(*) from public.saved_items where user_id = new.user_id) >= 200 then
    raise exception 'You can keep 200 saved items: delete some to save new ones' using errcode = 'P0001';
  end if;
  return new;
end;
$body$;
drop trigger if exists saved_items_cap on public.saved_items;
create trigger saved_items_cap before insert on public.saved_items for each row execute function public.saved_items_cap();
