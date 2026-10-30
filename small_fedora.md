# Small Fedora Golden Image (< 1 GB)

Experimental feature, kept separate from the initial public release. Measurements
below are recorded development results, not a new validation of this extraction.
The default guest password is a demo value; do not substitute personal credentials
in distributable images. Hardware driver identifiers are retained for boot
compatibility and need review before publishing this feature.


Goal: a Fedora VM image comparable to the Alpine golden
(`01_installation_dashboard/pipelines/scripts/build-vm.sh`), under 1 GB.

**Decision (2026-10-30): pursue the scratch-container build (Option A, variant 3
below).** All other options are recorded here for reference.

## Results (2026-10-30)

Built and boot-tested on an Apple Silicon Mac (Podman, x86_64 under emulation).
Files: `small_fedora/` (`Containerfile`, `prune-modules.sh`, `dracut.conf`,
`journald.conf`, `build-disk.sh`, `boot-test.sh`).

**Size terms:** *total disk* = the virtual disk the VM sees (and the PVC MTV
creates). *Data on disk* = blocks actually written; empty space stays sparse,
so this is roughly what MTV copies (thin-provisioned source).

### Current (btrfs + zstd root, stripped)

| Build | Total disk | Data on disk | Root files → compressed | Free on `/` |
|---|---|---|---|---|
| **Base** (boot-tested) | **279 MiB** | **84 MiB** | 107 → 46 MiB | ~143 MiB |
| + frontend pkgs (`nodejs npm avahi avahi-tools virt-what curl-minimal`) | 431 MiB | 119 MiB | 208 → 81 MiB | — |
| + backend pkgs (`postgresql-server postgresql avahi ...`) | 359 MiB | 111 MiB | 173 → 73 MiB | — |

Role rows are packages only (no role config yet), not boot-tested.

Base boot test: UEFI → systemd-boot → login in ~35–40 s under full emulation;
`running`, no failed units; 53 MB used on `/`; DHCP/DNS on `eth0`; SSH works;
~240 MB RAM.

### How we got here

| Step | Total disk | Data on disk |
|---|---|---|
| First boot (ext4, 256 MiB free) | 570 MiB | ~262 MiB |
| Strip build leftovers, prune modules by category, slim initramfs | 287 MiB | ~176 MiB |
| Keep-list module pruning, `coreutils-single`, no `e2fsprogs` (ext4) | 223 MiB | 141 MiB |
| **btrfs + zstd root** | **279 MiB** | **84 MiB** |

btrfs makes the *total disk* bigger (see below) but cuts *data on disk* ~40%.
Compressed downloads are about equal: streamOptimized VMDK 72 MiB (btrfs) vs
76 MiB (ext4) — btrfs mainly helps what lives on disk and what MTV copies.

### What's in the base now

- **Packages (117):** `kernel-core` (+`kernel-modules-core`), systemd, udev,
  networkd, resolved, dbus-broker, util-linux-core, coreutils-single, iproute,
  openssh-server, qemu-guest-agent, glibc-minimal-langpack. Full list baked in
  at `/usr/share/small-fedora/packages.txt`.
- **ESP (32 MiB):** systemd-boot, `vmlinuz` (19 MiB), initramfs (14 MiB).
- **Kernel modules (22):** keep-list in the Containerfile (`KEEP_MODULES`) +
  their deps via `modprobe --show-depends`. Root-disk drivers are built in.
- **Removed after build:** dracut, systemd-boot package, kbd, rpm DB, hwdb text,
  duplicate vmlinuz/System.map, locale/man.
- **Guest setup:** journal in RAM (`Storage=volatile` — fewer writes, smaller
  changed-block set for warm/live migration), `net.ifnames=0` (stable `eth0`
  across legacy infrastructure/CNV), networkd DHCP, empty machine-id + no SSH host keys
  (generated per clone on first boot), vconsole/firstboot/oomd masked.

What's left in `/` is a long tail of shared libraries (OpenSSL, systemd, glibc,
glib for qemu-guest-agent) — no single big target remains in the base.

### How to build (from the repo root)

