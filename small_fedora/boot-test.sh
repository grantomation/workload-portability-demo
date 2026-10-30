#!/usr/bin/env bash
set -euo pipefail

# Boot-test the small Fedora qcow2 under qemu + plain (non-Secure-Boot) OVMF,
# wait for a login prompt on the serial console, then SSH in and run checks.
# Runs in a container so nothing is installed on the host (on Apple Silicon run
# it as linux/arm64 — x86 is emulated by qemu TCG, slow but fine):
#
#   podman run --rm --platform linux/arm64 \
#     -v "$PWD/small_fedora:/src:ro" -v "$PWD/build-output/small_fedora:/out" \
#     registry.fedoraproject.org/fedora:44 /src/boot-test.sh

IMAGE="${IMAGE:-/out/small_fedora.qcow2}"
GUEST_PASSWORD="${GUEST_PASSWORD:-openshift}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-600}"
LOG=/out/boot-test.log

dnf install -y -q qemu-system-x86-core edk2-ovmf openssh-clients sshpass >/dev/null

rm -f "${LOG}"
cp /usr/share/edk2/ovmf/OVMF_VARS.fd /tmp/vars.fd
qemu-system-x86_64 -machine q35 -cpu max -m 1024 -smp 2 -snapshot \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/edk2/ovmf/OVMF_CODE.fd \
    -drive if=pflash,format=raw,file=/tmp/vars.fd \
    -drive file="${IMAGE}",format=qcow2,if=virtio \
    -netdev user,id=n0,hostfwd=tcp::2222-:22 -device virtio-net-pci,netdev=n0 \
    -display none -serial file:"${LOG}" &
QEMU_PID=$!
trap 'kill ${QEMU_PID} 2>/dev/null || true' EXIT

echo ">>> Booting (log: ${LOG}), waiting up to ${BOOT_TIMEOUT}s for login prompt..."
START=$(date +%s)
until grep -q 'login:' "${LOG}" 2>/dev/null; do
    if ! kill -0 ${QEMU_PID} 2>/dev/null; then echo "qemu exited"; tail -30 "${LOG}"; exit 1; fi
    if [ $(( $(date +%s) - START )) -gt "${BOOT_TIMEOUT}" ]; then
        echo "TIMEOUT"; tail -40 "${LOG}"; exit 1
    fi
    sleep 5
done
echo ">>> Login prompt after $(( $(date +%s) - START ))s"

echo ">>> SSH checks..."
SSH="sshpass -p ${GUEST_PASSWORD} ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 root@localhost"
for i in $(seq 1 30); do $SSH true 2>/dev/null && break; sleep 5; done
$SSH 'cat /etc/fedora-release; uname -r; echo; df -h / /efi; echo; free -m; echo;
      lsmod | grep -E "virtio|vmw" || true; echo;
      systemctl is-system-running; systemctl --failed --no-legend;
      ip -br addr; resolvectl query fedoraproject.org | head -2 || true'
# Optional extra commands for debugging, e.g. -e CHECK_CMD='journalctl -b -u foo'
[ -n "${CHECK_CMD:-}" ] && $SSH "${CHECK_CMD}"
true
