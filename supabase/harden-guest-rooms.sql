-- Apply this idempotent migration when the full schema cannot be re-run.
-- It validates every changed game state at the database boundary.

create or replace function public.validate_room_game_state()
returns trigger
language plpgsql
as $$
declare
  gs jsonb := new.game_state;
  points jsonb;
  point record;
  white_total integer := 0;
  dark_total integer := 0;
  winner text;
  winner_off integer;
  conceded boolean := false;
  history_item jsonb;
begin
  if gs is null or gs = old.game_state then
    return new;
  end if;

  if new.game_version <= old.game_version then
    raise exception 'game_version must increase when game_state changes (old=%, new=%)',
      old.game_version, new.game_version;
  end if;

  points := gs->'points';
  if points is null or jsonb_typeof(points) <> 'object' then
    raise exception 'game_state.points must be an object';
  end if;
  if coalesce(gs#>>'{off,white}', '') !~ '^[0-9]+$'
     or coalesce(gs#>>'{off,dark}', '') !~ '^[0-9]+$'
     or coalesce(gs#>>'{bar,white}', '') !~ '^[0-9]+$'
     or coalesce(gs#>>'{bar,dark}', '') !~ '^[0-9]+$' then
    raise exception 'off and bar checker counts must be non-negative integers';
  end if;

  for point in select key, value from jsonb_each(points) loop
    if point.key !~ '^[0-9]+$'
       or point.key::integer not between 1 and 24
       or jsonb_typeof(point.value) <> 'object'
       or point.value->>'color' not in ('white', 'dark')
       or coalesce(point.value->>'count', '') !~ '^[1-9][0-9]*$' then
      raise exception 'invalid point entry at %', point.key;
    end if;
    if point.value->>'color' = 'white' then
      white_total := white_total + (point.value->>'count')::integer;
    else
      dark_total := dark_total + (point.value->>'count')::integer;
    end if;
  end loop;

  white_total := white_total
    + (gs#>>'{off,white}')::integer
    + (gs#>>'{bar,white}')::integer;
  dark_total := dark_total
    + (gs#>>'{off,dark}')::integer
    + (gs#>>'{bar,dark}')::integer;
  if white_total <> 15 or dark_total <> 15 then
    raise exception 'board integrity violation (white=%, dark=%)', white_total, dark_total;
  end if;

  winner := gs->>'winner';
  if winner is not null and winner not in ('white', 'dark') then
    raise exception 'invalid winner color';
  end if;
  if winner in ('white', 'dark') then
    winner_off := (gs #>> array['off', winner])::integer;
    conceded := gs->'networkLoss' is not null
      and gs->'networkLoss' not in ('false'::jsonb, 'null'::jsonb);
    if not conceded and jsonb_typeof(gs->'history') = 'array' then
      for history_item in select value from jsonb_array_elements(gs->'history') loop
        if (history_item->'resign' is not null and history_item->'resign' not in ('false'::jsonb, 'null'::jsonb))
           or (history_item->'networkLoss' is not null and history_item->'networkLoss' not in ('false'::jsonb, 'null'::jsonb))
           or (history_item->'leave' is not null and history_item->'leave' not in ('false'::jsonb, 'null'::jsonb))
           or (history_item->'timeout' is not null and history_item->'timeout' not in ('false'::jsonb, 'null'::jsonb)) then
          conceded := true;
          exit;
        end if;
      end loop;
    end if;
    if winner_off <> 15 and not conceded then
      raise exception 'declared win is not supported by the board position';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_room_game_state_trg on public.rooms;
create trigger validate_room_game_state_trg
before update on public.rooms
for each row
when (new.game_state is distinct from old.game_state)
execute function public.validate_room_game_state();
