# Supabase Realtime + GitHub Pages

This project is moving from the local `server.js` API to a static frontend on GitHub Pages backed by Supabase Auth, Postgres, and Realtime.

## Supabase Project

Configured public values:

- Supabase URL: `https://pzknykygxtbzdhuitzzh.supabase.co`
- Browser publishable key: configured in the GitHub Pages build workflow.
- GitHub Pages URL: `https://volzay.github.io/online-backgammon/`

The publishable key is safe to expose in browser code. Never expose the Supabase `service_role` key in GitHub Actions, `runtime-config.js`, or frontend code.

## What Is Needed

From Supabase:

- Access to SQL Editor to run `supabase/schema.sql`.
- Auth enabled with Email provider.
- Realtime enabled for the project.
- Auth URL Configuration updated with:
  - Site URL: `https://volzay.github.io/online-backgammon`
  - Redirect URL: `https://volzay.github.io/online-backgammon/login.html`

From GitHub:

- Repository: `volzay/online-backgammon`.
- GitHub Pages enabled for this repository.
- Source: **GitHub Actions**.
- Workflow: `.github/workflows/pages.yml`.

The workflow runs:

```text
npm ci
npm run build
```

It uploads `dist/` to GitHub Pages.

## Current Status

The repository includes:

- `supabase/schema.sql` - initial Supabase schema for profiles, friends, rooms, game state, room chat, presence, rating events, and Realtime publication.
- `runtime-config.js` - local placeholder for public runtime config.
- `supabase-client.js` - lazy browser helper for Supabase JS and Realtime channels.
- `auth-client.js` - login/register/recovery helper with Supabase support and local `/api/*` fallback.
- `rooms-client.js` - lobby rooms, room lifecycle, game-state sync, presence, and room chat with Supabase support and local `/api/rooms/*` fallback.
- `scripts/build-github-pages.js` - static build that writes `dist/` for GitHub Pages.
- `.github/workflows/pages.yml` - GitHub Actions deployment workflow.

Login, registration, lobby rooms, remote game state, presence, and room chat can use Supabase when the generated `runtime-config.js` contains Supabase settings. The account settings and admin surface still use the local server path and need separate migration work.

## Migration Order

1. Auth:
   - Done: `/api/register` fallback plus `supabase.auth.signUp`.
   - Done: `auth.users` trigger creates `public.profiles` rows.
   - Done: `/api/login` fallback plus `supabase.auth.signInWithPassword`.
   - Current Supabase limitation: sign-in uses email, not nickname. Nickname sign-in still works on the local `server.js` backend.

2. Lobby and rooms:
   - Done: `GET /api/rooms` fallback plus `rooms` query.
   - Done: `POST /api/rooms` fallback plus room insert.
   - Done: `POST /api/rooms/:code/join` fallback plus room update.
   - Current implementation polls the room rows; Realtime subscriptions can be added later for lower latency.

3. Game state:
   - Done: `GET /api/rooms/:code/game` fallback plus `rooms.game_state` read.
   - Done: `PUT /api/rooms/:code/game` fallback plus `rooms` update.
   - Current implementation keeps the existing polling rhythm; Realtime Broadcast or Postgres changes can replace it later.

4. Chat and presence:
   - Done: room chat fallback plus `room_messages` rows.
   - Done: heartbeat fallback plus `rooms.presence` JSON.
   - Later: use Supabase Realtime Presence per `room:<CODE>` channel and Broadcast for fast transient events.

5. Account settings:
   - Replace `/api/account/*` with `profiles`, `friend_requests`, `friendships`, and `friend_messages`.

6. Admin:
   - Decide whether to keep a separate admin surface, move it to Supabase dashboard, or implement server-side GitHub Pages-adjacent functions elsewhere.

## GitHub Pages Setup

1. Open GitHub repository settings.
2. Go to **Pages**.
3. Select **Build and deployment** source: **GitHub Actions**.
4. Push to `main` or run **Deploy GitHub Pages** manually from Actions.
5. Open the generated Pages URL.

## Supabase Auth URL Setup

In Supabase Dashboard, open **Authentication -> URL Configuration** and set:

```text
Site URL:
https://volzay.github.io/online-backgammon

Redirect URLs:
https://volzay.github.io/online-backgammon/login.html
http://localhost:4177/login.html
```

The local URL is optional, but useful while testing Supabase Auth from the local dev server.

## Notes

- GitHub Pages hosts static assets; it does not run the current `server.js`.
- Supabase Realtime supports Broadcast, Presence, and Postgres Changes. Supabase recommends Broadcast for scalable and secure realtime subscriptions.
- Closed room passwords in the Supabase path are stored as SHA-256 hashes in `rooms.password_hash`; production should move room creation/joining to server-side RPC or Edge Functions for stricter validation.
- The free Supabase plan is suitable for MVP testing, but production should add server-side validation for moves and stricter RLS policies.
