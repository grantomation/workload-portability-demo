# VM build pipelines

The current guest images use Alpine Linux. Tekton runs the build tools inside
OpenShift and publishes frontend and backend disks as qcow2 and vmdk artifacts.
The tooling container uses Fedora 44 with guestfs-tools and qemu-img; that is the
build environment, not the operating system installed in the guest VMs.

## Before building

Deploy the dashboard and assign the Build role. The build cluster needs storage,
an internal image registry, access to the public source and package/image sources,
and virtualization-capable workers for the smoke tests. Setup needs administrative
permissions and grants the pipeline service account privileged SCC access.

Use a published Git revision. The setup scripts and dashboard render source URL
and revision placeholders automatically. See [source configuration](public-source-of-truth.md).

## Run order

These are separate pipelines, not a single automatic seven-stage run. Start them
from the dashboard and wait for each dependency to succeed. Avoid concurrent runs
that change the shared workspace or artifact volume.

| Pipeline | Prerequisites and result |
|----------|--------------------------|
| `1-build-vm-builder-image` | Builds and publishes `golden-builder`; rerun when build tooling changes |
| `2-build-backend-vm` | Requires 1; builds PostgreSQL/Avahi backend disks |
| `3-build-frontend-vm` | Requires 1; builds Node.js/application/Avahi frontend disks |
| `4-vm-tests` | Requires 2 and 3; packages container disks, boots VMs and checks DNS, app API and guest readiness |
| `5-deploy-artifact-server` | Requires disk artifacts from 2 and 3; copies files and builds/deploys the artifact server |
| `6-build-migration-components-image` | Requires the artifact volume and exactly one uploaded `*.tar.gz`; builds an additional-component image |
| `7-create-ocp-providers` | Requires dashboard cluster settings and configured target roles; creates MTV OpenShift target Providers |

Pipeline 4 removes test resources after successful tasks and leaves failed-test
resources available for investigation. If an artifact server already exists, it
can refresh its files. Pipeline 5 can also fetch `management-ca.crt` from the
configured management endpoint.

Pipeline 7 creates credentials on remote target clusters, including a service
account with cluster-admin privileges, and registers them with MTV. It does not
create the legacy source Provider. Configure that Provider through MTV yourself.

## Additional pipelines

- `dash-build-deploy-lb` builds the load balancer using dashboard cluster settings.
- `dash-onboard-acm-clusters` imports registered OpenShift spokes into the ACM hub.
- `dash-px-license-activate` activates the supplied Portworx license on storage clusters.
- `mtv-target-routes` prepares target-side workload services and routes.

The load-balancer and ACM EventListeners support dashboard-triggered operations.
There is no full-build Git push webhook configured by this release.

## Storage and artifacts

The shared build PVC is `wp-build-workspace` in `workload-portability-build`.
It holds the cloned source, intermediates and `artifacts/` outputs:

- `pw_backend.qcow2` and `pw_backend.vmdk`
- `pw_frontend.qcow2` and `pw_frontend.vmdk`

The artifact server uses a separate `wp-artifacts` PVC. Copying uses SHA256 checks
to avoid recopying unchanged files. Its deployment is scaled down around volume
work to avoid conflicting mounts across nodes. ReadWriteOnce restricts writable
mounting to one node, not necessarily one pod.

## Guest construction and networking

`pipelines/scripts/build-vm.sh` downloads the Alpine base, grows a working disk,
installs packages and role-specific files, configures OpenRC services, cleans and
shrinks the filesystem, and exports the two disk formats. It installs the guest
agent, Avahi, platform networking and platform detection alongside the app/database.

The network helper explicitly checks for KVM. KVM guests use cluster DNS; other
environments use the legacy mDNS path. Legacy guests retain DHCP by default.
`configure-network-backend.sh` and `configure-network-frontend.sh` provide optional
manual static configuration using `ADDRESS`, `PREFIX`, `NETMASK`, `GATEWAY`, and
`DNS`. They immediately replace eth0 networking, so use them with console access.
The older numbered helpers and `legacy_network.sh` remain in source but are not
embedded by the current builder.

The workload records detected platform labels through `/run/portable-infra` and
`/api/infra`; see [the app reference](workload-app.md).

## Additional component archive

Upload exactly one compatible `*.tar.gz` through the artifact server before
running pipeline 6. The task rejects zero, multiple or empty candidate archives,
preserves the full tree including hidden files, and packages it under
`/migration-components/`. Running the resulting image copies that tree into `/opt`.
No supplier directory name is assumed.

Configure use of that image separately in the installed migration tool. Packaging
success does not prove compatibility, and the pipeline does not patch a source Provider.

## Troubleshooting and scope

Inspect the failed PipelineRun and task logs in the dashboard or OpenShift console.
Missing builder images require pipeline 1; missing disks require 2 and 3. A pending
test VM requires checking virtualization readiness and scheduling on the Build cluster.

The smoke tests exercise the built guests on OpenShift. They do not replace an
end-to-end source transfer and Portworx recovery test on your chosen infrastructure.
