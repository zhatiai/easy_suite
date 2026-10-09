#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

if [[ "${1:-}" == "--help" && $# == 1 ]]; then
  printf 'Usage: bash deploy.sh [--check]\n\nDeploy using independent D1 / R2 resources. CLOUDFLARE_API_TOKEN, EASYNOTE_DEPLOY_DOMAIN, and EASYNOTE_DEPLOY_CONFIRMATION are used when set; missing values are requested interactively.\n--check builds and validates locally without requesting credentials or changing cloud resources.\n'
  exit 0
fi
if [[ $# -gt 1 || ( $# == 1 && "$1" != "--check" ) ]]; then
  fail "Unknown arguments. Run bash deploy.sh --help."
fi
if [[ "${1:-}" != "--check" ]]; then
  require_terminal
fi
[[ -z "${CLOUDFLARE_API_KEY:-}" && -z "${CF_API_TOKEN:-}" && -z "${CF_API_KEY:-}" ]] ||
  fail "Use CLOUDFLARE_API_TOKEN for deployment environment credentials."
require_runtime
ensure_dependencies
build_app
if [[ "${1:-}" == "--check" ]]; then
  exec ./node_modules/.bin/wrangler deploy --dry-run --outdir .wrangler/dry-run
fi

exec node scripts/deploy.mjs
