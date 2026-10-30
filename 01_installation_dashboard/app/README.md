# Installation dashboard application

The Express application manages registered environments, operators, storage,
Tekton pipelines and demo DR controls. See the
[dashboard guide](../../docs/installation-dashboard.md) for setup order, roles,
credential storage and the limits of automation.

## Deploy from the repository root

```sh
oc login <build-cluster-api>
bash 01_installation_dashboard/setup.sh
```

Setup discovers the Git origin and exact checkout revision. Both must be readable
by the remote build. It generates the OAuth cookie secret and deploys the manifests
in `01_installation_dashboard/deploy/`. `01-proxy-secret.yaml` is informational;
setup creates the actual secret. There is no static config ConfigMap manifest.

## Develop locally

From the repository root:

```sh
cd 01_installation_dashboard/app
npm ci
DATA_DIR=./data node server.js
```

Open `http://localhost:8080`. Static defaults are in `config.yaml` (or `CONFIG_PATH`).
Runtime settings and cluster credentials use Kubernetes Secrets in-cluster, with
JSON files under `DATA_DIR` as the local fallback. Do not commit those files.
Local mode can perform real operations against registered clusters.

The browser assets are in `public/`, API routes in `server.js`, and cluster,
operator, storage, template and pipeline helpers in `lib/`.
