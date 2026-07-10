# Self-hosted Supabase + GitHub Pages

The project uses two independent hosting layers:

- GitHub Pages serves the static frontend at
  `https://volzay.github.io/online-backgammon/`.
- Timeweb Cloud runs the self-hosted Supabase-compatible backend at
  `https://api.201-51-7-193.sslip.io`.

No production request needs the managed Supabase platform.

## GitHub Pages build

`.github/workflows/pages.yml` runs:

```text
npm ci
npm run build
```

The build writes the backend URL, browser publishable key, and site URL to the
generated `dist/runtime-config.js`, then deploys `dist/` with GitHub Actions.

## Backend responsibilities

The Timeweb deployment provides:

- Auth and nickname/password login;
- Postgres tables, functions, triggers, RLS, and RPC;
- Realtime room, game-state, presence, and chat updates;
- ratings, friends, history, bot training data, and admin operations;
- HTTPS termination through Caddy.

The application schema remains versioned in `supabase/schema.sql`. Apply that
file after database restoration and whenever schema functions or policies are
changed.

## Authentication URLs

The self-hosted `.env` must contain:

```text
SUPABASE_PUBLIC_URL=https://api.201-51-7-193.sslip.io
API_EXTERNAL_URL=https://api.201-51-7-193.sslip.io/auth/v1
SITE_URL=https://volzay.github.io/online-backgammon/
ADDITIONAL_REDIRECT_URLS=https://volzay.github.io/online-backgammon/**
```

Email login must remain enabled internally because nickname users sign in with
synthetic email addresses. The UI continues to expose nickname-only
registration.

## Operations

Use the scripts in `ops/timeweb/` for health checks and daily database backups.
Backups stored on the same VPS protect against application mistakes but not a
complete server loss, so a second copy should later be sent to Timeweb Object
Storage or another off-server destination.
