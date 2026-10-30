# Artifact Server

## Overview

The artifact server (`03_artifact_server/`) is a lightweight HTTP file server that acts as the distribution point for VM disk images and legacy infrastructure migration assets. It is deployed on the Build cluster by Tekton pipeline 5.

## Why it exists

Tekton pipelines build golden VM images (qcow2 for OpenShift Virtualization, vmdk for legacy infrastructure). The server makes images available for browser downloads and accepts additional component archives. Build tasks use the workspace or artifact PVC directly; they do not require browser downloads.

Two categories of files:

- **Pipeline-built** (automatic): `pw_frontend.qcow2`, `pw_frontend.vmdk`, `pw_backend.qcow2`, `pw_backend.vmdk`
- **User-uploaded** (manual): provider component archive (user-supplied and subject to its supplier's license terms), virtualization manager CA certificate

The artifact server bridges these two worlds: the pipeline deposits its outputs, and the operator uploads vendor-licensed files through the web UI.

## Architecture

Zero-framework Node.js HTTP server. The only dependency is `busboy` for multipart upload parsing.

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Web UI (SPA) |
| `GET /api/files` | JSON file listing with sizes and timestamps |
| `GET /files/:name` | Stream file download (memory-efficient for multi-GB images) |
| `POST /api/upload` | Multipart upload (2 GB limit, one file at a time) |
| `DELETE /api/files/:name` | Delete a file |

### Input sanitization

`safeName()` strips path traversal via `path.basename()` plus a character whitelist (`[a-zA-Z0-9._-]`). Anything outside the whitelist is replaced with underscores.

## Web UI

The frontend (`public/index.html`) is a self-contained SPA. It organizes files into sections:

- **Frontend VM / Backend VM** -- shows pipeline-built images, tags them "Pipeline", prevents deletion
- **Additional component archive** -- shows `*.tar.gz` archives; management certificates are also recognized, tags them "Upload", allows deletion
- **Other** -- catch-all for anything that does not match the above

Missing expected files show as "not built yet" placeholders. The right panel has instructions for supplying a compatible component archive and extracting the virtualization manager CA certificate.

Includes drag-and-drop upload with progress bar.

## Deployment

Built by Tekton pipeline 5 and deployed as a two-container pod:

- Node.js server on port 8080
- OpenShift OAuth proxy sidecar on port 8443 (auto-generated TLS cert, OpenShift SSO)
- Route with `reencrypt` TLS termination
- 2 GiB RWO PVC (`wp-artifacts`) mounted at `/var/www/files`

### SELinux/PVC handling

On OpenShift, PVCs have SELinux labels derived from the namespace's MCS level. The pipeline dynamically reads the namespace's `openshift.io/sa.scc.supplemental-groups` and `openshift.io/sa.scc.mcs` annotations, then injects them into the pod spec as `fsGroup` and `seLinuxOptions.level`. Without this, the Node.js process would get "permission denied" when reading files written by a different pod (the copy-artifacts task).

### Why RWO, not RWX

The PVC is ReadWriteOnce: writable mounts are restricted to one node, though several pods on that node can share it. This is why the pipeline scales down the deployment before copying files, then scales back up. RWO was chosen because it is universally available across storage providers; RWX requires specific storage classes that may not exist on every cluster.

### SHA256 dedup

The copy-artifacts task checksums source and destination files and skips the copy if they match. For multi-GB VM images, this saves significant time on pipeline re-runs.

## Additional archive rules

Upload exactly one compatible `*.tar.gz` before running pipeline 6. It preserves
the archive's entire directory tree rather than assuming a supplier-specific
layout. Missing, multiple or empty archives stop the build. The resulting image
copies its contents to `/opt` when run; source Provider configuration is a separate
manual step in MTV. The management certificate filename is `management-ca.crt`.
