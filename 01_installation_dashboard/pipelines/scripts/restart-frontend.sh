#!/bin/sh
echo "=== Restarting Portable Workload Frontend ==="
echo "[RESTART] Stopping service..."
rc-service portable-workload stop 2>&1
echo "[RESTART] Re-resolving DB host..."
. /etc/portable-workload.env
if ! virt-what 2>/dev/null | grep -qi kvm; then
    RESOLVED=$(avahi-resolve -4 --name "${DB_HOST}.local" 2>/dev/null | awk '{print $2}')
    if [ -n "${RESOLVED}" ]; then
        echo "[RESTART] Resolved ${DB_HOST}.local -> ${RESOLVED}"
    else
        echo "[RESTART] Could not resolve ${DB_HOST}.local, using ${DB_HOST}"
    fi
else
    echo "[RESTART] KVM detected, using ${DB_HOST}"
fi
echo "[RESTART] Starting service..."
rc-service portable-workload start 2>&1
STATUS=$(rc-service portable-workload status 2>&1)
echo "[RESTART] ${STATUS}"
echo "=== Done ==="
