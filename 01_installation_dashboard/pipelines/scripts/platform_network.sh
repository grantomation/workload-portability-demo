#!/bin/sh
set -eu

# Boot-time platform detection: ensures /etc/network/interfaces matches
# the current hypervisor BEFORE the networking service starts.
#   KVM (OpenShift/KubeVirt) → DHCP  (masquerade networking provides 10.0.2.x)
#   Legacy Infra                   → DHCP
#   Unknown                  → no change

IFACE="eth0"
CONF="/etc/network/interfaces"

PLATFORM="legacy"
if command -v virt-what >/dev/null 2>&1; then
    VW=$(virt-what 2>/dev/null || true)
    case "${VW}" in
        *kvm*)    PLATFORM="kvm" ;;
    esac
fi

echo "[platform-network] platform=${PLATFORM}"

case "${PLATFORM}" in
    kvm)
        echo "[platform-network] Writing DHCP config for KubeVirt masquerade"
        cat > "${CONF}" <<EOF
auto lo
iface lo inet loopback

auto ${IFACE}
iface ${IFACE} inet dhcp
EOF
        ;;
    legacy)
        echo "[platform-network] Non-KVM or unavailable detection — skipping (static IP set by configure-network script)"
        ;;
    *)
        echo "[platform-network] Unknown platform — no changes"
        ;;
esac
