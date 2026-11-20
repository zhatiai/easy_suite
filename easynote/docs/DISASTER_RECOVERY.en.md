# EasyNote Disaster Recovery

> For Docker cold backups, restoration, and migration from Cloudflare, see [Docker deployment](DOCKER.en.md). The root-level maintenance commands below target Cloudflare/Wrangler.

[简体中文](DISASTER_RECOVERY.md) | [English](DISASTER_RECOVERY.en.md)

## Three Types of Exports

| Type | Content | Purpose |
| --- | --- | --- |
| Web "Export ZIP" | Active notes, trash, referenced files | Migration and general archiving |
| Web "Export Drafts" | Unsynced browser drafts, cached referenced files | Rescuing local content during network or sync issues |
| `backup.sh` | Full D1 database, all R2 objects tracked in D1 | Account-level disaster recovery |

Web ZIPs are designed for note migration. Complete account states, sessions, AI token hashes, version history, and deletion tombstones are backed up via `backup.sh`.

## Sync and backup servers in Settings

On an empty instance, choose “Set up as a backup node” and enter the source URL, transfer token, sync mode and pull interval. After synchronization, sign in with the source account that owns the notes and its existing password. Existing instances continue to use Settings. Local accounts retained by incremental sync can view only their own data. A failed first pull pauses the schedule so setup can be retried. Reloading the setup page restores progress using its dedicated HttpOnly cookie.

Administrators can open Settings → Sync & backup servers. Docker and Cloudflare share the protocol and support migration between either deployment.

1. Generate a transfer token on the peer that accepts connections and enable incoming transfers. Share this whole-instance read/write token only with trusted administrators.
2. Forward synchronization pushes from this server to the peer. Configure the destination URL, token, mode and push interval.
3. Reverse synchronization pulls from the peer into this server. Configure the primary server URL and token on the backup node so that the backup node initiates the connection. Set a pull interval for unattended backups.
4. Overwrite replaces the target dataset. Incremental synchronization gives source primary keys priority and preserves target-only records. Matching usernames with different account IDs stop the task. Source notes and folders control their sharing state. Both replicas retain permanent-deletion tombstones to prevent resurrection. Other missing source records remain as target-only data.
5. Type `OVERWRITE` to authorize target writes before saving schedules or running a task. Each direction has its own mode and interval. Zero disables that schedule. Existing settings retain overwrite pushes and default to disabled scheduled pulls.

Incremental jobs exchange primary keys and hashes before transferring changed rows. Matching attachments are reused after checking ownership, ID, SHA-256, size and object availability. Target-only rows are merged into the staged snapshot, then published in the same atomic transaction. Both modes preserve server connection settings and revoke target browser sessions so offline data is rebuilt. Incremental jobs still stage complete metadata but only stage new or changed attachment bytes.

Both code fingerprints must match exactly. The fingerprint covers source, migrations, static assets, runtime scripts, the dependency lockfile and build configuration. It is checked during connection and commit. Rebuild and update both servers after source changes.

Transfers include all accounts, password verifiers, registration settings, notes, folders, history, shares, integration tokens, tombstones, sync logs and all available attachments. Target browser sessions and temporary OAuth codes expire at commit. Signing in again clears the previous dataset's offline mirror and drafts. Other open tabs reload when the dataset generation changes. Wait for local drafts to save before starting.

Persistent Durable Object Alarms run jobs. Docker stores their state under `/data/state/do`. Each server stores its own connection settings, credentials, job record and schedule. Incoming token plaintext is displayed when generated. The settings API returns credential-presence flags.

Both servers enter maintenance during transfer and business APIs return `503`. The target receives staging tables and objects under a separate prefix, checks attachment sizes and SHA-256, and replaces the instance in one database transaction. Failures before commit preserve the original dataset. A dataset-generation marker makes commit retries idempotent after lost acknowledgements. Interrupted maintenance leases expire within ten minutes. Background collection removes staged data and old objects. Reserve space for the staging database, attachments and original dataset. Peak storage approaches two datasets plus SQLite journals. Old data is collected after completion.

