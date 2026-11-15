# Server and Docker deployment

[简体中文](DOCKER.md)

EasyNote supports both the existing Cloudflare deployment and Docker on an independent Linux server. The server needs no Cloudflare account, token, hosted D1/R2 resources, or Cloudflare network connection. Building an image requires access to npm and the image registry.

## Compatibility and limits

Both deployments run the same `src/worker/index.ts`. The frontend, REST APIs, MCP/OAuth, schema, revisions, idempotency, history, tombstones, tenant isolation, and offline merging use the existing implementation.

| Capability | Cloudflare | Docker |
| --- | --- | --- |
| Worker API | Hosted Worker | Local open-source workerd managed by a locked Miniflare version |
| D1 / FTS5 / batch transactions | Hosted D1 | Persistent SQLite with the same D1 API |
| Images and attachments | Private R2 | Persistent local object storage with the same R2 API |
| Change notifications | Durable Object WebSocket | Local persistent Durable Object WebSocket |
| Cleanup | Cloudflare Cron | Host calls the same scheduled handler at UTC minute 17 each hour |
| Assets and PWA | Assets binding | Same Vite output, SPA fallback, and security headers |

Runtime compatibility avoids reimplementing SQL transactions, R2 streams, and WebSocket semantics. Miniflare was designed for local execution; it does not provide the hosted platform's SLA, distributed scheduling, or high availability. This deployment targets individuals or small teams on one server with one replica. Run only one instance per data directory. Do not share it across replicas or use NFS as shared multi-writer storage. Scaling requires a separate storage and event distribution design.

Authoritative data resides in `/data/state`, including `d1`, `r2`, and `do`. Runtime versions are locked in the npm lockfile. Make a cold backup before upgrading. Do not edit internal SQLite files, object storage layouts, or applied migrations.

## First deployment

Install Docker Engine and Docker Compose v2. Use Linux amd64/arm64, persistent local disk, a domain, and an HTTPS reverse proxy. Run these commands in the `easynote` directory:

```bash
cp .env.docker.example .env
# Edit .env: set PUBLIC_ORIGIN=https://your-domain, without a trailing slash.
# Adjust EASYNOTE_DATA_DIR if needed; these commands use the default.
sudo install -d -m 700 -o 10001 -g 10001 /var/lib/easynote/data
docker compose build
docker compose run --rm easynote node scripts/setup.mjs --docker
docker compose up -d --wait
docker compose logs --tail=100 easynote
```

Setup requires an interactive terminal and hidden password entry. It saves only a salted verifier in `/data/initial-owner.json`. Repeating setup preserves the verifier and does not reset database accounts. The container runs as UID/GID `10001:10001`; grant this user access to the data directory instead of running the container as root.

Compose publishes the application only on host `127.0.0.1:8791`. The health port listens on container loopback and is checked by Docker. Startup opens the ingress only after migrations, owner bootstrap, and a Worker probe succeed. Missing owner configuration or failed migrations prevent startup.

Use `docker compose build --build-arg NODE_OPTIONS=--max-old-space-size=1536` to set the Node heap limit during builds. Leave additional memory for native allocations and other processes. The production dependency stage reuses the builder’s npm cache without including that cache in the runtime image.

### Build frontend artifacts on a build machine

When server memory is limited, run `npm ci --include=dev` and `npm run build` on a development machine or CI using the same source version. Transfer the complete `dist/` directory to the server, then use the prebuilt configuration:

```bash
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml build
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml run --rm easynote node scripts/setup.mjs --docker
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml up -d --wait
```

The server mounts `./dist` read-only by default. Set an absolute `EASYNOTE_DIST_DIR` in `.env` to use another location. This configuration selects the Dockerfile’s `runtime` target. Dependency installation and server execution run inside containers, while frontend compilation runs on the build machine. For upgrades, stop the service, replace the complete `dist/` with artifacts matching the server source, rebuild, and start it.

### HTTPS reverse proxy

This Nginx example assumes an existing certificate and Nginx running on the same host. Replace the domain and certificate paths. Put `map` in the Nginx `http` context:

