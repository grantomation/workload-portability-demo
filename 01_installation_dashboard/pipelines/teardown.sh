#!/usr/bin/env bash
set -euo pipefail

# Tear down the portable-workload build system from OpenShift.
# Deletes the project and all resources within it (pipelines, tasks, PVCs, runs, etc).
# Does NOT uninstall the OpenShift Pipelines operator.

NAMESPACE="${NAMESPACE:-workload-portability-build}"

echo "============================================================"
echo "  This will DELETE the entire ${NAMESPACE} project"
echo "  including all pipelines, tasks, PVCs, and build artifacts."
echo "============================================================"
echo ""
read -rp "Are you sure? (yes/no): " CONFIRM

if [ "${CONFIRM}" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo ">>> Deleting project ${NAMESPACE}..."
oc delete project "${NAMESPACE}" --wait=true

echo ""
echo "=== Teardown complete ==="
echo ""
echo "To rebuild from scratch, run: ./07_build/setup.sh"
