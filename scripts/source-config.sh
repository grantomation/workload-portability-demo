# Sourced by Bash setup scripts. All manifests are rendered in memory.
SOURCE_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/configure-source.py"
SOURCE_REPO_URL="$(python3 "${SOURCE_HELPER}")"
export SOURCE_REPO_URL
SOURCE_REPO_REVISION="$(python3 "${SOURCE_HELPER}" --revision)"
export SOURCE_REPO_REVISION
apply_manifest() {
    python3 "${SOURCE_HELPER}" --render "$1" | oc apply -f -
}
