#!/bin/sh
set -eu

# Switches the frontend VM from DHCP to a static IP ending in .202
# on the same subnet. Run as root from the Legacy Infra console.

TARGET_SUFFIX="202"
IFACE="eth0"

echo "=== Legacy Infra Network Switch ==="
echo ""

# --- 1. Wait for DHCP lease then read it ---
echo "Waiting for IPv4 address on ${IFACE}..."
CURRENT_IP=""
for i in $(seq 1 30); do
    CURRENT_IP=$(ip -4 addr show "${IFACE}" | awk '/inet / {print $2; exit}')
    [ -n "${CURRENT_IP}" ] && break
    sleep 2
done
if [ -z "${CURRENT_IP}" ]; then
    echo "[FAIL] No IPv4 address on ${IFACE} after 60 seconds"
    exit 1
fi

CIDR_MASK="${CURRENT_IP#*/}"
CURRENT_ADDR="${CURRENT_IP%/*}"
echo "Current address: ${CURRENT_ADDR}/${CIDR_MASK}"

# --- 2. Derive the target address ---
SUBNET_PREFIX=$(echo "${CURRENT_ADDR}" | rev | cut -d. -f2- | rev)
TARGET_ADDR="${SUBNET_PREFIX}.${TARGET_SUFFIX}"
echo "Target address:  ${TARGET_ADDR}/${CIDR_MASK}"

if [ "${CURRENT_ADDR}" = "${TARGET_ADDR}" ]; then
    echo ""
    echo "[OK] Already on ${TARGET_ADDR} — nothing to do."
    exit 0
fi

# --- 3. Get the current gateway ---
GATEWAY=$(ip route show default | awk '/default/ {print $3; exit}')
if [ -z "${GATEWAY}" ]; then
    echo "[FAIL] No default gateway found"
    exit 1
fi
echo "Gateway:         ${GATEWAY}"

# --- 4. Get current DNS (if any) ---
DNS=""
if [ -f /etc/resolv.conf ]; then
    DNS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
fi

# --- 5. Convert CIDR to dotted netmask ---
cidr_to_netmask() {
    local bits=$1 mask="" i full=$((bits / 8)) partial=$((bits % 8))
    for i in 1 2 3 4; do
        if [ "$i" -le "$full" ]; then
            mask="${mask}255"
        elif [ "$i" -eq "$((full + 1))" ] && [ "$partial" -gt 0 ]; then
            mask="${mask}$(( 256 - (1 << (8 - partial)) ))"
        else
            mask="${mask}0"
        fi
        [ "$i" -lt 4 ] && mask="${mask}."
    done
    echo "$mask"
}

NETMASK=$(cidr_to_netmask "${CIDR_MASK}")
echo "Netmask:         ${NETMASK}"
echo ""

# --- 6. Write static config ---
echo ">>> Writing /etc/network/interfaces..."
cat > /etc/network/interfaces <<EOF
auto lo
iface lo inet loopback

auto ${IFACE}
iface ${IFACE} inet static
    address ${TARGET_ADDR}
    netmask ${NETMASK}
    gateway ${GATEWAY}
EOF

# --- 7. Preserve DNS if it existed ---
if [ -n "${DNS}" ]; then
    echo ">>> Preserving DNS: ${DNS}"
    echo "nameserver ${DNS}" > /etc/resolv.conf
fi

# --- 8. Apply the new address directly (no rc-service — avoids OpenRC deadlock) ---
echo ">>> Applying static address..."
ip addr flush dev "${IFACE}"
ip addr add "${TARGET_ADDR}/${CIDR_MASK}" dev "${IFACE}"
ip link set "${IFACE}" up
ip route add default via "${GATEWAY}"

echo ""
echo "=== Connectivity Tests ==="
echo ""

# --- 9. Verify new address ---
NEW_IP=$(ip -4 addr show "${IFACE}" | awk '/inet / {print $2; exit}')
if [ "${NEW_IP}" = "${TARGET_ADDR}/${CIDR_MASK}" ]; then
    echo "[PASS] Interface address: ${NEW_IP}"
else
    echo "[FAIL] Expected ${TARGET_ADDR}/${CIDR_MASK}, got ${NEW_IP}"
fi

# --- 10. Gateway connectivity ---
if ping -c 2 -W 3 "${GATEWAY}" > /dev/null 2>&1; then
    echo "[PASS] Gateway ${GATEWAY} reachable"
else
    echo "[FAIL] Gateway ${GATEWAY} unreachable"
fi

# --- 11. Internet connectivity ---
if ping -c 2 -W 5 8.8.8.8 > /dev/null 2>&1; then
    echo "[PASS] Internet reachable (8.8.8.8)"
else
    echo "[FAIL] Internet unreachable (8.8.8.8) — check gateway/firewall"
fi

# --- 12. DNS resolution ---
if ping -c 2 -W 5 google.com > /dev/null 2>&1; then
    echo "[PASS] DNS resolution working (google.com)"
else
    echo "[WARN] DNS resolution failed (google.com) — internet works but no DNS"
fi

echo ""
echo "=== Done: ${TARGET_ADDR} ==="
