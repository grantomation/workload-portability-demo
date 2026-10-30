#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/source-config.sh"

NS="${NAMESPACE:-workload-portability-build}"

echo ">>> Setting up Installation Dashboard in namespace: ${NS}"

oc project "${NS}" 2>/dev/null || oc new-project "${NS}"

echo ">>> Applying RBAC (ServiceAccount + Role + RoleBinding)..."
apply_manifest "$(dirname "$0")/deploy/rbac.yaml"

echo ">>> Creating cookie secret for OAuth Proxy..."
if ! oc get secret installation-dashboard-proxy -n "${NS}" &>/dev/null; then
    oc create secret generic installation-dashboard-proxy \
        -n "${NS}" \
        --from-literal=session_secret="$(openssl rand -base64 32)"
    echo "    Created installation-dashboard-proxy secret"
else
    echo "    Secret already exists, skipping"
fi

echo ">>> Creating empty clusters secret..."
if ! oc get secret installation-dashboard-clusters -n "${NS}" &>/dev/null; then
    oc create secret generic installation-dashboard-clusters \
        -n "${NS}" \
        --from-literal=clusters='{}'
    echo "    Created installation-dashboard-clusters secret"
else
    echo "    Secret already exists, skipping"
fi

echo ">>> Applying PVC..."
apply_manifest "$(dirname "$0")/deploy/pvc.yaml"

echo ">>> Applying BuildConfig + ImageStream..."
apply_manifest "$(dirname "$0")/deploy/buildconfig.yaml"

echo ">>> Applying Service..."
apply_manifest "$(dirname "$0")/deploy/service.yaml"

echo ">>> Applying Route..."
apply_manifest "$(dirname "$0")/deploy/route.yaml"

echo ">>> Applying Deployment..."
apply_manifest "$(dirname "$0")/deploy/deployment.yaml"

echo ">>> Triggering S2I build..."
oc start-build installation-dashboard -n "${NS}" --follow

echo ">>> Waiting for rollout..."
oc rollout status deployment/installation-dashboard -n "${NS}" --timeout=120s

ROUTE=$(oc get route installation-dashboard -n "${NS}" -o jsonpath='{.spec.host}' 2>/dev/null || echo "")
echo ""
echo "=== Installation Dashboard Setup Complete ==="
if [ -n "${ROUTE}" ]; then
    echo "URL: https://${ROUTE}"
    echo "Log in with your OpenShift credentials (e.g. kubeadmin)"
else
    echo "(Route not yet available — check 'oc get route installation-dashboard')"
fi
