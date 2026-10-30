#!/usr/bin/env bash
set -euo pipefail

# Keep-list kernel module pruning: keep only the named modules plus everything
# modprobe says they depend on (hard deps and softdeps), delete the rest.
# Starting from what we want leaves fewer stragglers than deleting categories.
#
#   prune-modules.sh <rootfs> <kver> <module> [<module> ...]

ROOT="$1"; KVER="$2"; shift 2
MODDIR="${ROOT}/usr/lib/modules/${KVER}"

declare -A KEEP=()
for m in "$@"; do
    if ! deps=$(chroot "${ROOT}" modprobe --set-version "${KVER}" --show-depends "${m}" 2>/dev/null); then
        echo "    (no module named ${m} — skipped)"
        continue
    fi
    while read -r kind path _; do
        # "insmod /lib/modules/<kver>/kernel/...ko.xz" — builtins print "builtin <name>"
        [ "${kind}" = "insmod" ] && KEEP["kernel/${path#*/kernel/}"]=1
    done <<< "${deps}"
done

BEFORE=$(find "${MODDIR}/kernel" -type f -name '*.ko*' | wc -l)
while IFS= read -r ko; do
    [ -n "${KEEP[${ko#"${MODDIR}/"}]+x}" ] || rm -f "${ko}"
done < <(find "${MODDIR}/kernel" -type f -name '*.ko*')
find "${MODDIR}/kernel" -type d -empty -delete
chroot "${ROOT}" depmod -a "${KVER}"

echo "    Kernel modules: ${BEFORE} -> ${#KEEP[@]} ($(du -sh "${MODDIR}" | cut -f1) in ${MODDIR#"${ROOT}"})"
