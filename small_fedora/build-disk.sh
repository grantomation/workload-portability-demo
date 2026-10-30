#!/usr/bin/env bash
set -euo pipefail

# Turn the small-fedora rootfs image into a bootable GPT disk (qcow2 + VMDK).
# No loop devices, no libguestfs: each partition is built as a plain file
# (mkfs.ext4 -d / mkfs.vfat + mtools), then dd'd into a GPT image made by sfdisk.
#
# Runs inside any Fedora container (arch doesn't matter — it only writes bytes),
# with the rootfs image mounted at /rootfs and an output dir at /out:
#
#   podman run --rm \
#     --mount type=image,src=localhost/small-fedora-rootfs,dst=/rootfs \
#     -v "$PWD/small_fedora:/src:ro" -v "$PWD/build-output/small_fedora:/out" \
#     registry.fedoraproject.org/fedora:44 /src/build-disk.sh

ROOTFS="${ROOTFS:-/rootfs}"
OUTPUT_DIR="${OUTPUT_DIR:-/out}"
IMAGE_NAME="${IMAGE_NAME:-small_fedora}"
FS_TYPE="${FS_TYPE:-btrfs}"            # btrfs (zstd-compressed root) | ext4
ROOT_FREE_MB="${ROOT_FREE_MB:-64}"     # headroom on / beyond the installed files
MAX_USED_PCT="${MAX_USED_PCT:-90}"     # fail the build if / would start fuller than this
QCOW2_COMPRESS="${QCOW2_COMPRESS:-true}"
VMDK_SUBFORMAT="${VMDK_SUBFORMAT:-monolithicSparse}"

WORK_DIR=/tmp/disk-build
ROOT_IMG="${WORK_DIR}/root.img"
ESP_IMG="${WORK_DIR}/esp.img"
DISK_RAW="${WORK_DIR}/disk.raw"

# GPT partition type GUIDs (Discoverable Partitions Spec)
ESP_TYPE="C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
ROOT_TYPE="4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709"   # Linux root (x86-64)

if ! command -v mkfs.ext4 >/dev/null || ! command -v mcopy >/dev/null \
   || ! command -v sfdisk >/dev/null || ! command -v qemu-img >/dev/null; then
    echo ">>> Installing disk tools..."
    dnf install -y -q e2fsprogs dosfstools mtools util-linux qemu-img >/dev/null
fi
if [ "${FS_TYPE}" = "btrfs" ] && ! command -v mkfs.btrfs >/dev/null; then
    dnf install -y -q btrfs-progs >/dev/null
fi

rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}/root" "${OUTPUT_DIR}"

# ----- 1. Stage the root tree (everything except the ESP staging dir) -----
echo ">>> Staging root filesystem..."
tar -C "${ROOTFS}" --exclude=./efi -cf - . | tar -C "${WORK_DIR}/root" -xpf -
mkdir -p "${WORK_DIR}/root/efi"
case "${FS_TYPE}" in
    ext4)  ROOT_FSTAB="LABEL=fedora-root  /     ext4   defaults          0 1" ;;
    btrfs) ROOT_FSTAB="LABEL=fedora-root  /     btrfs  compress=zstd:1   0 0" ;;
    *)     echo "Unknown FS_TYPE=${FS_TYPE}" >&2; exit 1 ;;
esac
sed -i "s|^LABEL=fedora-root .*|${ROOT_FSTAB}|" "${WORK_DIR}/root/etc/fstab"

# ----- 2. Root filesystem (built as a file, sized to the content + headroom) -----
ROOT_USED=$(du -sm "${WORK_DIR}/root" | cut -f1)
if [ "${FS_TYPE}" = "btrfs" ]; then
    echo ">>> Creating btrfs root (zstd)..."
    # mkfs.btrfs --rootdir sizes the fs itself from the UNCOMPRESSED file size
    # (ignores a smaller -b), so the partition is whatever it produces — the
    # unused part stays sparse, so it costs nothing to copy. --shrink would fit
    # it to the compressed data but leaves no free space at all, and btrfs
    # won't grow at boot below 256 MiB, so neither shrink-then-grow works.
    truncate -s 0 "${ROOT_IMG}"
    mkfs.btrfs -q -f -L fedora-root -m single -d single --compress zstd:15 \
        --rootdir "${WORK_DIR}/root" -b $(( ROOT_USED + ROOT_FREE_MB ))M "${ROOT_IMG}" >/dev/null
    ROOT_MB=$(( ($(stat -c %s "${ROOT_IMG}") + 1048575) / 1048576 ))
    SUPER=$(btrfs inspect-internal dump-super "${ROOT_IMG}")
    BYTES_USED=$(awk '/^bytes_used/{print $2}' <<< "${SUPER}")
    BYTES_TOTAL=$(awk '/^total_bytes/{print $2}' <<< "${SUPER}")
    ROOT_USED_PCT=$(( BYTES_USED * 100 / BYTES_TOTAL ))
    echo "    root: ${ROOT_USED} MiB of files -> $(( BYTES_USED / 1048576 )) MiB compressed -> ${ROOT_MB} MiB partition"
