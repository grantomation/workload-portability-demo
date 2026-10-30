# Workload Portability

A demonstration of moving a stateful, two-VM application from legacy
infrastructure to OpenShift and between OpenShift clusters. The frontend displays
a map; each stop records the detected infrastructure platform in PostgreSQL.
The database travels with the backend VM's disk.

The reference journey is legacy infrastructure → on-prem OpenShift → ARO → ROSA
→ OSD on GCP → on-prem OpenShift. Transfers and failovers can interrupt service;
the application retries database connections while the destination comes up.

## What is included

- An installation dashboard for cluster registration, operator installation,
  storage configuration, build pipelines, ACM onboarding, and DR controls.
- Tekton builds for Alpine frontend and backend VMs, smoke tests, and an artifact server.
- A visual load balancer for switching the audience's application endpoint.
- Templates for MTV targets and Portworx asynchronous replication.

Cluster provisioning and archived demo scripts are outside this release.

## What you bring

Start with one suitable cluster for the dashboard, builds and VM tests; ARO is
an optional starting point. Add the remaining clusters when ready for the full
reference journey of an ACM hub and four OpenShift spokes. Hub placement is your
choice, and it may share the Build cluster where capacity allows. The current DR
chain excludes ACM-role clusters. Bring administrative access,
working cluster networking/storage/registry, and virtualization-capable workers
for the clusters that run VMs. See [cluster prerequisites](00_build_clusters/README.md).

Outside the clusters, supply the source environment, an S3-compatible bucket and
credentials, the cloud permissions/credentials needed by Portworx, and a Portworx
license. Additional component archives, when needed by your migration setup, are
user-supplied. Configure the source Provider and its credentials in MTV manually.

## Getting started

Run these commands from the repository root, using a Git clone whose origin and
selected commit are publicly readable. Local unpublished edits are not uploaded
by setup. Required local tools are `oc`, Git, Python 3, Bash, and OpenSSL.

```sh
oc login <build-cluster-api>
bash 01_installation_dashboard/setup.sh
```

1. Open the dashboard URL printed by setup. Register and test your OpenShift
   clusters, then add the legacy environment using its management endpoint.
2. Assign the Build role to your build cluster. Save the global S3 settings before
   assigning the ACM role to the hub, then onboard your spokes through the dashboard.
3. As you add the other clusters, assign the remaining roles, configure each storage cluster's cloud credentials,
   apply its StorageCluster, and activate the Portworx license. Follow the
   [dashboard guide](docs/installation-dashboard.md) for the boundaries of each action.
4. Run the individual [build pipelines](docs/vm-build-pipeline.md) in dependency
   order. You can start these as soon as the Build role is ready, before finishing
   the multicluster setup. They build Alpine VM disks, test them, and deploy the artifact server.
5. Configure the initial transfer in MTV and use the DR controls for subsequent
   hops. Follow the [setup runbook](docs/setup-runbook.md), which marks the remaining
   sizing and source-VM import details to verify.

Credentials belong in the dashboard settings, not in committed files. Setup
discovers the source URL and revision automatically; see
[source configuration](docs/public-source-of-truth.md) for overrides and upgrades.

## Documentation

| Guide | Contents |
|-------|----------|
| [Architecture](docs/architecture.md) | Components, topology, data and control paths |
| [Installation dashboard](docs/installation-dashboard.md) | Setup, roles, credentials and operator behavior |
| [VM build pipeline](docs/vm-build-pipeline.md) | Pipeline dependencies, Alpine images and guest networking |
| [Workload app](docs/workload-app.md) | Platform detection, database, API and local preview |
| [Artifact server](docs/artifact-server.md) | Disk downloads, uploads and additional archives |
| [Load balancer](docs/load-balancer.md) | Routing, controls and deployment |
| [Portworx DR](docs/portworx-dr.md) | Pair ordering, protection groups and cleanup controls |
| [Setup runbook](docs/setup-runbook.md) | Provisioning, dashboard setup, builds and source-VM preparation |
| [File inventory](docs/FILE-INVENTORY.md) | Files in this release |

## Repository layout

| Directory | Purpose |
|-----------|---------|
| `00_build_clusters/` | Prerequisites only; no provisioning automation |
| `01_installation_dashboard/` | Dashboard, deployment manifests, operators, storage templates and pipelines |
| `02_workload/` | Application embedded in the Alpine frontend VM |
| `03_artifact_server/` | Disk and additional-component upload/download service |
| `04_loadbalancer_app/` | Visual reverse proxy, local deployment examples and tests |
| `scripts/` | Source URL/revision discovery and manifest rendering |
| `tests/` | Local regression checks |
| `docs/` | Current references and the recovered runbook draft |

This release still needs end-to-end validation on the intended clusters; local
checks do not establish successful builds, transfers or recovery in your environment.
