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
