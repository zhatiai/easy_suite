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

Set the real HTTPS origin and run the single deployment entry point:

```bash
PUBLIC_ORIGIN=https://your-domain TRUST_PROXY=true bash deploy_bydocker.sh
```

The script resolves configuration in this order: environment variables, system configuration, built-in defaults. The system configuration defaults to `/etc/easynote/docker.env` with mode `0600`; set `EASYNOTE_DOCKER_CONFIG` to use another absolute path. On the first run, the script saves the resolved configuration, creates the persistent directory, builds the image, and starts the container. Later environment overrides apply only to that run and do not silently rewrite the saved configuration.

With no environment or system configuration, it starts in server-local mode using `/var/lib/easynote/data`, port `8791`, and `http://127.0.0.1:8791`. Set an HTTPS origin before publishing the service. Run `bash deploy_bydocker.sh --check` to validate without writing configuration, creating directories, building, or starting containers.

After startup, open `PUBLIC_ORIGIN` and enter the first administrator username, password, and password confirmation. Setup signs you in automatically. Usernames contain 3–32 lowercase letters, digits, or `. _ -`. Passwords contain 10–128 characters. The server stores a salted password verifier. A conditional database insert creates one administrator and closes setup. The first successful submission claims an empty installation, so complete setup promptly after deployment.

You can also run `docker compose run --rm easynote node scripts/setup.mjs --docker` before startup to interactively create `/data/initial-owner.json`. Existing database accounts, the `INITIAL_OWNER` environment variable, and verifier files remain supported. The container runs as UID/GID `10001:10001`. Grant this user access to the data directory.

Compose publishes the application only on host `127.0.0.1:8791`. The health port listens on container loopback and is checked by Docker. Startup opens the ingress after migrations and a Worker probe succeed. An empty installation starts healthy and serves the web setup form. Failed migrations prevent startup.

Use `docker compose build --build-arg NODE_OPTIONS=--max-old-space-size=1536` to set the Node heap limit during builds. Leave additional memory for native allocations and other processes. Build and production dependency installation share a BuildKit npm cache that stays outside the runtime image.

### Build frontend artifacts on a build machine

When server memory is limited, run `npm ci --include=dev` and `npm run build` on a development machine or CI using the same source version. Transfer the complete `dist/` directory to the server, then use the prebuilt configuration:

```bash
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml build
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml up -d --wait
```

The server mounts `./dist` read-only by default. Set an absolute `EASYNOTE_DIST_DIR` in `.env` to use another location. This configuration selects the Dockerfile’s `runtime` target. Dependency installation and server execution run inside containers, while frontend compilation runs on the build machine. For upgrades, stop the service, replace the complete `dist/` with artifacts matching the server source, rebuild, and start it.

### Assemble a complete image on a small server

Only Miniflare is declared as a runtime dependency. Frontend libraries and libraries bundled into the Worker are build dependencies. Production installation uses the same lockfile.

After running `npm run build` on the build machine, put the complete output in `artifacts/app/dist` and transfer `artifacts` to the server. A named BuildKit context can supply the `builder` stage artifacts.

```bash
docker buildx create --name easynote-small --driver docker-container \
  --driver-opt memory=768m,memory-swap=768m,cpu-period=100000,cpu-quota=100000
docker buildx build --builder easynote-small \
  --build-context builder=/absolute/path/to/artifacts \
  --provenance=false --load -t easynote:local .
```

The resulting image contains the frontend and Worker. The server installs the locked runtime dependencies. After validation, `docker buildx rm easynote-small` removes this dedicated builder and its cache. Manage persistent data, backups, and existing services through their respective lifecycles.

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
| `PUBLIC_ORIGIN` | Local `http://127.0.0.1:<port>` by default; public deployments must set the browser-facing HTTPS origin |
| `PUBLIC_ORIGIN_ALIASES` | Optional comma-separated additional origins using the primary origin protocol. Each Host is validated and same-origin checks remain enforced. |
| `EASYNOTE_DATA_DIR` | Compose host path; `/var/lib/easynote/data` |
| `EASYNOTE_PORT` | Host loopback port; `8791` |
| `TRUST_PROXY` | `false`; trust the proxy's overwritten `X-Real-IP` |
| `ALLOW_LOCAL_HTTP` | Derived as `true` for a loopback HTTP origin when unset; otherwise `false` |
| `INITIAL_OWNER_FILE` | `/data/initial-owner.json` inside the container; may point to a read-only secret |
| `EASYNOTE_DOCKER_CONFIG` | System configuration file; `/etc/easynote/docker.env` by default |

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

### Resource measurements

Tested on 2026-11-15 with Linux amd64, Docker 29.4.1, and Node.js 22.23.5. Image sizes use the same host’s total disk size reported by `docker image ls`.

| Item | Result |
| --- | --- |
| Existing / lean image | 2.58 GB / 661 MB, approximately 74% smaller |
| Dedicated builder limit | 768 MiB RAM, 1 CPU, no swap |
| Application memory samples | Approximately 190–256 MiB, with a 384 MiB container limit |
| Dedicated build cache removed | Approximately 727 MiB |

Validation covered interactive setup, HTTPS/WSS, MCP tool calls, revision conflicts, tenant isolation, attachments, restart persistence, and cold backup restoration. The restored instance passed data reads and MCP checks with `--network none`. These are isolated test samples. Data volume and concurrency affect runtime memory.

## Validation

```bash
npm run check
npm run build
npm test
npm run test:scripts
npm run test:ui
bash deploy.sh --check
bash deploy_bydocker.sh --check
```

`test/server.test.mjs` runs real server processes with persistent storage, covering HTTPS origins, security headers, CSRF, tenant isolation, idempotency, revisions, files, FTS, shares, MCP, WebSockets, shutdown and restart, migration rollback, and scheduled cleanup. `test/server-import.test.mjs` checks complete backup imports, corrupt objects, and overwrite refusal. These tests do not replace image builds and acceptance checks on the target Linux server.
