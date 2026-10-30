# Cluster prerequisites

Provision clusters outside this repository. You can begin with one suitable
OpenShift cluster for the installation dashboard, Build role, VM builds and smoke
tests. ARO is an optional combined starting point using the existing sizing preset;
choose the platform that suits your environment and budget.

Add the remaining clusters when ready for the full demonstration. The reference
journey uses these responsibilities:

| Responsibility | Platform choice |
|----------------|-----------------|
| Dashboard and Build | Any suitable cluster with virtualization-capable workers for VM tests; ARO is one option |
| ACM hub and Portworx multicluster control plane | Builder's choice; may share the initial Build cluster if capacity allows |
| Workload spokes | Reference journey uses on-prem OpenShift, ARO, ROSA and OSD on GCP |
| Initial transfer target | A workload spoke with MTV and Virtualization |

The current DR chain excludes the ACM hub. If it shares the initial Build cluster,
use other clusters as the workload spokes for DR hops.

See the [setup runbook](../docs/setup-runbook.md) for sizing examples, prerequisites
and the progression from one build cluster to the full demo environment.
