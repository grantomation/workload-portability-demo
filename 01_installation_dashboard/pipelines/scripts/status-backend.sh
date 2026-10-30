#!/bin/sh
echo "=== Backend Status ==="
echo ""
PASS=0; FAIL=0

check() {
    if [ "$1" = "ok" ]; then
        echo "[OK] $2"
        PASS=$((PASS + 1))
    else
        echo "[FAIL] $2"
        FAIL=$((FAIL + 1))
    fi
}

# Platform
INFRA=""
if [ -f /run/portable-infra ]; then
    INFRA=$(cat /run/portable-infra 2>/dev/null)
    PLATFORM=$(echo "${INFRA}" | grep -o '"platform":"[^"]*"' | cut -d'"' -f4)
    check ok "Platform: ${PLATFORM}"
else
    check fail "Infrastructure detection not run"
fi

# Hostname
echo ""
echo "Hostname: $(hostname)"

# Network
echo ""
IP=$(ip -4 addr show eth0 2>/dev/null | grep inet | awk '{print $2}')
if [ -n "${IP}" ]; then
    check ok "Network: eth0 ${IP}"
else
    check fail "Network: eth0 has no IPv4 address"
fi

# Service discovery
VIRT=$(virt-what 2>/dev/null || echo "unknown")
if ! echo "${VIRT}" | grep -qi kvm; then
    AVAHI_STATUS=$(rc-service avahi-daemon status 2>&1)
    if echo "${AVAHI_STATUS}" | grep -q started; then
        check ok "Avahi: running"
    else
        check fail "Avahi: not running"
    fi
else
    check ok "K8s DNS (Avahi not required)"
fi

# PostgreSQL
echo ""
PG_STATUS=$(rc-service postgresql status 2>&1)
if echo "${PG_STATUS}" | grep -q started; then
    check ok "PostgreSQL: running"
else
    check fail "PostgreSQL: not running"
fi

LISTEN=$(netstat -tln 2>/dev/null | grep 5432)
if [ -n "${LISTEN}" ]; then
    check ok "Listening on port 5432"
else
    check fail "Not listening on port 5432"
fi

if pg_isready -q 2>/dev/null; then
    check ok "Accepting connections"
else
    check fail "Not accepting connections"
fi

# Database objects
ROLE=$(su - postgres -c "psql -d postgres -tAc \"SELECT rolname FROM pg_roles WHERE rolname='todo'\"" 2>/dev/null)
if [ "${ROLE}" = "todo" ]; then
    check ok "Role 'todo' exists"
else
    check fail "Role 'todo' missing"
fi

DB=$(su - postgres -c "psql -d postgres -tAc \"SELECT datname FROM pg_database WHERE datname='todo'\"" 2>/dev/null)
if [ "${DB}" = "todo" ]; then
    check ok "Database 'todo' exists"
    COUNT=$(su - postgres -c "psql -d todo -tAc 'SELECT count(*) FROM stops'" 2>/dev/null | tr -d ' ')
    check ok "Table 'stops': ${COUNT} rows"
else
    check fail "Database 'todo' missing"
fi

echo ""
echo "=== ${PASS} passed, ${FAIL} failed ==="
[ "${FAIL}" -eq 0 ] && exit 0 || exit 1
