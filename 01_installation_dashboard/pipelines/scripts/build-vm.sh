#!/usr/bin/env bash
set -euo pipefail

# Builds a purpose-built Alpine VM for the Portable Workload app.
# Set VM_ROLE=frontend or VM_ROLE=backend to choose the variant.
# Runs inside the golden-builder container (Fedora 44 + guestfs-tools).

export LIBGUESTFS_BACKEND=direct

VM_ROLE="${VM_ROLE:?Set VM_ROLE to 'frontend' or 'backend'}"
case "${VM_ROLE}" in
  frontend|backend) ;;
  *) echo "ERROR: VM_ROLE must be 'frontend' or 'backend', got '${VM_ROLE}'" >&2; exit 1 ;;
esac

# --- Configurable via env vars ---
ALPINE_REL="${ALPINE_REL:-3.21.2}"
ALPINE_VER="${ALPINE_REL%.*}"
ALPINE_ARCH="${ALPINE_ARCH:-x86_64}"
BUILD_SIZE="${BUILD_SIZE:-3G}"
GUEST_PASSWORD="${GUEST_PASSWORD:-openshift}"
REPO_SRC="${REPO_SRC:-/workspace/source}"
APP_SRC="${APP_SRC:-${REPO_SRC}/02_workload}"
OUTPUT_DIR="${OUTPUT_DIR:-/workspace/output}"
VMDK_SUBFORMAT="${VMDK_SUBFORMAT:-streamOptimized}"
VERIFY_CHECKSUM="${VERIFY_CHECKSUM:-true}"

ALPINE_IMAGE="generic_alpine-${ALPINE_REL}-${ALPINE_ARCH}-uefi-cloudinit-r0.qcow2"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER}/releases/cloud/${ALPINE_IMAGE}"

WORK_DIR="${REPO_SRC}/.vm-build"
WORK_DISK="${WORK_DIR}/pw_${VM_ROLE}_work.qcow2"
GOLDEN_QCOW="${OUTPUT_DIR}/pw_${VM_ROLE}.qcow2"
GOLDEN_VMDK="${OUTPUT_DIR}/pw_${VM_ROLE}.vmdk"

mkdir -p "${WORK_DIR}" "${OUTPUT_DIR}"

echo "=== Building ${VM_ROLE} VM ==="

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
            exit 1
        fi
        echo "    Checksum OK."
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

# ----- 3. Common customization -----
echo ">>> Common customization (packages, SSH, Avahi)..."
virt-customize -a "${WORK_DISK}" \
    --run-command "sed -i 's,^#\(.*/community\),\1,' /etc/apk/repositories" \
    --run-command "mkdir -p /run/openrc && touch /run/openrc/softlevel" \
    --install qemu-guest-agent,avahi,avahi-tools,dbus,virt-what \
    --run-command "rc-update add qemu-guest-agent default" \
    --run-command "rc-update add dbus default" \
    --run-command "rc-update add avahi-daemon default" \
    --root-password "password:${GUEST_PASSWORD}" \
    --run-command "sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config"

# ----- 3b. Platform-aware network service (runs before networking) -----
PLATFORM_NET_SCRIPT="${REPO_SRC}/01_installation_dashboard/pipelines/scripts/platform_network.sh"
if [ -f "${PLATFORM_NET_SCRIPT}" ]; then
    echo ">>> Embedding platform_network.sh + OpenRC service..."
    virt-customize -a "${WORK_DISK}" \
        --copy-in "${PLATFORM_NET_SCRIPT}:/root/" \
        --run-command "chmod 755 /root/platform_network.sh" \
        --write /etc/init.d/platform-network:'#!/sbin/openrc-run
description="Platform-aware network config (KVM=DHCP, Legacy Infra=keep)"
depend() {
    before networking
    keyword -timeout
}
start() {
    ebegin "Detecting platform and configuring network"
    /root/platform_network.sh
    eend $?
}
' \
        --run-command "chmod 755 /etc/init.d/platform-network" \
        --run-command "rc-update add platform-network boot"
