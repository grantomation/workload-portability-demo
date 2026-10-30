# Installation dashboard

For bucket creation, access keys and dashboard entry, follow the
[S3 setup instructions](setup-runbook.md#create-the-s3-bucket-and-access-keys).
The endpoint must be reachable by participating clusters; bucket access uses
credentials, not anonymous public access.

The dashboard registers existing environments, installs operators, applies storage
configuration, starts Tekton pipelines, and exposes DR controls. It does not
provision clusters or automatically create the legacy source Provider in MTV.

## Bootstrap

From a published Git checkout, with `oc`, Git, Python 3, Bash and OpenSSL installed:

```sh
oc login <build-cluster-api>
bash 01_installation_dashboard/setup.sh
```

Setup creates the dashboard namespace resources, permissions, persistent storage,
image build, deployment and authenticated Route. It generates an OAuth cookie
secret, preserving an existing one. No checked-in cookie secret is required.
The source URL and exact checkout revision are discovered automatically and passed
to the build and dashboard. That remote revision must be publicly readable.

## Configure the environment

You can begin with one Build cluster and run the image builds and VM tests before
completing the multicluster steps below. ARO is one starting option; hub placement
is your choice. The hub may share the Build cluster if capacity allows, but ACM-role
clusters are excluded from the current DR workload chain.

1. Register each OpenShift cluster using its API endpoint and credentials. Test
   connectivity to discover platform and node information. Add the legacy source
   separately with its management endpoint; it is stored as `type: legacy` with
   a `managementUrl` field.
2. Assign Build to the cluster that will execute pipelines. This installs Pipelines
   and Virtualization and deploys Tekton resources. It needs VM-capable workers for
   the smoke tests. Assign Build before MTV.
3. Save S3 bucket, endpoint, region and access credentials in the global settings
   before installing ACM. The ACM prerequisite check requires S3 configuration for
   observability. Assign ACM to the hub and use “Onboard to ACM” to import spokes.
4. Assign Virtualization and MTV where required. The ACM role also declares Virt
   and MTV as hub-managed components; their lifecycle differs from direct spoke
   operator installation. The MTV role installs target-side resources, while source
   Provider configuration remains manual in MTV.
5. Assign Portworx to the storage spokes. Configure each cluster's cloud access,
   then apply its StorageCluster from the dashboard. Installing the operator alone
   does not complete storage setup. Save and activate the Portworx license through
   the license controls/pipeline.
6. Run the [build pipelines](vm-build-pipeline.md), configure the source transfer,
   and build the load balancer. Check the displayed cluster positions before
   creating DR pairs; that order also drives the replication chain.

These are independent operations with prerequisite checks and progress messages.
A successful connection test is not a full environment preflight. A user-supplied
single environment file with a complete preflight/apply workflow is not implemented.

## Roles

| Role | Components/responsibility |
|------|---------------------------|
| Build | OpenShift Pipelines and Virtualization; build/deployment pipelines |
| MTV | Virtualization and MTV; target-side migration setup |
| ACM | ACM and Portworx Multi-Cluster; hub-managed Virt/MTV declarations |
| Virtualization | Virtualization on a workload cluster |
| Portworx | Portworx operator; separate StorageCluster configuration required |

The dashboard checks role prerequisites and estimates operator resource needs.
Its platform checks are implemented guards, not a guarantee that a particular
cloud instance or operator version is supported. Unknown platforms receive generic
virtualization guidance. Shared operators are considered when roles are removed.

## Portworx credentials

| Environment | Configuration |
|-------------|---------------|
| Azure | Service principal client ID, client secret and tenant ID |
| AWS with workload identity | IAM role ARN; OIDC detection selects the STS configuration |
| Other AWS | Instance-profile access or supplied static access key and secret |
| GCP | Service account JSON key |

The dashboard selects a StorageCluster template from detected platform information,
handles cloud credential Secrets, and detects cert-manager for the AWS STS path.
Templates set Stork's admin namespace to `portworx`. Worker placement rules exclude
configured infrastructure taints. Cloud permissions and the S3 bucket must already
exist; the dashboard does not create cloud IAM or provision the bucket.

## Where settings live

| Data | Location |
|------|----------|
| Role/operator defaults and template settings | `01_installation_dashboard/app/config.yaml`, read at startup; optional `CONFIG_PATH` override |
| Registered clusters, credentials, roles and discovery | Kubernetes Secret `installation-dashboard-clusters` |
| Runtime S3, cloud credentials and license settings | Kubernetes Secret `installation-dashboard-config` |
| Generated operator YAML | Dashboard data volume under `/data/yaml/` |
| Local-development state | `clusters.json` and `config.json` under `DATA_DIR` |

There is no `installation-dashboard-config` ConfigMap to edit. Use the dashboard
for runtime settings; static application defaults are a separate file. Keep local
state and generated manifests containing credentials out of source control.
Older saved source-environment settings are not converted automatically; re-enter
them when moving to this clean-start release.

## Operator installation and removal

Installation generates current templates and applies that returned file list, so
leftover files from previous template versions are not silently reapplied. Files
with unresolved placeholders are skipped. Inspect progress and generated resources
instead of assuming every template was installed.

The installer resolves Subscription channels from the target cluster's catalog,
applies manifests through the API, waits for required CRDs and enables configured
console plugins. Operations stream progress to the browser through SSE.

Uninstallation removes managed resources, subscriptions and CSVs, and can remove
operator CRDs, webhooks and dedicated namespaces. Some cleanup paths remove
finalizers. These are destructive lifecycle operations, not merely hiding a role
in the UI; check workloads before using them.

## Demo controls

The dashboard supports DR pair/protection-group creation, status, read-only audit,
DR deletion and deep cleanup. “Prepare On-Prem” deletes the protected namespace
on the last non-ACM Portworx cluster in the ordered chain. The name of the button
does not determine the target. See [Portworx DR](portworx-dr.md) before using it.

The source Provider, source mappings/plan and failover procedure still require
operator decisions. The [setup runbook](setup-runbook.md) places these controls in the preparation
sequence and identifies details still requiring verification.

## Local development

From the repository root:

```sh
cd 01_installation_dashboard/app
npm ci
DATA_DIR=./data node server.js
```

Open `http://localhost:8080`. Local state is written under `data/` when Kubernetes
Secret storage is unavailable. Real operations still act on the clusters you
register; local execution is not a simulation.
