# Architecture

The demo has a control plane on OpenShift and a two-tier application inside Alpine
VMs. MTV handles the initial transfer from legacy infrastructure. Portworx handles
subsequent asynchronous replication and recovery between OpenShift clusters.

## Reference topology

Start with one suitable cluster for the dashboard, builds and VM tests. ARO is
an optional combined starting point. Hub placement is a deployment choice: the
hub can share the Build cluster if capacity allows, or run elsewhere. Add spokes
when ready for the cross-cluster demonstration.

In the full reference topology, an ACM hub coordinates four spokes: on-prem OpenShift, ARO, ROSA and OSD on GCP.
The hub hosts Portworx Multi-Cluster. Spokes that hold the workload run OpenShift
Virtualization and Portworx Enterprise. One suitable cluster also has the Build
role and hosts the dashboard, Tekton builds, artifact server and load balancer.
Roles describe responsibilities; they do not provision infrastructure.

The dashboard orders the DR chain by the load-balancer positions of Portworx-role
clusters, excluding the ACM hub, then joins the last cluster back to the first.
The cluster labels in the reference journey are examples, not hard-coded credentials
or endpoints. Verify the displayed order before creating pairs.

## Control plane

| Component | Responsibility |
|-----------|----------------|
| Installation dashboard | Register clusters, test access, assign roles, apply templates and start operations |
| Tekton | Build images, test VMs, deploy services, onboard ACM clusters and activate licenses |
| ACM | Register managed clusters and host the multicluster control plane |
| MTV | Configure and execute the initial transfer; source Provider setup is manual |
| Portworx | Store VM disks and replicate the protected namespace between spokes |

The dashboard uses Kubernetes APIs and streams progress to the browser. Cluster
credentials live in `installation-dashboard-clusters`; runtime settings including
S3, cloud credentials and licenses live in `installation-dashboard-config`.
Both are Kubernetes Secrets. Local development falls back to JSON files under
its data directory. These files must stay outside source control.

Static role/operator defaults come from `01_installation_dashboard/app/config.yaml`.
A single user environment-file import and full preflight/apply workflow have not
been implemented. Current users enter environment settings through the dashboard.

## Build and distribution

The build workspace is `wp-build-workspace` in `workload-portability-build`.
Pipeline 1 builds the tooling container; pipelines 2 and 3 build the backend and
frontend Alpine disks. Pipeline 4 boots test VMs. Pipeline 5 copies the disk
artifacts to `wp-artifacts` and deploys the authenticated artifact server.

The optional component pipeline packages exactly one uploaded `*.tar.gz` archive,
preserving its directory tree. It does not configure the source Provider. The
OpenShift-provider and target-route pipelines prepare target-side integration.
See [build details](vm-build-pipeline.md) for dependencies and manual boundaries.

Setup derives the public source URL and exact Git revision from the checkout.
Remote builds fetch that revision; uncommitted files are not included. Source
placeholders are rendered at setup/deployment time rather than edited in the repo.

## Workload and networking

`pw-frontend` runs Node.js on port 8080; `pw-backend` runs PostgreSQL. The protected
namespace is `portable-workload`, with `pw-frontend-svc` and `pw-backend-svc`
providing stable service names on OpenShift.

The guest networking helper uses a KVM check to choose cluster DNS or Avahi/mDNS.
Legacy infrastructure guests retain DHCP unless an operator explicitly runs one
of the included static-network configuration helpers. The application retries
connections to the backend and exposes database availability through `/health`.

The separate platform detector writes `/run/portable-infra`; the frontend exposes
it through `/api/infra`. Each new map stop stores that platform label. Host headers
and the load balancer's URL are not used to identify the platform.

The visual load balancer selects which backend serves the audience. Switching it
does not migrate disks, start VMs or trigger a failover. A working destination
must exist first. Recovery can involve downtime and depends on successful replication.

## Recovery and cleanup

DR pairs and protection groups are created on the ACM hub. By default the
`portable-workload` namespace is replicated every 15 minutes, with destination
applications left stopped. Failover remains an explicit operator action.

The dashboard offers status, audit and cleanup controls. “Prepare On-Prem” deletes
the protected namespace on the last non-ACM Portworx cluster in the ordered chain;
it does not identify the target from its name. See [DR details](portworx-dr.md).

The [setup runbook](setup-runbook.md) covers preparation from cluster provisioning
through VM builds and source import, with outstanding sizing/import details marked.
