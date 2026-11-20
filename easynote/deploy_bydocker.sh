#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

fail() {
  printf 'EasyNote: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash deploy_bydocker.sh [--check]

Build and start EasyNote with Docker Compose. Configuration priority:
environment variables, the system configuration file, then built-in defaults.

Environment variables:
  EASYNOTE_DOCKER_CONFIG   System configuration file (default: /etc/easynote/docker.env)
  EASYNOTE_DATA_DIR       Persistent host directory (default: /var/lib/easynote/data)
  EASYNOTE_PORT           Host loopback port (default: 8791)
  PUBLIC_ORIGIN           Public origin (default: http://127.0.0.1:<port>)
  PUBLIC_ORIGIN_ALIASES   Optional comma-separated additional origins
  TRUST_PROXY             true only behind a trusted proxy (default: false)
  ALLOW_LOCAL_HTTP        true only for loopback HTTP (derived from PUBLIC_ORIGIN)

--check resolves and validates configuration without writing files or starting containers.
EOF
}

mode=deploy
case "${1:-}" in
  '') ;;
  --check) mode=check ;;
  --help) usage; exit 0 ;;
  *) fail "Unknown argument. Run bash deploy_bydocker.sh --help." ;;
esac
[[ $# -le 1 ]] || fail "Too many arguments. Run bash deploy_bydocker.sh --help."

config_path="${EASYNOTE_DOCKER_CONFIG:-/etc/easynote/docker.env}"
[[ "$config_path" == /* ]] || fail "EASYNOTE_DOCKER_CONFIG must be an absolute path."
[[ "$config_path" != *$'\n'* && "$config_path" != *$'\r'* ]] || fail "EASYNOTE_DOCKER_CONFIG contains a line break."

if [[ -e "$config_path" ]]; then
  [[ -f "$config_path" && -r "$config_path" ]] || fail "Cannot read system configuration: $config_path"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail "Invalid line in $config_path: $line"
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      EASYNOTE_DATA_DIR) [[ -n "${EASYNOTE_DATA_DIR+x}" ]] || EASYNOTE_DATA_DIR="$value" ;;
      EASYNOTE_PORT) [[ -n "${EASYNOTE_PORT+x}" ]] || EASYNOTE_PORT="$value" ;;
      PUBLIC_ORIGIN) [[ -n "${PUBLIC_ORIGIN+x}" ]] || PUBLIC_ORIGIN="$value" ;;
      PUBLIC_ORIGIN_ALIASES) [[ -n "${PUBLIC_ORIGIN_ALIASES+x}" ]] || PUBLIC_ORIGIN_ALIASES="$value" ;;
      TRUST_PROXY) [[ -n "${TRUST_PROXY+x}" ]] || TRUST_PROXY="$value" ;;
      ALLOW_LOCAL_HTTP) [[ -n "${ALLOW_LOCAL_HTTP+x}" ]] || ALLOW_LOCAL_HTTP="$value" ;;
      *) fail "Unsupported key in $config_path: $key" ;;
    esac
  done < "$config_path"
fi

[[ -n "${EASYNOTE_DATA_DIR+x}" ]] || EASYNOTE_DATA_DIR=/var/lib/easynote/data
[[ -n "${EASYNOTE_PORT+x}" ]] || EASYNOTE_PORT=8791
[[ -n "${PUBLIC_ORIGIN+x}" ]] || PUBLIC_ORIGIN="http://127.0.0.1:$EASYNOTE_PORT"
[[ -n "${PUBLIC_ORIGIN_ALIASES+x}" ]] || PUBLIC_ORIGIN_ALIASES=''
[[ -n "${TRUST_PROXY+x}" ]] || TRUST_PROXY=false
if [[ -z "${ALLOW_LOCAL_HTTP+x}" ]]; then
  [[ "$PUBLIC_ORIGIN" == http://127.0.0.1:* ]] && ALLOW_LOCAL_HTTP=true || ALLOW_LOCAL_HTTP=false
fi

for config_value in "$EASYNOTE_DATA_DIR" "$EASYNOTE_PORT" "$PUBLIC_ORIGIN" "$PUBLIC_ORIGIN_ALIASES" "$TRUST_PROXY" "$ALLOW_LOCAL_HTTP"; do
  [[ "$config_value" != *$'\n'* && "$config_value" != *$'\r'* ]] || fail "Docker configuration values cannot contain line breaks."
done

[[ "$EASYNOTE_DATA_DIR" == /* && "$EASYNOTE_DATA_DIR" != / ]] ||
  fail "EASYNOTE_DATA_DIR must be an absolute directory other than /."
[[ "$EASYNOTE_PORT" =~ ^[0-9]+$ ]] && (( EASYNOTE_PORT >= 1024 && EASYNOTE_PORT <= 65535 )) ||
  fail "EASYNOTE_PORT must be an integer between 1024 and 65535."
[[ "$TRUST_PROXY" == true || "$TRUST_PROXY" == false ]] || fail "TRUST_PROXY must be true or false."
[[ "$ALLOW_LOCAL_HTTP" == true || "$ALLOW_LOCAL_HTTP" == false ]] || fail "ALLOW_LOCAL_HTTP must be true or false."
if [[ "$PUBLIC_ORIGIN" =~ ^https://[^/?#]+$ ]]; then
  :
elif [[ "$PUBLIC_ORIGIN" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ && "$ALLOW_LOCAL_HTTP" == true ]]; then
  [[ "$TRUST_PROXY" == false ]] || fail "TRUST_PROXY must be false for local HTTP."
else
  fail "PUBLIC_ORIGIN must be an HTTPS origin without a path, or loopback HTTP with ALLOW_LOCAL_HTTP=true."
fi

export EASYNOTE_DATA_DIR EASYNOTE_PORT PUBLIC_ORIGIN PUBLIC_ORIGIN_ALIASES TRUST_PROXY ALLOW_LOCAL_HTTP

command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Engine and Docker Compose v2."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[[ -f docker-compose.yml ]] || fail "docker-compose.yml is missing."

printf 'Docker configuration:\n'
printf '  config: %s%s\n' "$config_path" "$([[ -e "$config_path" ]] && printf ' (loaded)' || printf ' (new)')"
printf '  data:   %s\n' "$EASYNOTE_DATA_DIR"
printf '  origin: %s\n' "$PUBLIC_ORIGIN"
printf '  port:   127.0.0.1:%s\n' "$EASYNOTE_PORT"

if [[ "$mode" == check ]]; then
  docker compose config --quiet
  printf 'Docker deployment check passed; no files or containers were changed.\n'
  exit 0
fi

if [[ ! -d "$EASYNOTE_DATA_DIR" ]]; then
  if [[ "$(id -u)" == 0 ]]; then
    install -d -m 700 -o 10001 -g 10001 "$EASYNOTE_DATA_DIR"
  else
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to create $EASYNOTE_DATA_DIR for UID/GID 10001."
    sudo install -d -m 700 -o 10001 -g 10001 "$EASYNOTE_DATA_DIR"
  fi
fi

if [[ ! -e "$config_path" ]]; then
  temporary="$(mktemp)"
  trap 'rm -f "$temporary"' EXIT
  {
    printf '# EasyNote Docker deployment settings. Environment variables override these values.\n'
    printf 'EASYNOTE_DATA_DIR=%s\n' "$EASYNOTE_DATA_DIR"
    printf 'EASYNOTE_PORT=%s\n' "$EASYNOTE_PORT"
    printf 'PUBLIC_ORIGIN=%s\n' "$PUBLIC_ORIGIN"
    printf 'PUBLIC_ORIGIN_ALIASES=%s\n' "$PUBLIC_ORIGIN_ALIASES"
    printf 'TRUST_PROXY=%s\n' "$TRUST_PROXY"
    printf 'ALLOW_LOCAL_HTTP=%s\n' "$ALLOW_LOCAL_HTTP"
  } > "$temporary"
  chmod 600 "$temporary"
  config_dir="$(dirname "$config_path")"
  if mkdir -p "$config_dir" 2>/dev/null && install -m 600 "$temporary" "$config_path" 2>/dev/null; then
    :
  else
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to save $config_path."
    sudo install -d -m 755 "$config_dir"
    sudo install -m 600 "$temporary" "$config_path"
  fi
  rm -f "$temporary"
  trap - EXIT
  printf 'Saved system configuration: %s\n' "$config_path"
fi

docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose logs --tail=100 easynote
printf 'EasyNote is running at %s\n' "$PUBLIC_ORIGIN"
