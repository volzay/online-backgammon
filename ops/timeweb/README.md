# Timeweb Operations

Production backend:

- host: `201.51.7.193`
- project: `/opt/online-backgammon-supabase`
- public API: `https://api.201-51-7-193.sslip.io`

## Health check

```sh
sudo /usr/local/sbin/online-backgammon-healthcheck
```

The check verifies Docker health states and the HTTPS Auth gateway response.

## Database backup

```sh
sudo /usr/local/sbin/online-backgammon-backup
```

Daily backups are stored in `/var/backups/online-backgammon` and retained for
14 days. Copy them off the VPS for disaster recovery.

## Stack commands

```sh
cd /opt/online-backgammon-supabase
sh run.sh start
sh run.sh stop
docker compose ps
```

`docker-compose.production.yml` binds the Postgres pooler to localhost so ports
5432 and 6543 are not exposed to the Internet. Keep it in `COMPOSE_FILE` before
the Caddy override:

```text
COMPOSE_FILE=docker-compose.yml:docker-compose.production.yml:docker-compose.caddy.yml
```

Do not publish `.env`, the Postgres password, dashboard password, secret key,
legacy service-role key, or database dumps.

## Admin transport — 19 October 2026

The self-hosted authentication stack still uses the Supabase SDK internally;
this is not a connection to the former Supabase cloud project. Do not remove
the SDK or change accounts to repair a network timeout.

The additional admin-only hostname
`api.201-51-7-193.2a03-6f00-a--ae1e.sslip.io` resolves to the existing VPS
over both IPv4 and IPv6. `admin-dual-stack.caddy` retains the original portal
hostname, API routes and dashboard basic authentication. The installer validates
the candidate, saves a private original and reloads Caddy gracefully, restoring
the original on reload failure. It was applied on 19 October; its backup is
`/var/backups/online-backgammon/Caddyfile-before-admin-dual-stack-20261019`.
Do not rerun the installer over that backup.

Pages uses the additional hostname only on `#admin-app`, retaining the original
authentication storage key. Player endpoints and tokens are not migrated.
Custom `SUPABASE_URL` builds do not inherit this production alias unless
`ADMIN_API_URL` is explicitly provided.

An IPv6-forced HTTPS check passed with a valid certificate; an unauthenticated
gateway 401 is a connectivity check, **not** proof of administrator sign-in.
The external IPv4 path still timed out from the diagnostic network. Although
public DNS returned AAAA, this Mac's system resolver returned only IPv4 even
for the dual-stack hostname. A VPN/DNS filter can therefore defeat automatic
IPv6 selection. Verify ordinary browser access and actual sign-in from the
administrator's network; do not disable TLS, reset passwords or weaken server
authorization to work around transport failure.
