# Setup runbook

This guide prepares the environment and builds the application before the demo.
The current guests use Alpine Linux. Cluster provisioning happens outside this
repository. Sizes below are recovered provisioning presets, not measured minimums
or a statement of current cloud platform support.

## 1. Provision the clusters and external prerequisites

You can start with one suitable OpenShift cluster. Deploy the dashboard there,
assign the Build role, and build and test the Alpine VMs before provisioning the
rest of the demo environment or importing anything into legacy virtualization.

ARO is a useful optional starting point for this combined setup: the existing
preset uses workers that meet the dashboard's virtualization checks without a
separate bare-metal pool. Starting with one cluster lets you defer the cost of
additional clusters while preparing the assets. Choose the platform that suits
your access, capacity, region and budget; ARO is not a requirement.

Hub placement is also the demo builder's deployment decision. The initial cluster
can host ACM and the multicluster control plane if it has sufficient capacity, or
you can use a separate hub on another suitable platform. Add the workload spokes
when ready for the cross-cluster demonstration. The full reference journey uses
four spokes, but they do not all need to exist before the first build.

The current DR implementation excludes any ACM-role cluster from the workload
replication chain. If the initial cluster becomes the hub, use separate spokes
for the DR hops; it can continue hosting the dashboard and build/test services.

### Recovered sizing

These examples were recovered from the provisioning profiles. They illustrate
possible deployments, not a requirement to provision every row at the start:

| Cluster responsibility | Provisioning preset found | Why / outstanding requirement |
|------------------------|---------------------------|-------------------------------|
| ARO build/workload spoke | 3 workers, `Standard_D8s_v5`; control-plane size `Standard_D8s_v5`; worker OS disks 128 GB | Builds, VM smoke tests and optional workload/storage roles share worker capacity. The dashboard checks for at least 8 cores on matching Azure worker types. |
| Optional separate hub (ARO example) | Same Storage profile: 3 `Standard_D8s_v5` workers | ACM, observability and the multicluster control plane need capacity. A separate hub and its platform are deployment choices; allow combined capacity when sharing the Build cluster. |
| ROSA workload spoke | Default worker type `m5.2xlarge`; count defaults to the number of availability zones | Storage and platform services use the regular pool. An optional virtualization pool adds 1 `c5.metal`; its enablement must be explicit. |
| GCP workload spoke | Storage workflow selects 3 `n2-standard-8` workers | Storage and platform services use the regular pool. An optional virtualization pool adds 1 `c3-highcpu-192-metal`; its enablement must be explicit. |
| Self-managed OpenShift target | Storage profile selects 3 `m5.2xlarge` workers; control-plane type `m5.xlarge` | The recovered implementation deploys this cluster on AWS. Its optional virtualization worker uses `c5.metal`. This is not a sizing specification for physical on-prem hardware. |

The top-level Storage selection alone does not establish that the optional
virtualization pools are enabled. These are source-code presets, not a live
cluster inventory. Confirm worker counts, extra pools and actual allocatable
capacity before publishing a final sizing recommendation. A single virtualization
worker also gives no second VM-capable worker for host-level live migration.

The dashboard uses three storage workers as a resilience guideline and warns
below 48 GiB aggregate allocatable worker memory for ACM. Those checks are not
complete workload sizing calculations. Budget for operators, observability,
builds and test VMs, not just the two small application VMs.

StorageCluster templates request 150 GiB cloud data devices. AWS templates also
request 64 GiB metadata devices; the GCP template requests a 64 GiB KVDB device.
These are additional to node OS disks. Confirm placement and eligible node counts
when estimating total provisioned storage.

Also prepare:

- Administrative cluster access and connectivity from the dashboard/build cluster
  to each target API, registries, package sources and required service endpoints.
- An S3-compatible bucket, endpoint, region and credentials.
- Cloud storage permissions/credentials and a Portworx license.
- A source virtualization environment with network, datastore and permission to
  create the two VMs; additional component archives if required by its integration.

Exact supported versions, cloud quota/region availability and CPU/RAM totals
remain to be verified for the chosen environment. S3, cloud storage credentials
and licensing are needed for their associated management/storage stages, not
simply to start building and testing VM images.

