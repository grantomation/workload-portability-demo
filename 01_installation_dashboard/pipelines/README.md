# Build system

Tekton builds the Alpine VM disks and deploys the supporting services.
See [VM build pipelines](../../docs/vm-build-pipeline.md) for the individual
pipelines, dependencies and outputs.

## Install the pipeline resources

The normal entry point is the dashboard's Build role. Standalone resource setup
is also available from the repository root:

```sh
oc login <build-cluster-api>
bash 01_installation_dashboard/pipelines/setup.sh
```

This installs Pipelines if needed, creates the build namespace, grants the pipeline
service account privileged SCC access, and applies the PVC, tasks, pipelines and
triggers. It does not start the VM builds or install all other demo dependencies.

Setup discovers the public Git origin and exact HEAD revision. No source URL edits
are required. The selected remote revision must be published and anonymously readable.

## Start builds

Use the dashboard to start pipeline 1, then 2 and 3, then 4 and 5, waiting for the
required outputs before continuing. Run the additional-component and target-provider
pipelines only once their inputs and target environments are configured.

`tekton/pipelinerun.yml` contains several independent examples. It is not a sequential
workflow: creating the entire file starts all examples together. To use it manually,
render to a temporary file, select one YAML document, and create that document only:

```sh
python3 scripts/configure-source.py --render \
  01_installation_dashboard/pipelines/tekton/pipelinerun.yml > /tmp/portability-runs.yaml
# Copy the required document into /tmp/portability-run.yaml before the next command.
oc create -f /tmp/portability-run.yaml
oc get pipelineruns -n workload-portability-build
```

The shared workspace is `wp-build-workspace`; the artifact server uses `wp-artifacts`.
Avoid simultaneous runs that modify shared source or artifacts. Open the artifact
server through its authenticated Route to download the generated disk files.

The load-balancer and ACM EventListeners support dashboard actions. There is no
full-build webhook that automatically runs these pipelines on every Git push.
