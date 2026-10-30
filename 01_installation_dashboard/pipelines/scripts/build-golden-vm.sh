#!/usr/bin/env bash
set -euo pipefail

# Portable Alpine golden VM build — derived from alpine/golden.yml.
# Runs inside the golden-builder container (UBI9 + guestfs-tools).
# All disk manipulation is offline (QEMU TCG, no /dev/kvm).

export LIBGUESTFS_BACKEND=direct

# --- Configurable via env vars ---
ALPINE_REL="${ALPINE_REL:-3.21.2}"
ALPINE_VER="${ALPINE_REL%.*}"
ALPINE_ARCH="${ALPINE_ARCH:-x86_64}"
BUILD_SIZE="${BUILD_SIZE:-3G}"
GUEST_PASSWORD="${GUEST_PASSWORD:-openshift}"
REPO_SRC="${REPO_SRC:-/workspace/source}"
APP_SRC="${APP_SRC:-${REPO_SRC}/02_workload}"
OUTPUT_DIR="${OUTPUT_DIR:-/workspace/output}"
VMDK_SUBFORMAT="${VMDK_SUBFORMAT:-monolithicSparse}"
VERIFY_CHECKSUM="${VERIFY_CHECKSUM:-true}"

ALPINE_IMAGE="generic_alpine-${ALPINE_REL}-${ALPINE_ARCH}-uefi-cloudinit-r0.qcow2"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER}/releases/cloud/${ALPINE_IMAGE}"

WORK_DIR="/tmp/vm-build"
WORK_DISK="${WORK_DIR}/pw_alpine_work.qcow2"
GOLDEN_QCOW="${OUTPUT_DIR}/pw_alpine.qcow2"
GOLDEN_VMDK="${OUTPUT_DIR}/pw_alpine.vmdk"

mkdir -p "${WORK_DIR}"
rm -rf "${OUTPUT_DIR}/work" 2>/dev/null || true

# ----- 1. Download the Alpine cloud image + verify checksum -----
CHECKSUM_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER}/releases/cloud/${ALPINE_IMAGE}.sha512"

echo ">>> Downloading Alpine ${ALPINE_REL} cloud image..."
if [ -f "${WORK_DIR}/${ALPINE_IMAGE}" ]; then
    echo "    (already downloaded, skipping)"
else
    curl -fSL -o "${WORK_DIR}/${ALPINE_IMAGE}.tmp" "${ALPINE_URL}"
    if [ "${VERIFY_CHECKSUM}" = "true" ]; then
        echo ">>> Verifying checksum..."
        EXPECTED=$(curl -fsSL "${CHECKSUM_URL}" | awk '{print $1}')
        ACTUAL=$(sha512sum "${WORK_DIR}/${ALPINE_IMAGE}.tmp" | awk '{print $1}')
        if [ "${EXPECTED}" != "${ACTUAL}" ]; then
            echo "ERROR: Checksum mismatch!" >&2
            echo "  Expected: ${EXPECTED}" >&2
            echo "  Actual:   ${ACTUAL}" >&2
            rm -f "${WORK_DIR}/${ALPINE_IMAGE}.tmp"
            exit 1
        fi
        echo "    Checksum OK."
    else
        echo "    (checksum verification skipped)"
    fi
    mv "${WORK_DIR}/${ALPINE_IMAGE}.tmp" "${WORK_DIR}/${ALPINE_IMAGE}"
fi

# ----- 2. Expand into a roomy working disk -----
echo ">>> Finding root partition in base image..."
ROOT_PART=$(virt-filesystems -a "${WORK_DIR}/${ALPINE_IMAGE}" \
    --partitions --long --csv \
    | tail -n +2 | sort -t, -k4 -n | tail -1 | cut -d, -f1)
echo "    Root partition: ${ROOT_PART}"

echo ">>> Creating ${BUILD_SIZE} working disk..."
qemu-img create -f qcow2 "${WORK_DISK}" "${BUILD_SIZE}"

echo ">>> Expanding Alpine root into working disk..."
virt-resize --expand "${ROOT_PART}" \
    "${WORK_DIR}/${ALPINE_IMAGE}" "${WORK_DISK}"