```bash
# 1. rootfs image (x86_64). Add role packages with --build-arg EXTRA_PACKAGES="..."
podman build --platform linux/amd64 -t localhost/small-fedora-rootfs small_fedora/

# 2. disk -> build-output/small_fedora/small_fedora.{qcow2,vmdk}
#    FS_TYPE=btrfs (default) | ext4; ROOT_FREE_MB (ext4 headroom); QCOW2_COMPRESS
podman run --rm --platform linux/arm64 \
  --mount type=image,src=localhost/small-fedora-rootfs,dst=/rootfs \
  -v "$PWD/small_fedora:/src:ro" -v "$PWD/build-output/small_fedora:/out" \
  registry.fedoraproject.org/fedora:44 /src/build-disk.sh

# 3. boot test (qemu + OVMF in a container; log in build-output/small_fedora/boot-test.log)
#    -e IMAGE=/out/<name>.qcow2, -e CHECK_CMD='...' to run extra commands over SSH
podman run --rm --platform linux/arm64 \
  -v "$PWD/small_fedora:/src:ro" -v "$PWD/build-output/small_fedora:/out" \
  registry.fedoraproject.org/fedora:44 /src/boot-test.sh
```

On an x86_64 host (or the OpenShift pipeline), drop the `--platform` flags.

### What we learned building it

- **The repo's golden-builder image isn't needed.** `--platform linux/amd64`
  handles the architecture; the disk step only writes bytes, so any Fedora
  container works (arm64 is faster on a Mac). libguestfs is avoided on purpose —
  its appliance VM would be emulated inside an emulated container.
- **No loop devices or privileges needed.** Partitions are built as files
  (`mkfs.btrfs --rootdir` / `mkfs.ext4 -d`, `mkfs.vfat` + `mcopy`) and `dd`'d
  into a GPT image from `sfdisk`.
- **kernel-core's scriptlets run dracut during the install**, using our
  `dracut.conf` — the initramfs is just moved to the ESP. `drivers=` in
  dracut.conf is exclusive: only `virtio_scsi vmw_pvscsi nvme` go in.
- **Built into Fedora's kernel:** `virtio_blk`, `virtio_pci`, `ahci`, `sd_mod`,
  `ext4`, `btrfs`. **Not available at all:** `mptsas` (LSI Logic SAS) — the
  legacy infrastructure VM must use a **PVSCSI, SATA or NVMe** controller.
- **Weak deps off drops D-Bus** → `systemd-logind` fails. Fixed by adding
  `dbus-broker` explicitly. `iproute` also added (no `ip` otherwise).
- **btrfs sizing quirks:** `mkfs.btrfs --rootdir` sizes the fs from the
  *uncompressed* files (237 MiB for the base) and ignores a smaller `-b`.
  `--shrink` fits it to the compressed data (85 MiB) but leaves it 100% full
  (first-boot jobs fail with ENOSPC), and `systemd-growfs`/the kernel refuse to
  resize btrfs below 256 MiB. So we take the 237 MiB — the unused part is
  sparse and costs nothing to copy, and it leaves real free space for the apps.
- **Removing kbd** needs `systemd-vconsole-setup` masked *and* its udev rule
  (`90-vconsole.rules`) deleted, or udev keeps trying to restart it.

### Not done yet / known gaps

- **Not tested on legacy infrastructure or through MTV — ON HOLD** (no legacy infrastructure environment
  available yet). Next real test once there is one: upload the VMDK
  (EFI, Secure Boot off, PVSCSI/SATA/NVMe controller), boot it, then MTV
  migrate one clone to CNV and compare transferred bytes with "data on disk".
- **Role config not ported** — only role packages were measured. Still needed
  (using the public Alpine builder as a behavioral reference): Postgres initdb
  (`--locale=C --encoding=UTF8`), `listen_addresses`, `pg_hba.conf`, seed
  service; frontend `npm install --omit=dev` then remove npm, env file, mDNS
  DB lookup start script, legacy infrastructure-network / platform-network services.
- **Apps are now the biggest target:** frontend adds ~100 MiB of files
  (35 MiB compressed), backend ~65 MiB (27 MiB). Node and Postgres both pull
  libicu (~35 MB); npm can be removed after the app install.