else
    echo ">>> Creating ext4 root..."
    ROOT_MB=$(( ROOT_USED + ROOT_USED / 10 + ROOT_FREE_MB ))   # +10% ext4 metadata
    mkfs.ext4 -q -L fedora-root -m 0 -d "${WORK_DIR}/root" "${ROOT_IMG}" "${ROOT_MB}M"
    BLOCKS=$(dumpe2fs -h "${ROOT_IMG}" 2>/dev/null | awk -F: '/^Block count/{print $2}')
    FREE=$(dumpe2fs -h "${ROOT_IMG}" 2>/dev/null | awk -F: '/^Free blocks/{print $2}')
    ROOT_USED_PCT=$(( (BLOCKS - FREE) * 100 / BLOCKS ))
    echo "    root: ${ROOT_USED} MiB of files -> ${ROOT_MB} MiB partition"
fi
echo "    root will start ${ROOT_USED_PCT}% full"
if [ "${ROOT_USED_PCT}" -gt "${MAX_USED_PCT}" ]; then
    echo "ERROR: root would start ${ROOT_USED_PCT}% full (limit ${MAX_USED_PCT}%)." >&2
    echo "       Raise ROOT_FREE_MB (now ${ROOT_FREE_MB}) or trim the package set." >&2
    exit 1
fi

# ----- 3. ESP (FAT32 with 512-byte clusters, so it can go down to ~40 MiB) -----
ESP_USED=$(du -sm "${ROOTFS}/efi" | cut -f1)
ESP_MB=$(( ESP_USED + 8 ))
[ "${ESP_MB}" -lt 40 ] && ESP_MB=40
echo "    esp:  ${ESP_USED} MiB used -> ${ESP_MB} MiB partition"

echo ">>> Creating ESP..."
mkfs.vfat -n ESP -F 32 -s 1 -S 512 -C "${ESP_IMG}" $(( ESP_MB * 1024 )) >/dev/null
mcopy -s -i "${ESP_IMG}" "${ROOTFS}"/efi/* ::/

# ----- 4. Assemble the GPT disk -----
echo ">>> Assembling GPT disk..."
DISK_MB=$(( 1 + ESP_MB + ROOT_MB + 1 ))    # 1 MiB lead-in + backup GPT
truncate -s "${DISK_MB}M" "${DISK_RAW}"
sfdisk -q "${DISK_RAW}" <<EOF
label: gpt
start=1MiB, size=${ESP_MB}MiB, type=${ESP_TYPE}, name="ESP"
size=${ROOT_MB}MiB, type=${ROOT_TYPE}, name="fedora-root"
EOF
dd if="${ESP_IMG}"  of="${DISK_RAW}" bs=1M seek=1                conv=notrunc,sparse status=none
dd if="${ROOT_IMG}" of="${DISK_RAW}" bs=1M seek=$(( 1 + ESP_MB )) conv=notrunc,sparse status=none
sfdisk -l "${DISK_RAW}"

# ----- 5. Convert -----
echo ">>> Converting to qcow2 + VMDK..."
QCOW2_OPTS=()
[ "${QCOW2_COMPRESS}" = "true" ] && QCOW2_OPTS=(-c -o compression_type=zstd)
qemu-img convert -f raw -O qcow2 "${QCOW2_OPTS[@]}" "${DISK_RAW}" "${OUTPUT_DIR}/${IMAGE_NAME}.qcow2"
qemu-img convert -f raw -O vmdk -o subformat="${VMDK_SUBFORMAT}" \
    "${DISK_RAW}" "${OUTPUT_DIR}/${IMAGE_NAME}.vmdk"

echo ""
echo "=== Small Fedora disk build complete ==="
echo "  Total disk size: ${DISK_MB} MiB (root ${ROOT_MB} + ESP ${ESP_MB})"
# Blocks actually written (zero/unused blocks stay sparse): what MTV copies
echo "  Data on disk:    $(du -m "${DISK_RAW}" | cut -f1) MiB"
ls -lh "${OUTPUT_DIR}/${IMAGE_NAME}".*
