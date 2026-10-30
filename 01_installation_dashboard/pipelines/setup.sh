#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/source-config.sh"

# Bootstrap the portable-workload build system on OpenShift.
# Prerequisites: OpenShift Pipelines operator installed, oc logged in.

NAMESPACE="${NAMESPACE:-workload-portability-build}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ">>> Checking OpenShift Pipelines operator..."
if oc get csv -n openshift-operators 2>/dev/null | grep -q openshift-pipelines-operator; then
  echo "    OpenShift Pipelines already installed, skipping."
else
  echo "    Installing OpenShift Pipelines operator..."
  cat <<'OPEOF' | oc apply -f -
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: openshift-pipelines-operator
  namespace: openshift-operators
spec:
  channel: latest
  name: openshift-pipelines-operator-rh
  source: redhat-operators
  sourceNamespace: openshift-marketplace
OPEOF
  echo "    Waiting for operator to install (up to 5 minutes)..."
  for i in $(seq 1 30); do
    if oc get csv -n openshift-operators 2>/dev/null | grep openshift-pipelines-operator | grep -q Succeeded; then
      echo "    OpenShift Pipelines operator ready."
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "ERROR: Timed out waiting for OpenShift Pipelines operator." >&2
      exit 1
    fi
    sleep 10
  done
fi

echo ">>> Creating project ${NAMESPACE}..."
oc new-project "${NAMESPACE}" 2>/dev/null || oc project "${NAMESPACE}"

echo ">>> Granting privileged SCC to pipeline service account..."
oc adm policy add-scc-to-user privileged -z pipeline -n "${NAMESPACE}"

echo ">>> Applying PVCs..."
apply_manifest "${SCRIPT_DIR}/tekton/pvc.yml"

echo ">>> Applying Tekton Tasks..."
apply_manifest "${SCRIPT_DIR}/tekton/tasks.yml"

echo ">>> Applying Pipelines..."
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-1-builder.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-2-build-backend-vm.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-3-build-frontend-vm.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-4-vm-tests.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-5-artifact-server.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-dash-loadbalancer.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-dash-acm-onboard.yml"

apply_manifest "${SCRIPT_DIR}/tekton/pipeline-6-migration-components.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-7-ocp-providers.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-dash-px-license.yml"
apply_manifest "${SCRIPT_DIR}/tekton/pipeline-mtv-target-routes.yml"

echo ">>> Applying Triggers..."
apply_manifest "${SCRIPT_DIR}/tekton/triggers.yml"

echo ""
echo "=== Bootstrap complete ==="
echo ""
echo "Next steps:"
echo "  1. Start builds from the dashboard, or render the example PipelineRuns:"
echo "  2. python3 scripts/configure-source.py --render 01_installation_dashboard/pipelines/tekton/pipelinerun.yml | oc create -f -"
echo "  3. Watch: tkn pipelinerun logs -f -L"