fi

# ----- 3c. Infrastructure platform detection (runs after networking) -----
INFRA_DETECT_SCRIPT="${APP_SRC}/portable-infra-detect.sh"
if [ -f "${INFRA_DETECT_SCRIPT}" ]; then
    echo ">>> Embedding portable-infra-detect.sh + OpenRC service..."
    virt-customize -a "${WORK_DISK}" \
        --copy-in "${INFRA_DETECT_SCRIPT}:/usr/local/bin/" \
        --run-command "chmod 755 /usr/local/bin/portable-infra-detect.sh" \
        --write /etc/init.d/portable-infra-detect:'#!/sbin/openrc-run
description="Detect infrastructure platform and write /run/portable-infra"
depend() {
    need net
    after networking
}
start() {
    ebegin "Detecting infrastructure platform"
    /usr/local/bin/portable-infra-detect.sh
    eend $?
}
' \
        --run-command "chmod 755 /etc/init.d/portable-infra-detect" \
        --run-command "rc-update add portable-infra-detect default"
fi

# ----- 4. Role-specific customization -----
SCRIPTS_DIR="${REPO_SRC}/01_installation_dashboard/pipelines/scripts"

if [ "${VM_ROLE}" = "backend" ]; then
    echo ">>> Backend: installing PostgreSQL + configuring database..."

    virt-customize -a "${WORK_DISK}" \
        --write /etc/hostname:pw-backend-svc \
        --install postgresql,postgresql-client,curl \
        --run-command "mkdir -p /run/openrc && touch /run/openrc/softlevel" \
        --run-command "su postgres -c 'initdb -D /var/lib/postgresql/17/data'" \
        --run-command "sed -i \"s/^#*\\s*listen_addresses.*/listen_addresses = '*'/\" /var/lib/postgresql/17/data/postgresql.conf" \
        --run-command "echo 'host  todo  todo  0.0.0.0/0  scram-sha-256' >> /var/lib/postgresql/17/data/pg_hba.conf" \
        --run-command "rc-update add postgresql default"

    # DB helper scripts
    echo ">>> Embedding database helper scripts..."
    virt-customize -a "${WORK_DISK}" \
        --copy-in "${SCRIPTS_DIR}/check-db-seed.sh:/root/" \
        --copy-in "${SCRIPTS_DIR}/db-seed.sh:/root/" \
        --copy-in "${SCRIPTS_DIR}/status-backend.sh:/root/" \
        --copy-in "${SCRIPTS_DIR}/configure-network-backend.sh:/root/" \
        --run-command "chmod 755 /root/check-db-seed.sh /root/db-seed.sh /root/status-backend.sh /root/configure-network-backend.sh"

    # Boot-time seed: runs db-seed.sh then disables itself
    virt-customize -a "${WORK_DISK}" \
        --write /etc/init.d/pw-db-seed:'#!/sbin/openrc-run
description="One-time database seed for Portable Workload"
depend() {
    need postgresql
    after postgresql
}
start() {
    ebegin "Seeding portable-workload database"
    /root/db-seed.sh
    rc-update del pw-db-seed default
    eend $?
}
' \
        --run-command "chmod 755 /etc/init.d/pw-db-seed" \
        --run-command "rc-update add pw-db-seed default"

elif [ "${VM_ROLE}" = "frontend" ]; then
    echo ">>> Frontend: installing Node.js + app..."

    virt-customize -a "${WORK_DISK}" \
        --write /etc/hostname:pw-frontend \
        --run-command "apk upgrade --no-cache" \
        --install nodejs,npm,curl \
        --run-command "mkdir -p /opt/portable-workload/public" \
        --copy-in "${APP_SRC}/server.js:/opt/portable-workload/" \
        --copy-in "${APP_SRC}/package.json:/opt/portable-workload/" \
        --copy-in "${APP_SRC}/public:/opt/portable-workload/" \
        --run-command "cd /opt/portable-workload && npm install --omit=dev" \
        --run-command "npm cache clean --force"

    # Environment file
    virt-customize -a "${WORK_DISK}" \
        --write /etc/portable-workload.env:"DB_HOST=pw-backend-svc
