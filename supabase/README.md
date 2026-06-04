# Supabase Setup

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `schema.sql`.
4. In Authentication, enable Email signups.
5. In Realtime settings, verify Realtime is enabled.
6. Copy the project URL and anon/publishable key.
7. Add them to Cloudflare Pages:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`

The browser must only receive the public anon/publishable key. Never expose the `service_role` key in `runtime-config.js`, Cloudflare Pages public environment variables, or frontend code.
