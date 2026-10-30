#!/bin/sh
# Detects the infrastructure platform the VM is running on and writes the
# result to /run/portable-infra as JSON. Runs at boot after networking.
#
# KVM uses cluster metadata. Other or unavailable hypervisor results use the
# generic Legacy Infra label; this is a fallback, not vendor identification.

OUTFILE="${INFRA_OUTPUT_FILE:-/run/portable-infra}"
K8S_API="${K8S_API:-https://kubernetes.default.svc}"
OAUTH_PATH="/.well-known/oauth-authorization-server"

VIRT=$(virt-what 2>/dev/null || true)

if ! echo "$VIRT" | grep -qi kvm; then
    printf '{"platform":"Legacy Infra","source":"fallback"}\n' > "$OUTFILE"
    echo "portable-infra-detect: Legacy Infra"
    exit 0
fi

# On OpenShift Virt (KVM), determine the managed platform from the OAuth issuer.
# Retry with a bounded timeout — masquerade networking may take minutes after a DR failover.
printf '{"platform":"Detecting...","source":"pending"}\n' > "$OUTFILE"
ISSUER=""
ATTEMPT=0
while [ -z "$ISSUER" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    if [ "$ATTEMPT" -gt 24 ]; then
        printf '{"platform":"Unknown","source":"unavailable"}\n' > "$OUTFILE"
        exit 0
    fi
    ISSUER=$(curl -sk --connect-timeout 5 --max-time 10 \
        "${K8S_API}${OAUTH_PATH}" 2>/dev/null \
        | sed -n 's/.*"issuer"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    [ -n "$ISSUER" ] && break
    sleep 5
done

PLATFORM=""
case "$ISSUER" in
    *aroapp.io*)               PLATFORM="Azure Red Hat OpenShift" ;;
    *oauth.*.openshiftapps.*)  PLATFORM="Red Hat OpenShift Service on AWS" ;;
    *openshiftapps.*)          PLATFORM="OpenShift Dedicated" ;;
    *)                         PLATFORM="OpenShift Virtualization" ;;
esac

printf '{"platform":"%s","issuer":"%s","source":"oauth"}\n' "$PLATFORM" "$ISSUER" > "$OUTFILE"
echo "portable-infra-detect: ${PLATFORM} (${ISSUER})"