# ----- 3. Customize offline -----
echo ">>> Customizing Alpine image (packages, passwords, app)..."
virt-customize -a "${WORK_DISK}" \
    --run-command "sed -i 's,^#\(.*/community\),\1,' /etc/apk/repositories" \
    --install qemu-guest-agent,ansible-core,acl,sudo \
    --run-command "rc-update add qemu-guest-agent default" \
    --root-password "password:${GUEST_PASSWORD}" \
    --run-command "sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config" \
    --copy-in "${REPO_SRC}:/root/" \
    --run-command "rm -rf /var/cache/apk/*"

# ----- 4. Disable cloud-init -----
echo ">>> Disabling cloud-init..."
virt-customize -a "${WORK_DISK}" \
    --run-command "touch /etc/cloud/cloud-init.disabled"

# ----- 5. Seal + sparsify -----
echo ">>> Sealing image (virt-sysprep)..."
virt-sysprep -a "${WORK_DISK}"

echo ">>> Sparsifying working image..."
virt-sparsify --in-place "${WORK_DISK}"

# ----- 6. Pre-shrink ext4 filesystem -----
echo ">>> Finding root partition in working image..."
WORK_ROOT=$(virt-filesystems -a "${WORK_DISK}" \
    --partitions --long --csv \
    | tail -n +2 | sort -t, -k4 -n | tail -1 | cut -d, -f1)
echo "    Root partition: ${WORK_ROOT}"

echo ">>> Pre-shrinking ext4 to minimum size..."
guestfish --rw -a "${WORK_DISK}" \
    run : \
    e2fsck-f "${WORK_ROOT}" : \
    resize2fs-M "${WORK_ROOT}"

# ----- 7. Shrink-copy into target disk -----
echo ">>> Calculating target disk size from minimized filesystem..."
FS_INFO=$(guestfish --ro -a "${WORK_DISK}" \
    run : tune2fs-l "${WORK_ROOT}" \
    | awk '/^Block count:/ {blocks=$3} /^Block size:/ {bs=$3} END {print blocks, bs}')
FS_BLOCKS=$(echo "${FS_INFO}" | awk '{print $1}')
FS_BSIZE=$(echo "${FS_INFO}" | awk '{print $2}')
MIN_FS_BYTES=$((FS_BLOCKS * FS_BSIZE))
HEADROOM_BYTES=$((MIN_FS_BYTES / 5))
TARGET_BYTES=$((MIN_FS_BYTES + HEADROOM_BYTES))
TARGET_MB=$(( (TARGET_BYTES / 1048576) + 1 ))
echo "    Minimized filesystem: $((MIN_FS_BYTES / 1048576))M + 20% headroom = ${TARGET_MB}M"

echo ">>> Creating ${TARGET_MB}M target disk..."
qemu-img create -f qcow2 "${GOLDEN_QCOW}" "${TARGET_MB}M"

echo ">>> Shrink-copying into target disk..."
virt-resize --shrink "${WORK_ROOT}" \
    "${WORK_DISK}" "${GOLDEN_QCOW}"

echo ">>> Sparsifying final image..."
virt-sparsify --in-place "${GOLDEN_QCOW}"

echo ">>> Removing intermediate working disk..."
rm -f "${WORK_DISK}"
rmdir "${WORK_DIR}" 2>/dev/null || true

# ----- 8. Convert to VMDK -----
echo ">>> Converting to VMDK (${VMDK_SUBFORMAT})..."
qemu-img convert -f qcow2 -O vmdk \
    -o "subformat=${VMDK_SUBFORMAT}" \
    "${GOLDEN_QCOW}" "${GOLDEN_VMDK}"

# ----- 9. Report -----
echo ""
echo "=== Alpine golden VM build complete ==="
echo "qcow2: ${GOLDEN_QCOW}"
echo "VMDK:  ${GOLDEN_VMDK}"
qemu-img info "${GOLDEN_QCOW}"
ls -lh "${GOLDEN_VMDK}"
