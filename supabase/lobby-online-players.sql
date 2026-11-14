begin;

alter table public.profiles
  add column if not exists show_rating_in_lobby boolean;

create index if not exists profiles_lobby_last_seen_idx
  on public.profiles (last_seen_at)
  where banned_at is null and last_seen_at is not null;

create index if not exists guest_presence_lobby_last_seen_idx
  on public.guest_presence (last_seen_at);

-- PostgREST's guest heartbeat updates use an id filter. PostgreSQL also
-- requires read access to that column for the filter.
drop policy if exists "guests can identify own presence" on public.guest_presence;
create policy "guests can identify own presence"
on public.guest_presence for select
to anon
using (id = public.request_guest_identity());

revoke select on public.guest_presence from anon;
grant select (id) on public.guest_presence to anon;

create or replace function public.list_lobby_online_players()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  seen_after timestamptz := now() - interval '90 seconds';
  seen_before timestamptz := now() + interval '15 seconds';
  result jsonb;
begin
  if auth.uid() is null and public.request_guest_identity() is null then
    raise exception 'Player session required.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'nickname', online.nickname,
    'rating', online.rating,
    'guest', online.guest
  ) order by online.guest, online.rating desc nulls last, lower(online.nickname), online.nickname), '[]'::jsonb)
  into result
  from (
    select p.nickname,
      case when p.rating_eligible and p.show_rating_in_lobby is true then p.rating end as rating,
      false as guest
    from public.profiles p
    where p.banned_at is null and p.last_seen_at between seen_after and seen_before

    union all

    select g.name, null::integer, true
    from public.guest_presence g
    where g.id ~ '^guest:sha256:[0-9a-f]{64}$'
      and g.last_seen_at between seen_after and seen_before
  ) online;

  return result;
end;
$$;

revoke all on function public.list_lobby_online_players() from public, anon, authenticated;
grant execute on function public.list_lobby_online_players() to anon, authenticated;

create or replace function public.set_lobby_rating_visibility(p_visible boolean, p_initialize boolean default false)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  player_id uuid := auth.uid();
  visible boolean;
begin
  if player_id is null then
    raise exception 'Registered player session required.' using errcode = '42501';
  end if;
  if p_visible is null or p_initialize is null then
    raise exception 'Rating visibility must be a boolean.' using errcode = '22023';
  end if;

  update public.profiles p
  set show_rating_in_lobby = p_visible
  where p.id = player_id
    and (not p_initialize or p.show_rating_in_lobby is null)
    and p.show_rating_in_lobby is distinct from p_visible;

  select p.show_rating_in_lobby into visible from public.profiles p where p.id = player_id;
  return visible;
end;
$$;

revoke all on function public.set_lobby_rating_visibility(boolean, boolean) from public, anon, authenticated;
grant execute on function public.set_lobby_rating_visibility(boolean, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