The initiating server must be able to reach the HTTPS origin, which may include a port. Redirects are rejected. Private networks can use trusted certificates and internal DNS. Choose the reachable side to initiate the transfer. Each direction uses its configured synchronization mode.

Docker outbound HTTPS uses the Linux public CA trust store provided by the image’s `ca-certificates` package. For a peer with a private or newly issued CA, mount the trusted CA PEM file read-only and set `NODE_EXTRA_CA_CERTS` to its container path. The runtime user must be able to read it. Cloudflare peers require a certificate chain trusted by the platform.

## Remote Authorization

All commands using `--remote` (backup, preflight check, restore, and password reset) require an interactive terminal and read an invisible Cloudflare custom API Token on each run. Scoped permissions required on the target account include Workers Scripts (Edit), D1 (Edit), and Workers R2 Storage (Edit); initial automated deployments also require Account Settings (Read) to discover accounts, and Custom Domains require Zone (Read) and Workers Routes (Read) on the target Zone.

The script reads the Token invisibly through the terminal on each remote invocation, lifetime limited to the current process. `wrangler.deploy.json` stores the Account ID, Worker name, and D1/R2 resource IDs. Disaster recovery and deployment use Cloudflare API Tokens, whereas EasyNote AI integration tokens are used exclusively for MCP.

## Creating a Backup

Production backup:

```bash
bash backup.sh --remote
```

Local development data:

```bash
bash backup.sh --local
```

Use `--output DIR` to specify a custom destination directory. The script executes:

1. Exports all D1 business tables via Wrangler; reproducible FTS5 search indexes are excluded.
2. Reads all private file records with status `ready` from the SQL snapshot.
3. Downloads each R2 object using its `storage_key`, falling back to `<user_id>/<file_id>` for older rows.
4. Verifies each object against the size and SHA-256 recorded in D1.
5. Writes a `manifest.json` containing checksums for the database, schema baseline, and objects.

Backups contain password verifiers, session hashes, and AI token hashes; directory permissions are set to read/write for the current user only (`0700`). Store backups in an encrypted, offline location with an independent retention policy.

## Preflight Restoration Check

Create fresh, empty D1 and R2 resources and write their identifiers to a dedicated `wrangler.deploy.json`; the restoration target must be empty.

```bash
bash restore.sh /path/to/easynote-backup --remote --check
```

The preflight check performs read-only validations:

- Manifest, D1 SQL, current Schema baseline, and all R2 object hashes match.
- Target D1 is either uninitialized or has a complete but empty EasyNote Schema.
- Target D1 has zero accounts, notes, and file records.
- None of the R2 keys from the backup exist in the target bucket.

All conditions must pass before proceeding to full restoration.

## Executing Restoration

```bash
bash restore.sh /path/to/easynote-backup --remote
```

After entering the confirmation phrase, the script provisions the schema if needed, re-verifies that target resources are empty, uploads R2 objects first, and then imports D1 data. Full-text search indexes are automatically rebuilt upon note import. If interrupted, inspect output for troubleshooting and rerun against fresh, empty resources.

Immediately after restoration:

1. Run `bash reset-password.sh --remote`.
2. Recreate required AI tokens.
3. Log in to the web app and spot-check notes, version history, images, and attachments.
4. Create a fresh disaster recovery backup and run `--check`.

## Recovery Drills

Conduct at least one isolated recovery drill before going to production:

1. Create a temporary D1 database and private R2 bucket.
2. Generate an isolated configuration for temporary resources.
3. Run the restore preflight check against the latest backup.
4. Execute restoration and deploy a temporary Worker.
5. Verify D1 table counts, R2 object counts, and representative files.
6. Delete temporary Worker, D1, and R2 resources upon completion.

Cloudflare resources are explicitly created, deleted, and managed by administrators. Remote backups should be executed on a regular schedule and archived offline.

Cloudflare Worker fetch requires a hostname for outgoing requests. If the primary cannot connect to a Docker backup node, configure a reverse pull on the Docker node using the primary server hostname.