- **No SELinux** (no policy installed). Saves ~30–40 MB; decide if that's OK.
- **No dnf/rpm in the image** — packages are baked in at build time only.
- **Root doesn't grow** into a bigger provisioned disk (would need
  systemd-repart; growfs needs ≥256 MiB for btrfs).
- **Kernel updates aren't wired up** — kernel/initramfs are copied to the ESP at
  build time (fine for a golden image that gets rebuilt).
- **qemu-guest-agent** is udev-activated (needs the virtio-serial channel);
  verify on CNV. No open-vm-tools for legacy infrastructure (add if legacy infrastructure needs IP reporting).
- **Possible further cut — no initramfs (−14 MiB ESP):** root-disk drivers for
  virtio-blk and SATA are built in, so with a SATA controller on legacy infrastructure and
  virtio/SATA on CNV it could boot straight from the kernel (`root=PARTUUID=`).
  Not tried; it would rule out PVSCSI/NVMe.

## Is it possible?

Yes. Realistic target: **~400–600 MB used**, stretch **~300–400 MB**. It will not
match Alpine's 194 MB — glibc, systemd and Fedora's kernel are all larger.

The earlier attempts didn't fail because of the build method; they failed because
of the **package set**. `fedora-min.yml` installs `@core` with default settings,
which pulls in far more than a VM needs.

---

## Why the earlier attempts stalled

Earlier experimental approaches (not included in this public feature):

| Playbook | Approach | Result |
|---|---|---|
| `fedora.yml` / `fedora-small.yml` | Fedora Cloud Base + shrink | ~1.7 GB (btrfs chunk floor) |
| `fedora-small-virtbuilder.yml` | virt-builder | 6 GB template minimum |
| `fedora-ext4.yml` | Cloud Base converted to ext4 | no gain (Cloud Base is zstd-compressed) |
| `fedora-min.yml` | kickstart `@core` + ext4 | 1.38 GB base |

Likely causes in the `fedora-min.yml` kickstart (line ~126), biggest first:

| Cause | Fix |
|---|---|
| Weak deps ("recommended" packages) installed by default | `--exclude-weakdeps` / `install_weak_deps=False` |
| `@core` brings firewalld, sssd, audit, etc. | `--nocore` + explicit package list |
| Rescue kernel + initramfs in `/boot` (~100 MB) | exclude `dracut-config-rescue` |
| Full kernel module set | only `kernel-core` + `kernel-modules-core` |
| `ansible-core` drags in Python (~150 MB) | drop it; dnf5 no longer needs Python |
| All glibc language packs | `glibc-minimal-langpack` |
| grub2 + shim | systemd-boot (~1 MB); Secure Boot is already off for Alpine |
| dnf cache and metadata | clean it, or remove dnf after the build |

**legacy infrastructure driver check:** the VM must boot on legacy infrastructure before MTV moves it. Confirm
the drivers are in the slim module set:

```bash
rpm -ql kernel-modules-core | grep -E 'vmw_pvscsi|vmxnet3'
```

---

## Options considered

### Option 0: fix the existing kickstart (cheapest)

Apply the table above to `fedora-min.yml`: `%packages --nocore --exclude-weakdeps`,
`-dracut-config-rescue`, `kernel-core`, no ansible. A few lines of change; may get
under 1 GB on its own. Still needs Anaconda, a 4 GB build VM, and the shrink step.

### Option A: build from scratch, then convert to a disk (CHOSEN)

The win is not the container format — it's installing packages straight into an
empty root instead of running Anaconda. Three variants:

1. **mkosi** — systemd-project tool built for exactly this. Package list in,
   bootable GPT disk image out; `qemu-img convert` to qcow2/VMDK. No VM, no
   installer. Probably needs a privileged pod or user namespaces in Tekton.
2. **By hand with `dnf --installroot`** in the existing Fedora 44 builder
   container, then build the filesystem straight from the directory:
   - `mkfs.ext4 -d <dir>`, or
   - `mkfs.btrfs --rootdir <dir> --compress=zstd --shrink` — keeps btrfs
     compression without the shrink floor we hit before.
