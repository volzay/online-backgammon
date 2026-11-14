begin;

-- Older clients still write presence directly during profile recovery and
-- account or room activity. Normalize those writes to the same server clock.
create or replace function private.stamp_lobby_presence()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.last_seen_at := clock_timestamp();
  end if;
  return new;
end;
$$;

revoke all on function private.stamp_lobby_presence() from public, anon, authenticated, service_role;

drop trigger if exists profiles_lobby_presence_server_clock on public.profiles;
create trigger profiles_lobby_presence_server_clock
  before insert or update of last_seen_at on public.profiles
  for each row execute function private.stamp_lobby_presence();

drop trigger if exists guest_presence_server_clock on public.guest_presence;
create trigger guest_presence_server_clock
  before insert or update of last_seen_at on public.guest_presence
  for each row execute function private.stamp_lobby_presence();

create or replace function public.touch_lobby_presence()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if auth.role() = 'authenticated' then
    update public.profiles
    set last_seen_at = clock_timestamp()
    where id = auth.uid() and banned_at is null;
    return found;
  end if;

  if auth.role() = 'anon' then
    update public.guest_presence
    set last_seen_at = clock_timestamp()
    where id = public.request_guest_identity();
    return found;
  end if;

  return false;
end;
$$;

revoke all on function public.touch_lobby_presence() from public, anon, authenticated, service_role;
grant execute on function public.touch_lobby_presence() to anon, authenticated;

notify pgrst, 'reload schema';
commit;
