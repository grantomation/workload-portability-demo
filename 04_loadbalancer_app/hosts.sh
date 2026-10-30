#!/usr/bin/env bash
# Add or remove /etc/hosts entries for the load balancer's configured domain.
# Reads the domain from config.yaml so there's a single source of truth.
#
#   ./hosts.sh add
#   ./hosts.sh remove
#   ./hosts.sh status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${SCRIPT_DIR}/config.yaml"

# Extract domain from config.yaml (simple grep — no yq dependency)
DOMAIN=$(grep -E '^\s*domain:' "$CONFIG" | head -1 | sed 's/.*domain:\s*//' | tr -d '"' | tr -d "'" | xargs)

if [ -z "$DOMAIN" ]; then
  echo "ERROR: Could not read 'domain' from ${CONFIG}"
  exit 1
fi

HOSTNAME="$DOMAIN"
DASH_HOSTNAME="dashboard.${DOMAIN#*.}"
ENTRY="127.0.0.1 ${HOSTNAME} ${DASH_HOSTNAME}"
HOSTS="/etc/hosts"

sedi() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sudo sed -i '' "$@" "$HOSTS"
  else
    sudo sed -i "$@" "$HOSTS"
  fi
}

case "${1:-}" in
  add)
    if grep -qF "$HOSTNAME" "$HOSTS"; then
      echo "✓ Already present: ${ENTRY}"
    else
      sudo sh -c "echo '${ENTRY}' >> ${HOSTS}"
      echo "✓ Added: ${ENTRY}"
    fi
    ;;
  remove)
    if grep -qF "$HOSTNAME" "$HOSTS"; then
      sedi "/$HOSTNAME/d"
      echo "✓ Removed: ${HOSTNAME}"
    else
      echo "✓ Not present, nothing to do."
    fi
    ;;
  status)
    if grep -qF "$HOSTNAME" "$HOSTS"; then
      echo "✓ Present: $(grep -F "$HOSTNAME" "$HOSTS")"
    else
      echo "✗ Not in ${HOSTS}"
    fi
    ;;
  *)
    echo "Usage: $0 {add|remove|status}"
    exit 1
    ;;
esac