DB_PORT=5432
DB_USER=todo
DB_PASSWORD=todo
DB_NAME=todo
PORT=80"

    # OpenRC service
    virt-customize -a "${WORK_DISK}" \
        --write /etc/init.d/portable-workload:'#!/sbin/openrc-run
description="Portable Workload (Node.js frontend)"

depend() {
    need net
}

supervisor=supervise-daemon
command="/usr/bin/node"
command_args="/opt/portable-workload/server.js"
directory="/opt/portable-workload"
output_log="/var/log/portable-workload.log"
error_log="/var/log/portable-workload.log"
respawn_delay=5
respawn_max=0

start_pre() {
    . /etc/portable-workload.env
    if ! virt-what 2>/dev/null | grep -qi kvm; then
        RESOLVED=$(avahi-resolve -4 --name "${DB_HOST}.local" 2>/dev/null | awk '\''{print $2}'\'')
        if [ -n "${RESOLVED}" ]; then
            DB_HOST="${RESOLVED}"
        fi
    fi
    export DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME PORT
}' \
        --run-command "chmod 755 /etc/init.d/portable-workload" \
        --run-command "rc-update add portable-workload default"

    # Frontend helper scripts
    echo ">>> Embedding frontend helper scripts..."
    virt-customize -a "${WORK_DISK}" \
        --copy-in "${SCRIPTS_DIR}/restart-frontend.sh:/root/" \
        --copy-in "${SCRIPTS_DIR}/status-frontend.sh:/root/" \
        --copy-in "${SCRIPTS_DIR}/configure-network-frontend.sh:/root/" \
        --run-command "chmod 755 /root/restart-frontend.sh /root/status-frontend.sh /root/configure-network-frontend.sh"
fi

# ----- 5. Disable cloud-init -----
echo ">>> Disabling cloud-init..."
virt-customize -a "${WORK_DISK}" \
    --run-command "touch /etc/cloud/cloud-init.disabled" \
    --run-command "mkdir -p /run/openrc && touch /run/openrc/softlevel" \
    --run-command "rc-update del cloud-init default 2>/dev/null || true" \
    --run-command "rc-update del cloud-config default 2>/dev/null || true" \
    --run-command "rc-update del cloud-final default 2>/dev/null || true" \
    --run-command "rc-update del cloud-init-hotplugd default 2>/dev/null || true" \
    --run-command "rc-update del cloud-init-local boot 2>/dev/null || true"

# ----- 6. Clean up + seal -----
echo ">>> Cleaning caches..."
virt-customize -a "${WORK_DISK}" \
    --run-command "rm -rf /var/cache/apk/*"

echo ">>> Sealing image (virt-sysprep)..."
virt-sysprep -a "${WORK_DISK}"

echo ">>> Sparsifying working image..."
virt-sparsify --in-place "${WORK_DISK}"

# ----- 7. Pre-shrink ext4 filesystem -----
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

# ----- 8. Shrink-copy into target disk -----
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

# ----- 9. Convert to VMDK -----
echo ">>> Converting to VMDK (${VMDK_SUBFORMAT})..."
qemu-img convert -f qcow2 -O vmdk \
    -o "subformat=${VMDK_SUBFORMAT}" \
    "${GOLDEN_QCOW}" "${GOLDEN_VMDK}"

# ----- 10. Report -----
echo ""
echo "=== ${VM_ROLE} VM build complete ==="
echo "qcow2: ${GOLDEN_QCOW}"
echo "VMDK:  ${GOLDEN_VMDK}"
qemu-img info "${GOLDEN_QCOW}"
ls -lh "${GOLDEN_VMDK}"