```nginx
map $http_upgrade $easynote_connection {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name notes.example.com;
    ssl_certificate /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8791;
        proxy_http_version 1.1;
        proxy_set_header Host notes.example.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $easynote_connection;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

`PUBLIC_ORIGIN` must match the browser's HTTPS origin, including any non-default port. It cannot contain a path, credentials, query, or trailing slash. The ingress validates Host and constructs the Worker URL from this configuration, keeping Secure cookies, CSRF, share links, and OAuth/MCP metadata consistent. Runtime control endpoints and `MF-*` headers are isolated from clients.

Set `TRUST_PROXY=true` only behind a trusted proxy that **overwrites** `X-Real-IP`. Otherwise leave it `false`, which rate-limits using socket addresses. Do not publish 8791 to the internet: the application processes internal HTTP using its configured HTTPS origin, and the proxy must actually terminate TLS.

For a local smoke test, use the HTTP loopback configuration at the bottom of `.env.docker.example`. This uses development cookies. Remote browsers, phones, PWA, and normal MCP use require HTTPS. If the reverse proxy also runs in Docker, connect to `easynote:8791` over an isolated Docker network, with a fixed Host and overwritten `X-Real-IP`.

## Configuration

| Setting | Default / meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | Required browser-facing HTTPS origin |
| `EASYNOTE_DATA_DIR` | Compose host path; `/var/lib/easynote/data` |
| `EASYNOTE_PORT` | Host loopback port; `8791` |
| `TRUST_PROXY` | `false`; trust the proxy's overwritten `X-Real-IP` |
| `ALLOW_LOCAL_HTTP` | `false`; only for explicit HTTP loopback origins |
| `INITIAL_OWNER_FILE` | `/data/initial-owner.json` inside the container; may point to a read-only secret |

Limits, version retention, autosave, and rate limits still default to `wrangler.json.vars`. To override one, explicitly add the same name under Compose `environment`, such as `MAX_NOTES: "10000"`. Host environment variables are not automatically passed into the container. Keep `.env`, persistent data, and backups out of Git and image build contexts.

## Migrating from Cloudflare

Sync pending offline drafts on every device and stop source writes during a maintenance window. Use the **current version** of the [disaster recovery commands](DISASTER_RECOVERY.en.md) to create a backup containing accounts, folders, notes, history, shares, tokens, and files. Older backups may omit folders; validation rejects an incomplete schema.

On the new server, prepare `.env`, a fresh data directory, and the image. Mount the backup read-only. Do not start the server or initialize a new owner first:

```bash
docker compose run --rm -v /absolute/path/to/backup:/backup:ro easynote \
  node scripts/server-import.mjs /backup --check
docker compose run --rm -v /absolute/path/to/backup:/backup:ro easynote \
  node scripts/server-import.mjs /backup
docker compose up -d --wait
```

Import checks the schema fingerprint and SHA-256 of the database and every object. It stages data privately, validates foreign keys, closes database handles, then publishes `state`. Failure removes staging data. An existing target `state` is refused. Only application tables are imported; existing triggers rebuild FTS indexes.

Before cutting over the domain, verify login, search, files, history, shares, MCP, and real-time sync between two browsers. Keep the original domain when possible. Changing origin does not transfer browser cookies, IndexedDB drafts, or PWA caches; update MCP client URLs too. Temporary OAuth authorization codes and open WebSockets are not migrated; clients can reconnect or authorize again. Never accept writes on both services after cutover.

## Backup, restore, and upgrade

Back up D1, R2, and DO together. Do not copy a live SQLite file while the server is writing:

```bash
# On the Linux host: verify the mount, stop, archive state, checksum, and restart.
sudo bash scripts/backup.sh
# For custom locations, provide both --data-dir and --backup-dir.
```

Archives contain account verifiers, sessions, notes, and files. Restrict access and keep an off-host copy. The script keeps seven backups by default and refuses to proceed if Docker is unavailable or the bind mount differs. Root-level `backup.sh` / `restore.sh` target Cloudflare/Wrangler, not internal Docker state.

Restore cold backups only with the container stopped. Verify the `.sha256` file, extract `state/` into a **new empty data directory**, assign ownership `10001:10001` with restricted permissions, update `.env`, and start the matching image version. Preserve the old directory until login, file, and sync checks pass. Never overwrite a running directory. Restored database accounts do not need the initial verifier file.

```bash
docker compose stop
# Complete and verify a cold backup, then update the source.
docker compose build
docker compose up -d --wait
```

Upgrades apply pending migrations automatically. Each migration and its ledger entry commit in one transaction. Failure prevents traffic. Unknown or changed migrations prevent startup; rolling back an image may also require restoring its matching full cold backup.

## Validation

```bash
npm run check
npm run build
npm test
npm run test:scripts
npm run test:ui
bash deploy.sh --check
docker compose config --quiet
```

`test/server.test.mjs` runs real server processes with persistent storage, covering HTTPS origins, security headers, CSRF, tenant isolation, idempotency, revisions, files, FTS, shares, MCP, WebSockets, shutdown and restart, migration rollback, and scheduled cleanup. `test/server-import.test.mjs` checks complete backup imports, corrupt objects, and overwrite refusal. These tests do not replace image builds and acceptance checks on the target Linux server.
