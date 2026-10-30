#!/bin/sh
echo "=== Frontend Status ==="
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

# Service discovery (platform-aware)
VIRT=$(virt-what 2>/dev/null || echo "unknown")
if ! echo "${VIRT}" | grep -qi kvm; then
    AVAHI_STATUS=$(rc-service avahi-daemon status 2>&1)
    if echo "${AVAHI_STATUS}" | grep -q started; then
        check ok "Avahi: running"
        BACKEND=$(avahi-resolve -4 --name pw-backend-svc.local 2>/dev/null | awk '{print $2}')
        if [ -n "${BACKEND}" ]; then
            check ok "Backend resolved: pw-backend-svc.local -> ${BACKEND}"
        else
            check fail "Cannot resolve pw-backend-svc.local"
        fi
    else
        check fail "Avahi: not running"
    fi
else
    BACKEND=$(getent hosts pw-backend-svc 2>/dev/null | awk '{print $1}')
    if [ -n "${BACKEND}" ]; then
        check ok "Backend resolved: pw-backend-svc -> ${BACKEND} (K8s DNS)"
    else
        check fail "Cannot resolve pw-backend-svc via DNS"
    fi
fi

# App service
echo ""
APP_STATUS=$(rc-service portable-workload status 2>&1)
if echo "${APP_STATUS}" | grep -q started; then
    check ok "App service: running"
else
    check fail "App service: not running"
fi

LISTEN=$(netstat -tln 2>/dev/null | grep ':80 ')
if [ -n "${LISTEN}" ]; then
    check ok "Listening on port 80"
else
    check fail "Not listening on port 80"
fi

# API health
echo ""
HEALTH=$(curl -s --connect-timeout 3 http://localhost/health 2>/dev/null)
DB_STATUS=$(echo "${HEALTH}" | grep -o '"database":"[^"]*"' | cut -d'"' -f4)
if [ "${DB_STATUS}" = "connected" ]; then
    check ok "Database connection: connected"
else
    check fail "Database connection: ${DB_STATUS:-unreachable}"
fi

# Infra API
INFRA_API=$(curl -s --connect-timeout 3 http://localhost/api/infra 2>/dev/null)
API_PLATFORM=$(echo "${INFRA_API}" | grep -o '"platform":"[^"]*"' | cut -d'"' -f4)
if [ -n "${API_PLATFORM}" ]; then
    check ok "Infra API: ${API_PLATFORM}"
else
    check fail "Infra API: no response"
fi

# Stops API
STOPS=$(curl -s --connect-timeout 3 http://localhost/api/stops 2>/dev/null)
if echo "${STOPS}" | grep -q '^\['; then
    COUNT=$(echo "${STOPS}" | grep -o '"id"' | wc -l | tr -d ' ')
    check ok "Stops API: ${COUNT} stops"
else
    check fail "Stops API: error or no response"
fi

echo ""
echo "=== ${PASS} passed, ${FAIL} failed ==="
[ "${FAIL}" -eq 0 ] && exit 0 || exit 1
