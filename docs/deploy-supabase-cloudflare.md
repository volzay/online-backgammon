# Supabase Realtime + Cloudflare Pages

This project can be moved from the local `server.js` API to a static frontend on Cloudflare Pages backed by Supabase Auth, Postgres, and Realtime.

## What Is Needed

From Supabase:

- Supabase project URL, for example `https://xxxxx.supabase.co`.
- Public anon or publishable key for the browser.
- Access to SQL Editor to run `supabase/schema.sql`.
- Auth enabled with Email provider.
- Realtime enabled for the project.

From Cloudflare:

- Cloudflare account with Pages.
- GitHub connection to `volzay/online-backgammon`.
- Pages project environment variables:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
- Build command: `npm run build`.
- Build output directory: `dist`.

Do not put the Supabase `service_role` key in browser code or Cloudflare Pages public variables.

## Current Status

The repository now includes:

- `supabase/schema.sql` - initial Supabase schema for profiles, friends, rooms, game state, room chat, presence, rating events, and Realtime publication.
- `runtime-config.js` - local placeholder for public runtime config.
- `supabase-client.js` - lazy browser helper for Supabase JS and Realtime channels.
- `scripts/build-cloudflare-pages.js` - static build that writes `dist/` for Cloudflare Pages.
- `wrangler.toml` - Pages output directory config.

The UI is not fully switched to Supabase yet. Existing pages still call `/api/*` when they need online features. The next implementation step is replacing those calls with Supabase Auth/Postgres/Realtime operations.

## Migration Order

1. Auth:
   - Replace `/api/register` with `supabase.auth.signUp`.
   - Insert profile row into `public.profiles`.
   - Replace `/api/login` with `supabase.auth.signInWithPassword`.
   - Keep the current local user shape in `NarduApp.setUser`.

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
   - Decide whether to keep a separate admin surface, move it to Supabase dashboard, or implement Cloudflare Pages Functions with a private Supabase service role key.

## Notes

- Supabase Realtime supports Broadcast, Presence, and Postgres Changes. Supabase recommends Broadcast for scalable and secure realtime subscriptions.
- Cloudflare Pages hosts static assets; it does not run the current `server.js`.
- The free Supabase plan is suitable for MVP testing, but production should add server-side validation for moves and stricter RLS policies.
