\set ON_ERROR_STOP on
-- Synthetic fixture only: never run against the application database.
do $$begin if current_database() !~ '^codex_admin_retention_' then raise exception 'An isolated codex_admin_retention_ fixture database is required';end if;end$$;
create schema private;
create schema auth;
create function auth.uid() returns uuid language sql as $$select '00000000-0000-0000-0000-000000000aaa'::uuid$$;
create function public.is_admin_user() returns boolean language sql stable as $$select current_setting('codex.test_admin',true)='yes'$$;
create table public.rooms(id uuid primary key, status text, game_state jsonb default '{}', archived_at timestamptz, updated_at timestamptz, created_at timestamptz);
create table public.room_game_archives(id uuid primary key, room_id uuid references public.rooms(id) on delete cascade, completed_at timestamptz);
create table public.admin_audit(actor_user_id uuid, action text, details jsonb);
