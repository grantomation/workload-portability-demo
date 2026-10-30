# Shared source and local configuration

This repository is the source for the dashboard, Alpine VM builds, workload,
artifact server, and load balancer. Provisioning and archived code are deliberately excluded.

## Clone and run setup

From a clone of the public repository, with Git, Python 3, Bash, OpenSSL and `oc`
installed, log in to the Build cluster and run:

```sh
oc login <build-cluster-api>
bash 01_installation_dashboard/setup.sh
```

No source URL editing or configuration commit is required. Setup reads the
checkout's `origin` and exact HEAD commit, renders the BuildConfig and Deployment
in memory, and supplies SOURCE_REPO_URL and SOURCE_REPO_REVISION to the dashboard.
The dashboard substitutes those settings when deploying freshly cloned pipeline
templates. Builds therefore use the same published revision as the checkout,
regardless of whether its branch is called main or master.

For standalone Tekton setup, run `bash 01_installation_dashboard/pipelines/setup.sh`.
It uses the same discovery and rendering. To inspect the example PipelineRuns:

```sh
python3 scripts/configure-source.py --render \
  01_installation_dashboard/pipelines/tekton/pipelinerun.yml > /tmp/portability-runs.yaml
```

The rendered file contains independent examples, not a sequential workflow.
Select and create one document at a time after its dependencies succeed; use the
dashboard for the normal run flow.

Advanced users can override SOURCE_REPO_URL and SOURCE_REPO_REVISION in the
environment. Conventional `git@host:owner/repo.git` origins are converted to
anonymous HTTPS. URLs containing credentials are rejected. The remote repository
and selected commit must be publicly readable: local uncommitted changes and
unpushed commits are not uploaded by setup. After updating your checkout, rerun
setup and reapply the Build role to update installed pipeline defaults.

The manifests contain source placeholders; use the setup/render entry points
instead of applying those templates directly. No GitHub PAT is required.

## Configuration stays outside Git

Supply cluster logins and cloud credentials through the dashboard's existing
Kubernetes Secret-backed settings. Never copy private configuration, PAT files,
cluster exports, VM disks, or build output into this repository. The dashboard
setup script generates an OAuth cookie secret and preserves an existing one.
The old static-secret manifest is now informational only; use setup.sh.

Existing public resource names (`pw-*`, `wp-*`, `pw_*.qcow2`) are retained.
No worker-node labels are automatically assigned, and VM tests do not require
private build/virtualization node-placement conventions.

## Workload behavior

The workload now displays detected platform names and offers light/dark themes.
`node 02_workload/server.js --dev` runs with generic in-memory stops and no database.
VM builds embed `portable-infra-detect.sh`, which writes `/run/portable-infra`.
The API exposes that result at `/api/infra`. New stops store a platform label in
the existing `url` column; older rows may still contain route URLs. The old
request-header route capture is no longer used.

Detection checks `virt-what` for KVM. KVM guests query the cluster metadata
endpoint; other results, including missing or failed detection, use the generic
`Legacy Infra` label. This fallback is not identification of a particular vendor.
The same KVM check selects cluster DNS versus mDNS in the guest networking helpers.
`K8S_API` can override the metadata endpoint when invoking the detector. Requests
have bounded retries and return Unknown when the endpoint stays unavailable.
The metadata request uses insecure TLS because these guest images do not contain
the cluster CA; it sends no credentials.

Legacy infrastructure guests retain DHCP by default. Optional configure-network-backend.sh and
configure-network-frontend.sh require ADDRESS, PREFIX, NETMASK, GATEWAY, and DNS.
Run them manually with console access: they immediately replace eth0 networking.
Older numbered helpers and the retired automatic static-address helper remain
for compatibility but are no longer embedded by the VM builder.

The existing VM root and database demo passwords remain demo defaults. They are
not personal credentials. Database runtime configuration supports DB_PASSWORD;
this port does not redesign the VM image's database authentication/bootstrap.
Do not embed real environment credentials in distributable VM images.

## Operational additions

- ACM hub-managed Virt/MTV handling, S3 prerequisite checks, existing OperatorGroup
  handling, and waiting for the Observability API.
- AWS OIDC and cert-manager detection for Portworx; admin namespace configuration.
- MTV target route pipeline and role-triggered execution.
- Artifact upload timeouts and artifact-server restart after Migration Components processing.
- Dashboard credential field clearing and prerequisite-aware role controls.
- Explicit Prepare On-Prem namespace deletion with a confirmation dialog.
  Check the displayed target: it is the last non-ACM Portworx cluster in the chain.

## Validation still required on infrastructure

Run installation and reapply flows on a disposable cluster; build both Alpine
VMs; check legacy infrastructure DHCP/static configuration; migrate legacy infrastructure to OpenShift; exercise
MTV target routes and DR recovery; and upload a large artifact. Local syntax and
manifest checks cannot establish that these operations work on your clusters.

## Legacy environment settings

The dashboard API and saved cluster settings identify the source environment with
`type: legacy` and its management endpoint with `managementUrl`. This clean-start
release does not convert older saved settings; re-enter the legacy environment
when moving an existing deployment to this version. Runtime credentials remain
in the dashboard's Secret-backed configuration.

The certificate task is named `fetch-management-ca` and writes
`management-ca.crt`. Its existing download endpoint is unchanged. The artifact UI
recognizes the new certificate filename. Migration examples use `legacy-to-*`
resource names and require the source Provider name configured manually in MTV.

## Additional component archives

Upload exactly one compatible `*.tar.gz` archive before running the component
image build. The pipeline preserves its complete file and directory tree, including
hidden files, and packages it without assuming any supplier-specific directory
name. The generated image copies that tree into `/opt` when run. An empty archive
or multiple candidate archives cause the build to stop with an explanation.

Preserving the supplied layout does not establish compatibility with the installed
migration tool. Configure the image through that tool and validate the integration
separately; the dashboard does not create or update the source Provider.
