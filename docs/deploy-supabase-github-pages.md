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
- `scripts/build-github-pages.js` - static build that writes `dist/` for GitHub Pages.
- `.github/workflows/pages.yml` - GitHub Actions deployment workflow.

The UI is not fully switched to Supabase yet. Login and registration can use Supabase when the generated `runtime-config.js` contains Supabase settings; other online features still call `/api/*`.

## Migration Order

1. Auth:
   - Done: `/api/register` fallback plus `supabase.auth.signUp`.
   - Done: `auth.users` trigger creates `public.profiles` rows.
   - Done: `/api/login` fallback plus `supabase.auth.signInWithPassword`.
   - Current Supabase limitation: sign-in uses email, not nickname. Nickname sign-in still works on the local `server.js` backend.

2. Lobby and rooms:
   - Replace `GET /api/rooms` with a `rooms` query.
   - Replace `POST /api/rooms` with a room insert.
   - Replace `POST /api/rooms/:code/join` with a room update.
   - Subscribe to `rooms` changes through Realtime.

3. Game state:
   - Replace `GET /api/rooms/:code/game` with a `rooms.game_state` read.
   - Replace `PUT /api/rooms/:code/game` with a `rooms` update.
   - Use Realtime Broadcast or Postgres changes on `rooms` for low-latency updates.

4. Chat and presence:
   - Replace room chat endpoints with `room_messages`.
   - Use Supabase Realtime Presence per `room:<CODE>` channel.
   - Use Broadcast for fast transient events and Postgres rows for durable chat history.

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
- The free Supabase plan is suitable for MVP testing, but production should add server-side validation for moves and stricter RLS policies.
