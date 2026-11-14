-- Synthetic players and rooms only. All database changes roll back.
begin;

do $lobby_invite_smoke$
declare
  suffix text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  sender_id uuid := gen_random_uuid();
  recipient_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  fourth_id uuid := gen_random_uuid();
  sender_name text := 'InviteA' || suffix;
  recipient_name text := 'InviteB' || suffix;
  other_name text := 'InviteC' || suffix;
  fourth_name text := 'InviteD' || suffix;
  guest_name text := 'Guest' || suffix;
  guest_proof text := 'gproof:' || encode(extensions.gen_random_bytes(32), 'hex');
  guest_id text := private.guest_identity_from_proof(guest_proof);
  protocol_headers jsonb := '{"x-client-info":"nardu-fair-dice-v36 nardu-fair-dice-v37"}';
  active_protocol text;
  fair_dice_enabled boolean;
  targets jsonb;
  inbox jsonb;
  reply jsonb;
  target_key text;
  invite_id uuid;
  invitation_code text;
  initial_epoch uuid;
  rejected boolean;
  changed_count integer;
begin
  select enabled, protocol into fair_dice_enabled, active_protocol from private.fair_dice_settings where singleton;
  insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values
    (sender_id, 'authenticated', 'authenticated', sender_name || '@example.invalid', jsonb_build_object('nickname', sender_name), now(), now()),
    (recipient_id, 'authenticated', 'authenticated', recipient_name || '@example.invalid', jsonb_build_object('nickname', recipient_name), now(), now()),
    (other_id, 'authenticated', 'authenticated', other_name || '@example.invalid', jsonb_build_object('nickname', other_name), now(), now()),
    (fourth_id, 'authenticated', 'authenticated', fourth_name || '@example.invalid', jsonb_build_object('nickname', fourth_name), now(), now());
  insert into public.guest_presence (id, name, last_seen_at) values (guest_id, guest_name, now());

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', sender_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', sender_id)::text, true);
  perform set_config('request.headers', protocol_headers::text, true);
  targets := public.list_lobby_invite_targets();
  select row->>'invite_target' into target_key from jsonb_array_elements(targets) row where row->>'nickname' = recipient_name;
  if target_key is null or not exists (
    select 1 from jsonb_array_elements(targets) row
    where row->>'nickname' = recipient_name and (row->>'can_invite')::boolean is true
  ) or exists (
    select 1 from jsonb_array_elements(targets) row
    where row ?| array['id', 'guest_id', 'email', 'last_seen_at', 'proof']
  ) then
    raise exception 'Invite target projection did not identify the online recipient safely.';
  end if;

  rejected := false;
  begin
    perform public.send_lobby_game_invitation(target_key, 'unknown');
  exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise exception 'An unsupported game variant was accepted.'; end if;

  rejected := false;
  begin
    perform public.send_lobby_game_invitation(recipient_name, 'long');
  exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise exception 'A nickname was accepted as an invitation target.'; end if;

  reply := public.send_lobby_game_invitation(target_key, 'long');
  invite_id := (reply->>'id')::uuid;
  invitation_code := reply->>'room_code';
  select room.fair_dice_game_id into initial_epoch from public.rooms room
  where room.code = invitation_code and room.host_user_id = sender_id and room.guest_user_id is null
    and room.status = 'waiting' and room.variant = 'long' and room.access = 'closed'
    and room.password_hash is not null and not room.allow_spectators
    and room.game_state is null and room.game_version = 0
    and room.fair_dice_required = fair_dice_enabled and room.fair_dice_protocol = active_protocol;
  if invite_id is null or initial_epoch is null then
    raise exception 'Sending did not create one ordinary closed waiting room with the current dice policy.';
  end if;

  rejected := false;
  begin
    perform public.send_lobby_game_invitation(target_key, 'short');
  exception when unique_violation then rejected := true; end;
  if not rejected then raise exception 'A sender was allowed a second active room.'; end if;

  perform set_config('request.jwt.claim.sub', other_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', other_id)::text, true);
  inbox := public.list_lobby_game_invitations();
  if inbox->'incoming' @> jsonb_build_array(jsonb_build_object('id', invite_id))
     or inbox->'outgoing' @> jsonb_build_array(jsonb_build_object('id', invite_id)) then
    raise exception 'An unrelated player could read the invitation.';
  end if;
  rejected := false;
  begin
    reply := public.answer_lobby_game_invitation(invite_id, true);
    rejected := reply->>'room_code' is distinct from invitation_code;
  exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise exception 'An unrelated player accepted the invitation.'; end if;

  perform set_config('request.jwt.claim.sub', recipient_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', recipient_id)::text, true);
  inbox := public.list_lobby_game_invitations();
  if not inbox->'incoming' @> jsonb_build_array(jsonb_build_object('id', invite_id, 'nickname', sender_name, 'variant', 'long')) then
    raise exception 'The intended player did not receive the long invitation.';
  end if;
  begin
    update public.rooms room set status = 'joined', guest_user_id = recipient_id, guest_name = recipient_name, guest_registered = true
    where room.code = invitation_code;
    get diagnostics changed_count = row_count;
  exception when insufficient_privilege then changed_count := 0; end;
  if changed_count <> 0 then raise exception 'Direct room update bypassed invitation acceptance.'; end if;

  reply := public.answer_lobby_game_invitation(invite_id, true);
  if reply->>'room_code' is distinct from invitation_code or not exists (
    select 1 from public.rooms room where room.code = invitation_code and room.status = 'joined'
      and room.host_user_id = sender_id and room.guest_user_id = recipient_id
      and room.fair_dice_game_id = initial_epoch and room.game_version = 0 and room.game_state is null
      and (not room.fair_dice_required or (room.presence ?& array['white', 'dark'] and room.joined_at is not null))
  ) then
    raise exception 'Accepting did not join the standard room with the same fair-dice epoch.';
  end if;
  reply := public.answer_lobby_game_invitation(invite_id, true);
  if reply->>'room_code' is distinct from invitation_code then
    raise exception 'Retrying acceptance did not return the same room.';
  end if;

  perform set_config('request.jwt.claim.sub', other_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', other_id)::text, true);
  targets := public.list_lobby_invite_targets();
  select row->>'invite_target' into target_key from jsonb_array_elements(targets) row where row->>'nickname' = guest_name;
  reply := public.send_lobby_game_invitation(target_key, 'short');
  invite_id := (reply->>'id')::uuid;
  invitation_code := reply->>'room_code';

  execute 'set local role anon';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.headers', (protocol_headers || jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', 'gproof:' || repeat('0', 64)))::text, true);
  rejected := false;
  begin
    inbox := public.list_lobby_game_invitations();
    rejected := not inbox->'incoming' @> jsonb_build_array(jsonb_build_object('id', invite_id));
  exception when insufficient_privilege then rejected := true; end;
  if not rejected then raise exception 'A guest ID without its matching proof read the invitation.'; end if;

  perform set_config('request.headers', (protocol_headers || jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', guest_proof))::text, true);
  inbox := public.list_lobby_game_invitations();
  if not inbox->'incoming' @> jsonb_build_array(jsonb_build_object('id', invite_id, 'nickname', other_name, 'variant', 'short')) then
    raise exception 'The verified guest did not receive the short invitation.';
  end if;
  perform public.answer_lobby_game_invitation(invite_id, false);
  inbox := public.list_lobby_game_invitations();
  if inbox->'incoming' @> jsonb_build_array(jsonb_build_object('id', invite_id)) then
    raise exception 'The declined invitation remained pending in the guest inbox.';
  end if;
  if not exists (select 1 from public.rooms room where room.code = invitation_code and room.status = 'waiting'
    and room.variant = 'short' and room.guest_guest_id is null and room.guest_user_id is null) then
    raise exception 'Declining an invitation seated a player or changed the room improperly.';
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', other_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', other_id)::text, true);
  perform set_config('request.headers', protocol_headers::text, true);
  inbox := public.list_lobby_game_invitations();
  if not inbox->'outgoing' @> jsonb_build_array(jsonb_build_object('id', invite_id, 'variant', 'short', 'status', 'declined', 'room_code', invitation_code)) then
    raise exception 'The host could not see the declined invitation.';
  end if;

  perform set_config('request.jwt.claim.sub', fourth_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', fourth_id)::text, true);
  reply := public.send_lobby_game_invitation(target_key, 'short');
  invite_id := (reply->>'id')::uuid;
  invitation_code := reply->>'room_code';

  execute 'set local role anon';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.headers', (protocol_headers || jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', guest_proof))::text, true);
  reply := public.answer_lobby_game_invitation(invite_id, true);
  if reply->>'room_code' is distinct from invitation_code or not exists (
    select 1 from public.rooms room where room.code = invitation_code and room.status = 'joined'
      and room.variant = 'short' and room.host_user_id = fourth_id and room.guest_guest_id = guest_id
      and room.guest_user_id is null and not room.guest_registered
  ) then
    raise exception 'The verified guest did not join as the intended short-game opponent.';
  end if;
end;
$lobby_invite_smoke$;

rollback;
