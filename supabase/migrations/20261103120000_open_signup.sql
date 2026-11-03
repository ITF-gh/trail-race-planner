-- Step 10, open sign-ups safely (Boss, 2026-11-03). Run once in the SQL editor; safe to run again.
--   1. Max 10 new accounts per hour, all together (kill switch against mass sign-ups).
--   2. Welcome gift: 2 edelweiss, given only once the email is confirmed (accounts that have theirs keep them).
--   3. Accounts with 2-step login: their data needs a 2-step session (aal2), also in the server functions.
--   4. Storage caps: 15 MB of saves per account, 300 MB for everybody (free plan has 500 MB).

-- 1. New accounts per hour. Raising an error cancels the sign-up (the app says "try again later").
create or replace function public.signup_cap() returns trigger
language plpgsql security definer set search_path = '' as $body$
begin
  if (select count(*) from auth.users where created_at > now() - interval '1 hour') >= 10 then
    raise exception 'signup_cap: too many new accounts this hour' using errcode = 'P0001';
  end if;
  return new;
end;
$body$;
drop trigger if exists signup_cap on auth.users;
create trigger signup_cap before insert on auth.users for each row execute function public.signup_cap();

-- 2. The welcome gift, when the email is confirmed (on insert for accounts Boss creates already confirmed).
create or replace function public.welcome_edelweiss() returns trigger
language plpgsql security definer set search_path = public as $body$
begin
  if new.email_confirmed_at is not null then
    insert into public.edelweiss_ledger (user_id, delta, reason) values (new.id, 2, 'welcome')
      on conflict (user_id) where reason = 'welcome' do nothing;
  end if;
  return new;
end;
$body$;
drop trigger if exists welcome_edelweiss on auth.users;
create trigger welcome_edelweiss after insert on auth.users for each row execute function public.welcome_edelweiss();
drop trigger if exists welcome_edelweiss_confirm on auth.users;
create trigger welcome_edelweiss_confirm after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.welcome_edelweiss();

-- 3. True when the session is strong enough: 2-step done, or the user has no 2-step set up.
create or replace function public.aal_ok() returns boolean
language sql stable security definer set search_path = '' as $body$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$body$;
revoke all on function public.aal_ok() from public;
grant execute on function public.aal_ok() to authenticated;
-- "restrictive": checked on top of the "own rows" policies, never instead of them.
do $body$
declare t text;
begin
  foreach t in array array['profiles', 'saved_items', 'runs', 'edelweiss_ledger', 'ai_jobs'] loop
    execute format('drop policy if exists "2-step when set" on public.%I', t);
    execute format('create policy "2-step when set" on public.%I as restrictive for all to authenticated using (public.aal_ok()) with check (public.aal_ok())', t);
  end loop;
end;
$body$;

-- 4. Storage caps on saves (the 30 items per account rule stays).
create or replace function public.saved_items_cap() returns trigger language plpgsql as $body$
begin
  if (select count(*) from public.saved_items where user_id = new.user_id) >= 30 then
    raise exception 'You can keep 30 saved items: delete some to save new ones' using errcode = 'P0001';
  end if;
  if (select coalesce(sum(octet_length(data::text)), 0) from public.saved_items where user_id = new.user_id) + octet_length(new.data::text) > 15728640 then
    raise exception 'Your saves are full (15 MB): delete some to save new ones' using errcode = 'P0001';
  end if;
  if pg_total_relation_size('public.saved_items') > 314572800 then
    raise exception 'Online saving is full for now: please try again later' using errcode = 'P0001';
  end if;
  return new;
end;
$body$;
