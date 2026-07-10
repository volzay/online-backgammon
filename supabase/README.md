# Self-hosted Supabase Setup

The production backend is a self-hosted Supabase stack on Timeweb Cloud.

- Public API URL: `https://api.201-51-7-193.sslip.io`
- Frontend URL: `https://volzay.github.io/online-backgammon/`
- Server project directory: `/opt/online-backgammon-supabase`
- Application schema: `supabase/schema.sql`

The GitHub Pages frontend uses the self-hosted stack for Auth, Postgres, RPC,
RLS, Realtime, presence, rooms, game-state sync, chat, ratings, and the admin
surface. Local development still falls back to `server.js` when
`runtime-config.js` contains empty backend values.

The browser must only receive the publishable key. Never expose the secret or
legacy `service_role` key in `runtime-config.js`, GitHub Actions, or frontend
code.

## Apply schema updates

Copy `supabase/schema.sql` to the server and run it against the database:

```sh
docker cp schema.sql supabase-db:/tmp/online-backgammon-schema.sql
docker exec supabase-db psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  -U postgres -d postgres \
  -f /tmp/online-backgammon-schema.sql
```

## Runtime configuration

The production URL and publishable key are set in
`.github/workflows/pages.yml`. Auth must keep email login enabled because
nickname accounts authenticate through an internal synthetic email generated
by `register_nickname_user`; the public registration form still asks only for a
nickname and password.

See `ops/timeweb/README.md` for server operation, health checks, and backups.
