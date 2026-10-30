# Portworx disaster recovery

For bucket creation, access keys and dashboard entry, follow the
[S3 setup instructions](setup-runbook.md#create-the-s3-bucket-and-access-keys).
The endpoint must be reachable by participating clusters; bucket access uses
credentials, not anonymous public access.

After the initial transfer to OpenShift, Portworx asynchronous DR replicates VM
storage and Kubernetes resources between spokes. The ACM hub hosts Portworx
Multi-Cluster and the DR custom resources; storage spokes run Portworx Enterprise.
An existing S3-compatible bucket and credentials are required for the configured
backup location. Bucket access alone is not the whole authorization model: cluster
registration, agents and Kubernetes permissions are also required.

## Pair order and protection

The dashboard builds a ring from clusters with the Portworx role, excluding the
ACM hub, sorted by `lbPosition`. It joins adjacent clusters and closes the ring
from the last to the first. Pair names are numbered and derived from the configured
cluster names. At least two storage clusters are required.

Pairs use asynchronous, bidirectional replication. Before creating a protection
group, the dashboard waits for the pair's overall and per-spoke readiness and
BackupLocationCreated conditions. Existing pairs/groups are skipped.

The protection group has the same name as its pair. Current defaults protect
`portable-workload` every 15 minutes and include application volumes, with:

- `startApplications: false`: destination applications are not started automatically.
- `purgeDeletedResourcesAtSource: false`: source deletion is not propagated by this setting.
- `skipServiceUpdate: true`: preserve destination Service configuration.

The interval is a schedule, not a guaranteed recovery point. Check successful sync
status and the age of the usable recovery data before a failover.

## A hop

Create the protection group for the intended pair and wait for replication to
complete. Use the Portworx interface to perform the intended recovery/failover,
verify the destination VMs and database, then switch the load balancer and add a
map stop. The stop records the detected platform label. Switching the load balancer
alone does not trigger recovery or start VMs.

This is a description of the current controls, not a validated end-to-end demo
procedure. See the [setup runbook](setup-runbook.md) for environment preparation.

## Returning to a previous destination

Old workload resources and volume names can conflict with a restore. The dashboard's
“Prepare On-Prem” action is explicitly destructive: after UI confirmation it asks
the API to delete the entire protected namespace on the **last non-ACM Portworx
cluster in the ordered chain**. It does not search for a cluster named on-prem.

Check that displayed target and ensure the live workload and required recovery
data are elsewhere before using it. The API returns after accepting the namespace
delete; it does not wait for all volumes to disappear. Verify deletion has completed
before a restore. Creating a protection group does not perform this cleanup for you.

## Stork namespace

StorageCluster templates configure Stork's `admin-namespace` as `portworx`.
Use a consistent namespace across spokes and check Stork/BackupLocation status if
replication fails. The DR defaults are in the dashboard's `config.yaml`; pair and
protection-group templates are in `01_installation_dashboard/operators/dr/`.

## Audit and cleanup

The dashboard's DR audit reads hub and spoke resources to identify orphaned objects,
including BackupLocations whose credential Secrets are missing. It uses resource
UID relationships as well as references, since generated names may be shortened.

The standard deletion path removes hub protection groups and pairs. Deep cleanup
also deals with DR actions and leftover spoke resources. It can remove finalizers
from stuck objects. Inspect the reported resources and target clusters before using
cleanup: these controls remove replication state and may affect recovery options.
They are not a substitute for checking the surviving workload and backup data.

The old `05_demo/` shell commands are absent from this release. Use the current
dashboard controls with environment validation.
