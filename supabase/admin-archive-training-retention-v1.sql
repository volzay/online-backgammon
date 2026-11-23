begin;

-- Training sources outlive the ordinary room-history window. Optional model
-- tables are installed by separate migrations; keep the base schema usable
-- before those channels are installed as well.
create or replace function private.admin_archive_has_training_source(p_archive_id uuid, p_room_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_room_id is not null then
    if to_regclass('public.bot_training_games') is not null then
      if exists(select 1 from public.bot_training_games g where g.room_id = p_room_id) then return true; end if;
    end if;
    if to_regclass('private.long_bot_signed_experience_snapshots') is not null then
      if exists(select 1 from private.long_bot_signed_experience_snapshots s where s.room_id = p_room_id) then return true; end if;
    end if;
  end if;
  if p_archive_id is not null then
    if to_regclass('private.long_bot_board_reviews') is not null then
      if exists(select 1 from private.long_bot_board_reviews r where r.archive_id = p_archive_id) then return true; end if;
    end if;
    if to_regclass('private.long_bot_board_lessons') is not null then
      if exists(select 1 from private.long_bot_board_lessons l where l.archive_id = p_archive_id) then return true; end if;
    end if;
    if to_regclass('private.long_bot_board_turn_reviews') is not null then
      if exists(select 1 from private.long_bot_board_turn_reviews r where r.archive_id = p_archive_id) then return true; end if;
    end if;
    if to_regclass('private.long_bot_loss_lessons') is not null then
      if exists(select 1 from private.long_bot_loss_lessons l where l.archive_id = p_archive_id) then return true; end if;
    end if;
  end if;
  return false;
end;
$$;

revoke all on function private.admin_archive_has_training_source(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.admin_prune_room_archive(max_age_hours integer default 96)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  cutoff_at timestamptz := now() - make_interval(hours => greatest(coalesce(max_age_hours, 96), 1));
  deleted_count integer := 0;
  deleted_games integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  delete from public.room_game_archives a
  where a.completed_at < cutoff_at
    and not private.admin_archive_has_training_source(a.id, a.room_id);

  get diagnostics deleted_games = row_count;

  delete from public.rooms r
  where coalesce(r.archived_at, r.updated_at, r.created_at) < cutoff_at
    and (
      r.status in ('closed', 'over')
      or coalesce(r.game_state->>'phase', '') = 'over'
      or coalesce(r.game_state->>'winner', '') <> ''
      or coalesce(r.game_state->>'finishedAt', '') <> ''
    )
    -- room_game_archives uses ON DELETE CASCADE: retaining an archive also
    -- requires retaining its parent, even when the room timestamp is older.
    and not exists(select 1 from public.room_game_archives a where a.room_id = r.id)
    and not private.admin_archive_has_training_source(null, r.id);

  get diagnostics deleted_count = row_count;
  deleted_count := deleted_count + deleted_games;

  if deleted_count > 0 then
    insert into public.admin_audit (actor_user_id, action, details)
    values (
      auth.uid(),
      'prune-room-archive',
      jsonb_build_object('maxAgeHours', greatest(coalesce(max_age_hours, 96), 1), 'deletedCount', deleted_count)
    );
  end if;

  return deleted_count;
end;
$$;

revoke all on function public.admin_prune_room_archive(integer) from public;
grant execute on function public.admin_prune_room_archive(integer) to authenticated;
notify pgrst, 'reload schema';
commit;