## 2. Deploy the installation dashboard to the Build cluster

From the root of a published Git clone, with `oc`, Git, Python 3, Bash and OpenSSL:

```sh
oc login <build-cluster-api>
bash 01_installation_dashboard/setup.sh
```

Open the URL printed by setup. The script deploys the dashboard; assigning the
Build role later installs the build and VM-test resources. It discovers the source
URL and exact revision automatically. That revision must be remotely readable;
local uncommitted changes are not uploaded by setup.

Building and testing the guests on OpenShift does not require them to have been
imported into the legacy environment first.

## 3. Enter the environment details

Register and test the initial cluster in the dashboard. Add other OpenShift
clusters as you provision them, and the legacy environment when its management
endpoint is available. Save the global S3 settings before
installing ACM. Enter cloud credentials and licensing through the dashboard
settings rather than editing or committing files in this repository.

Choose the cluster display/load-balancer order deliberately: it also determines
the Portworx replication chain. Runtime configuration is stored in Kubernetes
Secrets. A single environment-file import workflow is not implemented yet.

## 4. Assign roles and complete configuration

Assign Build first; this is enough to proceed to the image builds and VM tests
in step 5 once the Build prerequisites are ready. The remaining role and storage
setup can follow as the environment grows.

When ready for multicluster setup, assign ACM to your chosen hub and use onboarding to
import the spokes. Assign Virtualization to workload targets, MTV to the initial
transfer target, and Portworx to storage spokes as needed. Roles may overlap.

After installing the Portworx operator, configure cloud credentials, apply each
StorageCluster and activate the license. Wait for storage readiness. Role
assignment alone does not complete this work. Confirm the target services/routes
and virtualization readiness before attempting the initial transfer.

Configure the source Provider and credentials manually in MTV. Additional
component-image integration, mappings and the migration plan require separate
configuration; the dashboard does not create the source Provider.

See [installation dashboard](installation-dashboard.md) for role behavior and
[current DR controls](portworx-dr.md) for ordering and destructive cleanup actions.

## 5. Build and test the assets

Use the dashboard to run the separate pipelines in dependency order:

1. Build the tooling image with pipeline 1.
2. Build the backend and frontend Alpine disks with pipelines 2 and 3.
3. Run pipeline 4 to boot and test the VMs on OpenShift. Investigate failed tests
   before using the images elsewhere.
4. Run pipeline 5 to publish the disk files through the artifact server.

Avoid overlapping runs that modify the shared workspace. Pipeline 6 packages an
optional additional-component archive and requires exactly one uploaded `*.tar.gz`.
Pipeline 7 configures OpenShift target Providers; it does not build VM disks.
Build/deploy the load balancer separately after the cluster settings are ready.

See [VM build pipelines](vm-build-pipeline.md) for outputs and dependencies.

## 6. Import and check the source VMs

Download `pw_frontend.vmdk` and `pw_backend.vmdk` from the authenticated artifact
server. Import the disks and create the frontend and backend VMs on the legacy
virtualization platform. Copying the disks alone is not sufficient.

The final procedure still needs the platform-neutral VM settings: CPU/RAM, boot
mode, disk/controller and network-adapter settings, network attachment, import
method and any disk conversion. These must be verified against the generated
images and the chosen source platform before this step is considered complete.

The current guests use DHCP by default. Verify addressing, backend discovery,
database readiness through `/health`, application access and a saved map stop.
Set up any required static addressing through the documented guest helpers with
console access. Confirm the source VMs appear in MTV and that the chosen mappings
and migration plan target the correct storage and network.

## 7. Ready to run the demo

Confirm the initial application works, the source Provider and plan are ready,
the target services/routes exist, storage is healthy and the load balancer can
reach the intended backends. Check replication readiness before each later hop.

Then perform the initial transfer and subsequent DR hops. A separate presenter
procedure should cover failover, endpoint switching, visible verification and
cleanup. This setup runbook does not silently delete old workloads to prepare
another run. The former script-based demo procedure is not executable from this
release.
