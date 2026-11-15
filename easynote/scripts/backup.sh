#!/usr/bin/env bash
set -euo pipefail
umask 077

# EasyNote Linux 容器冷备份脚本 (v3.1)
# 采用停机一致性冷备份 (Consistent Cold Backup)，确保 D1/R2/DO 跨资源强一致。

DATA_DIR="/var/lib/easynote/data"
BACKUP_DIR="/var/lib/easynote/backups"
CONTAINER_NAME="easynote"
KEEP_COUNT=7

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --container-name)
      CONTAINER_NAME="$2"
      shift 2
      ;;
    --keep)
      KEEP_COUNT="$2"
      shift 2
      ;;
    --help|-h)
      printf 'Usage: bash scripts/backup.sh [OPTIONS]\n'
      printf '  --data-dir DIR        Host data directory (default: /var/lib/easynote/data)\n'
      printf '  --backup-dir DIR      Destination backup directory (default: /var/lib/easynote/backups)\n'
      printf '  --container-name NAME Docker container name (default: easynote)\n'
      printf '  --keep COUNT          Number of backups to retain (default: 7)\n'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

[[ "$KEEP_COUNT" =~ ^[1-9][0-9]*$ ]] || { echo "--keep must be a positive integer." >&2; exit 1; }
# Refuse to copy a possibly live database when Docker cannot establish its state.
RUNNING=$(docker inspect --format='{{.State.Running}}' "$CONTAINER_NAME")
MOUNT_SOURCE=$(docker inspect --format='{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER_NAME")
[[ -d "$DATA_DIR" && -n "$MOUNT_SOURCE" && "$(cd "$DATA_DIR" && pwd -P)" == "$(cd "$MOUNT_SOURCE" && pwd -P)" ]] || {
  echo "--data-dir does not match the container /data bind mount." >&2; exit 1;
}
echo "=== EasyNote Cold Backup started ==="
echo "Data Directory:    ${DATA_DIR}"
echo "Backup Directory:  ${BACKUP_DIR}"
echo "Container:         ${CONTAINER_NAME}"

if [[ ! -d "${DATA_DIR}/state" ]]; then
  echo "Error: Data state directory '${DATA_DIR}/state' does not exist." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

WAS_RUNNING=0
if [[ "$RUNNING" == "true" ]]; then
  WAS_RUNNING=1
fi

# If container was running, ensure it gets restarted even if backup fails
cleanup() {
  if [[ "${WAS_RUNNING}" -eq 1 ]]; then
    if [[ "$(docker inspect --format='{{.State.Running}}' "$CONTAINER_NAME")" != "true" ]]; then
      echo "[backup] Restarting container ${CONTAINER_NAME}..."
      docker start "${CONTAINER_NAME}" || true
    fi
  fi
}
trap cleanup EXIT

if [[ "${WAS_RUNNING}" -eq 1 ]]; then
  echo "[backup] Performing graceful stop of ${CONTAINER_NAME} (grace period 30s)..."
  docker stop -t 30 "${CONTAINER_NAME}"
  echo "[backup] Container stopped. SQLite WAL flushed and file locks released."
else
  echo "[backup] Container ${CONTAINER_NAME} is not currently running. Proceeding with cold backup."
fi

TIMESTAMP="$(date +"%Y%m%d_%H%M%S")_$$"
BACKUP_ARCHIVE="${BACKUP_DIR}/easynote_backup_${TIMESTAMP}.tar.gz"
CHECKSUM_FILE="${BACKUP_ARCHIVE}.sha256"

echo "[backup] Archiving ${DATA_DIR}/state into ${BACKUP_ARCHIVE}..."
tar -czf "${BACKUP_ARCHIVE}" -C "${DATA_DIR}" state

echo "[backup] Calculating SHA-256 checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$BACKUP_DIR" && sha256sum "${BACKUP_ARCHIVE##*/}") > "${CHECKSUM_FILE}"
else
  (cd "$BACKUP_DIR" && shasum -a 256 "${BACKUP_ARCHIVE##*/}") > "${CHECKSUM_FILE}"
fi

ARCHIVE_SIZE=$(ls -lh "${BACKUP_ARCHIVE}" | awk '{print $5}')
echo "[backup] Backup archive created: ${BACKUP_ARCHIVE} (${ARCHIVE_SIZE})"

if [[ "${WAS_RUNNING}" -eq 1 ]]; then
  echo "[backup] Restarting container ${CONTAINER_NAME}..."
  docker start "${CONTAINER_NAME}"

  echo "[backup] Waiting for container to return to Ready state..."
  READY=0
  for i in {1..30}; do
    HEALTH_STATUS=$(docker inspect --format='{{json .State.Health.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo '"unknown"')
    if [[ "${HEALTH_STATUS}" == '"healthy"' ]]; then
      READY=1
      break
    fi
    sleep 1
  done

  if [[ "${READY}" -eq 1 ]]; then
    echo "[backup] Container is healthy and accepting traffic."
  else
    echo "[backup] Container did not become healthy: ${HEALTH_STATUS}" >&2
    exit 1
  fi
fi

# Retention policy: remove older backup files exceeding KEEP_COUNT
echo "[backup] Applying retention policy (keep ${KEEP_COUNT})..."
find "${BACKUP_DIR}" -name "easynote_backup_*.tar.gz" -type f | sort -r | tail -n +"$((KEEP_COUNT + 1))" | while read -r old_backup; do
  echo "[backup] Removing old backup: ${old_backup}"
  rm -f "${old_backup}" "${old_backup}.sha256"
done

echo "=== EasyNote Cold Backup completed successfully ==="
