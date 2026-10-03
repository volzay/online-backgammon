-- Install after schema.sql. Guards new rating awards; historical correction is
-- deliberately separate and requires an audited, room-specific transaction.
begin;
set local lock_timeout = '5s';

create or replace function public.guard_rating_event_participant()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  rating_room public.rooms%rowtype;
  player_color text;
  game_finished_at text := coalesce(new.score #>> '{finalState,finishedAt}', '');
  matching_result boolean := false;
begin
  if coalesce(new.mode, '') not in ('remote', 'bot')
     or coalesce(trim(new.score->>'roomCode'), '') = ''
     or game_finished_at = '' then
    raise exception 'A completed room result is required for rating.' using errcode = '22023';
  end if;

  select * into rating_room
  from public.rooms
  where code = upper(trim(new.score->>'roomCode'));
  if not found then
    raise exception 'Rated room was not found.' using errcode = 'P0002';
  end if;

  if new.mode = 'remote' then
    if coalesce(rating_room.game_state->>'mode', '') = 'bot'
       or coalesce(rating_room.game_state #>> '{analysis,mode}', '') = 'bot' then
      raise exception 'This is not a two-player room.' using errcode = '22023';
    end if;
    if rating_room.host_user_id = new.user_id then
      player_color := 'white';
    elsif rating_room.guest_user_id = new.user_id then
      player_color := 'dark';
    end if;
  else
    if rating_room.host_user_id = new.user_id
       and rating_room.guest_user_id is null
       and (coalesce(rating_room.game_state->>'mode', '') = 'bot'
         or coalesce(rating_room.game_state #>> '{analysis,mode}', '') = 'bot') then
      player_color := case
        when rating_room.game_state #>> '{analysis,playerColor}' = 'dark' then 'dark'
        else 'white'
      end;
    end if;
  end if;

  if player_color is null then
    raise exception 'Only room players can receive a rating result.' using errcode = '42501';
  end if;
  if new.winner not in ('white', 'dark')
     or new.did_win is distinct from (new.winner = player_color) then
    raise exception 'Rating result does not match the player seat.' using errcode = '22023';
  end if;
  if new.result_key <> concat(game_finished_at, ':', new.winner, ':',
       coalesce(nullif(new.result_type, ''), 'normal')) then
    raise exception 'Rating result key does not match the room.' using errcode = '22023';
  end if;

  matching_result := coalesce(rating_room.game_state->>'phase', '') = 'over'
    and rating_room.game_state->>'winner' = new.winner
    and rating_room.game_state->>'finishedAt' = game_finished_at
    and coalesce(nullif(rating_room.game_state->>'resultType', ''), 'normal')
      = coalesce(nullif(new.result_type, ''), 'normal');
  if not matching_result then
    select exists (
      select 1 from public.room_game_archives archive
      where archive.room_id = rating_room.id
        and archive.final_state->>'phase' = 'over'
        and archive.final_state->>'winner' = new.winner
        and archive.final_state->>'finishedAt' = game_finished_at
        and coalesce(nullif(archive.final_state->>'resultType', ''), 'normal')
          = coalesce(nullif(new.result_type, ''), 'normal')
    ) into matching_result;
  end if;
  if not matching_result then
    raise exception 'The completed game has not been saved.' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_rating_event_participant_trg on public.rating_events;
create trigger guard_rating_event_participant_trg
before insert on public.rating_events
for each row execute function public.guard_rating_event_participant();

drop policy if exists "users can insert own rating events" on public.rating_events;
revoke insert on public.rating_events from authenticated;

create or replace function public.guard_profile_rating_write()
returns trigger
language plpgsql
set search_path = public, auth
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.rating := 1000;
      new.tier := 'Bronze';
      new.rating_eligible := true;
    elsif (new.rating, new.tier, new.rating_eligible)
       is distinct from (old.rating, old.tier, old.rating_eligible) then
      raise exception 'Rating is managed by the game server.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_rating_write_trg on public.profiles;
create trigger guard_profile_rating_write_trg
before insert or update on public.profiles
for each row execute function public.guard_profile_rating_write();

create or replace function public.touch_room_spectator(
  p_code text,
  p_spectator_id text,
  p_spectator_name text,
  p_leave boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Z0-9-]', '', 'g'));
  safe_key text := regexp_replace(coalesce(nullif(p_spectator_id, ''), auth.uid()::text, gen_random_uuid()::text), '[^A-Za-z0-9_-]', '_', 'g');
  clean_name text := left(coalesce(nullif(trim(p_spectator_name), ''), 'Spectator'), 32);
  current_spectators jsonb := '{}'::jsonb;
  active_spectators jsonb := '{}'::jsonb;
  next_spectators jsonb := '{}'::jsonb;
  cutoff_at timestamptz := now() - interval '45 seconds';
  room_allow boolean := false;
  room_status text := '';
  next_count integer := 0;
begin
  select coalesce(r.spectators, '{}'::jsonb), r.allow_spectators, r.status
    into current_spectators, room_allow, room_status
  from public.rooms r
  where r.code = clean_code
  for update;

  if not found then
    raise exception 'Комната не найдена.';
  end if;

  -- Closing an over room must not trap an existing spectator in its ledger.
  if not p_leave and (not room_allow or room_status <> 'joined') then
    raise exception 'Просмотр этой комнаты недоступен.';
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    into active_spectators
  from jsonb_each(current_spectators)
  where coalesce((value->>'lastSeen')::timestamptz, 'epoch'::timestamptz) >= cutoff_at;

  if p_leave then
    next_spectators := active_spectators - safe_key;
  else
    next_spectators := jsonb_set(
      active_spectators,
      array[safe_key],
      jsonb_build_object('name', clean_name, 'lastSeen', now()),
      true
    );
  end if;

  select count(*)::integer into next_count from jsonb_each(next_spectators);

  update public.rooms r
  set spectators = next_spectators
  where r.code = clean_code;

  return next_count;
end;
$$;

revoke all on function public.touch_room_spectator(text, text, text, boolean) from public;
grant execute on function public.touch_room_spectator(text, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