3. **`FROM scratch` container, then `podman export`** — same as variant 2, but the
   rootfs is an OCI image. Easy to iterate on and inspect (`podman image ls`,
   `podman run ... du`). Plan below.

Not recommended: **bootc / bootc-image-builder** — goes Containerfile → disk image
directly, but the standard Fedora bootc base image is heavy.

### Option B: PXE / netboot (rejected)

- **Network install:** `fedora-min.yml` already does this (`virt-install --location`).
  Install method doesn't change the final size.
- **Diskless boot:** the OS runs from RAM/NFS, so there's no disk for MTV to
  migrate, and it needs PXE infrastructure on both the legacy infrastructure and OpenShift
  networks.

---

## Plan: scratch-container build

### 1. Build the rootfs (multi-stage Containerfile)

- **Stage 1 (`fedora:44`):** `dnf --installroot=/rootfs --use-host-config
  --setopt=install_weak_deps=False --setopt=tsflags=nodocs install ...`
- **Stage 2 (`FROM scratch`):** `COPY --from=builder /rootfs /`

Starting package list (adjust per role):

```
kernel-core systemd systemd-networkd openssh-server qemu-guest-agent
glibc-minimal-langpack systemd-boot-unsigned
nodejs avahi            # frontend role; postgresql-server for backend
```

### 2. Measure before going further

```bash
du -sh /rootfs
du -sh /rootfs/* | sort -h
```

If this is ~500 MB, < 1 GB is safe. Trim the biggest offenders here.

### 3. Make it bootable (still in the builder stage)

- **initramfs:** generic (`hostonly=no`) with an explicit
  `add_drivers+=" virtio_blk virtio_scsi virtio_net vmw_pvscsi vmxnet3 "`. A
  host-only build matches the builder's hardware and won't boot after migration.
  Drop the dracut config in *before* installing `kernel-core` — the kernel's
  install scriptlets may try to generate an initramfs during the dnf install.
- **Bootloader:** systemd-boot (or a UKI) in the ESP. Secure Boot off, as with Alpine.
- **System config:** `/etc/fstab`, empty `/etc/machine-id`, root password, sshd
  `PermitRootLogin yes`, enable `qemu-guest-agent` + networking.
- **SELinux:** pre-label with `setfiles`, or touch `/.autorelabel` (costs an extra
  boot on first start).

### 4. Export and build the disk

```bash
podman create --name small-fedora <image>
podman export small-fedora > rootfs.tar
```

Then: GPT disk with ESP (FAT) + root partition, root filesystem populated from the
extracted tar (`mkfs.ext4 -d` or `mkfs.btrfs --rootdir --compress=zstd --shrink`),
copy kernel/initramfs/systemd-boot into the ESP.

### 5. Convert

```bash
qemu-img convert -f raw -O qcow2 disk.raw small_fedora.qcow2
qemu-img convert -f raw -O vmdk -o subformat=monolithicSparse disk.raw small_fedora.vmdk
```

### 6. Test

- Boot test with plain (non-Secure-Boot) OVMF using the included `small_fedora/boot-test.sh` harness.
- Check: `lsmod | grep virtio`, sshd up, guest agent, `df -h /`.
- Boot on legacy infrastructure, then MTV raw-copy one clone; confirm "Convert image to kubevirt"
  is absent and it boots clean on OpenShift CNV.

---

## Open questions

- **Which size must be < 1 GB?** Space used inside the guest, the qcow2/VMDK file
  size, or the provisioned disk? A compressed `streamOptimized` VMDK can be much
  smaller than the space used inside the guest.
- **Keep dnf in the image?** `build-vm.sh` bakes role packages in at build time,
  so the runtime image may not need a package manager.
- **Keep SELinux?** The policy store is ~30–40 MB.
- **NetworkManager vs systemd-networkd?** If role playbooks still use `nmcli`, keep
  NetworkManager (~20–30 MB more).
- **Pipeline privileges:** loop devices / `mkfs` in a Tekton pod probably need
  privileged mode, or do the disk steps through libguestfs (`virt-make-fs`,
  `guestfish`) as the current pipeline does.
