# File inventory

Files present in this release, relative to the repository root. No cluster
provisioning scripts, archived demo scripts, credentials or disk artifacts are
included. The setup runbook marks sizing and import details still requiring verification.

## Root

| File | Purpose |
|------|---------|
| `.gitignore` | Source-control exclusions for credentials, dependencies and artifacts |
| `README.md` | Directory guide and entry points |
| `package.json` | npm dependencies and commands |

## 00_build_clusters

| File | Purpose |
|------|---------|
| `00_build_clusters/README.md` | Directory guide and entry points |

## 01_installation_dashboard

| File | Purpose |
|------|---------|
| `01_installation_dashboard/app/Containerfile` | Container build recipe |
| `01_installation_dashboard/app/README.md` | Directory guide and entry points |
| `01_installation_dashboard/app/config.yaml` | Application defaults and settings schema |
| `01_installation_dashboard/app/lib/cluster.js` | Dashboard module: cluster |
| `01_installation_dashboard/app/lib/config.js` | Dashboard module: config |
| `01_installation_dashboard/app/lib/operators.js` | Dashboard module: operators |
| `01_installation_dashboard/app/lib/pipelines.js` | Dashboard module: pipelines |
| `01_installation_dashboard/app/lib/roles.js` | Dashboard module: roles |
| `01_installation_dashboard/app/lib/source.js` | Dashboard module: source |
| `01_installation_dashboard/app/lib/storagecluster.js` | Dashboard module: storagecluster |
| `01_installation_dashboard/app/lib/templates.js` | Dashboard module: templates |
| `01_installation_dashboard/app/package-lock.json` | Locked npm dependency versions |
| `01_installation_dashboard/app/package.json` | npm dependencies and commands |
| `01_installation_dashboard/app/public/app.js` | Browser logic or local test helper |
| `01_installation_dashboard/app/public/index.html` | Browser interface or standalone preview |
| `01_installation_dashboard/app/public/styles.css` | Browser styles |
| `01_installation_dashboard/app/server.js` | HTTP server and API implementation |
| `01_installation_dashboard/deploy/00-namespace.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/deploy/01-proxy-secret.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/deploy/buildconfig.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/deploy/deployment.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/deploy/pvc.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/deploy/rbac.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/deploy/route.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/deploy/service.yaml` | Deployment manifest or retained local deployment example |
| `01_installation_dashboard/operators/acm/01-namespace.yaml` | Kubernetes resource template: 1 namespace |
| `01_installation_dashboard/operators/acm/02-operatorgroup.yaml` | Kubernetes resource template: 2 operatorgroup |
| `01_installation_dashboard/operators/acm/03-subscription.yaml` | Kubernetes resource template: 3 subscription |
| `01_installation_dashboard/operators/acm/04-multiclusterhub.yaml` | Kubernetes resource template: 4 multiclusterhub |
| `01_installation_dashboard/operators/acm/05-mco-namespace.yaml` | Kubernetes resource template: 5 mco namespace |
| `01_installation_dashboard/operators/acm/06-mco-secret.yaml` | Kubernetes resource template: 6 mco secret |
| `01_installation_dashboard/operators/acm/07-mco.yaml` | Kubernetes resource template: 7 mco |
| `01_installation_dashboard/operators/dr/02-drp.yaml` | Kubernetes resource template: 2 drp |
| `01_installation_dashboard/operators/dr/03-pg.yaml` | Kubernetes resource template: 3 pg |
| `01_installation_dashboard/operators/mtv/01-namespace.yaml` | Kubernetes resource template: 1 namespace |
| `01_installation_dashboard/operators/mtv/02-operatorgroup.yaml` | Kubernetes resource template: 2 operatorgroup |
| `01_installation_dashboard/operators/mtv/03-subscription.yaml` | Kubernetes resource template: 3 subscription |
| `01_installation_dashboard/operators/mtv/04-forkliftcontroller.yaml` | Kubernetes resource template: 4 forkliftcontroller |
| `01_installation_dashboard/operators/mtv/07-target-namespace.yaml` | Kubernetes resource template: 7 target namespace |
| `01_installation_dashboard/operators/mtv/08-migration-rbac.yaml` | Kubernetes resource template: 8 migration rbac |
| `01_installation_dashboard/operators/pipelines/01-subscription.yaml` | Kubernetes resource template: 1 subscription |
| `01_installation_dashboard/operators/px-multicluster/01-namespace.yaml` | Kubernetes resource template: 1 namespace |
| `01_installation_dashboard/operators/px-multicluster/02-operatorgroup.yaml` | Kubernetes resource template: 2 operatorgroup |
| `01_installation_dashboard/operators/px-multicluster/03-subscription.yaml` | Kubernetes resource template: 3 subscription |
| `01_installation_dashboard/operators/storage/01-namespace.yaml` | Kubernetes resource template: 1 namespace |
| `01_installation_dashboard/operators/storage/02-monitoring.yaml` | Kubernetes resource template: 2 monitoring |
| `01_installation_dashboard/operators/storage/03-operatorgroup.yaml` | Kubernetes resource template: 3 operatorgroup |
| `01_installation_dashboard/operators/storage/04-subscription.yaml` | Kubernetes resource template: 4 subscription |
| `01_installation_dashboard/operators/storage/05-stork-clusteradmin.yaml` | Kubernetes resource template: 5 stork clusteradmin |
| `01_installation_dashboard/operators/virt/01-namespace.yaml` | Kubernetes resource template: 1 namespace |
| `01_installation_dashboard/operators/virt/02-operatorgroup.yaml` | Kubernetes resource template: 2 operatorgroup |
| `01_installation_dashboard/operators/virt/03-subscription.yaml` | Kubernetes resource template: 3 subscription |
| `01_installation_dashboard/operators/virt/04-hyperconverged.yaml` | Kubernetes resource template: 4 hyperconverged |
| `01_installation_dashboard/operators/virt/05-clusterrole.yaml` | Kubernetes resource template: 5 clusterrole |
| `01_installation_dashboard/operators/virt/06-clusterrolebinding.yaml` | Kubernetes resource template: 6 clusterrolebinding |
| `01_installation_dashboard/pipelines/README.md` | Directory guide and entry points |
| `01_installation_dashboard/pipelines/builder/Containerfile` | Container build recipe |
| `01_installation_dashboard/pipelines/builder/buildconfig.yml` | Supporting configuration |
| `01_installation_dashboard/pipelines/scripts/01_check_db_seed.sh` | Shell helper: 01 check db seed |
| `01_installation_dashboard/pipelines/scripts/02_pw_db_seed.sh` | Shell helper: 02 pw db seed |
| `01_installation_dashboard/pipelines/scripts/03_restart_frontend.sh` | Shell helper: 03 restart frontend |
| `01_installation_dashboard/pipelines/scripts/build-golden-vm.sh` | Shell helper: build golden vm |
| `01_installation_dashboard/pipelines/scripts/build-vm.sh` | Shell helper: build vm |
| `01_installation_dashboard/pipelines/scripts/check-db-seed.sh` | Shell helper: check db seed |
| `01_installation_dashboard/pipelines/scripts/configure-network-backend.sh` | Shell helper: configure network backend |
| `01_installation_dashboard/pipelines/scripts/configure-network-frontend.sh` | Shell helper: configure network frontend |
| `01_installation_dashboard/pipelines/scripts/db-seed.sh` | Shell helper: db seed |
| `01_installation_dashboard/pipelines/scripts/legacy_network.sh` | Shell helper: legacy network |
| `01_installation_dashboard/pipelines/scripts/platform_network.sh` | Shell helper: platform network |
| `01_installation_dashboard/pipelines/scripts/restart-frontend.sh` | Shell helper: restart frontend |
| `01_installation_dashboard/pipelines/scripts/status-backend.sh` | Shell helper: status backend |
| `01_installation_dashboard/pipelines/scripts/status-frontend.sh` | Shell helper: status frontend |
| `01_installation_dashboard/pipelines/setup.sh` | Shell helper: setup |
| `01_installation_dashboard/pipelines/teardown.sh` | Shell helper: teardown |
| `01_installation_dashboard/pipelines/tekton/pipeline-1-builder.yml` | Tekton definition: pipeline 1 builder |
| `01_installation_dashboard/pipelines/tekton/pipeline-2-build-backend-vm.yml` | Tekton definition: pipeline 2 build backend vm |
| `01_installation_dashboard/pipelines/tekton/pipeline-3-build-frontend-vm.yml` | Tekton definition: pipeline 3 build frontend vm |
| `01_installation_dashboard/pipelines/tekton/pipeline-4-vm-tests.yml` | Tekton definition: pipeline 4 vm tests |
| `01_installation_dashboard/pipelines/tekton/pipeline-5-artifact-server.yml` | Tekton definition: pipeline 5 artifact server |
| `01_installation_dashboard/pipelines/tekton/pipeline-6-migration-components.yml` | Tekton definition: pipeline 6 migration components |
| `01_installation_dashboard/pipelines/tekton/pipeline-7-ocp-providers.yml` | Tekton definition: pipeline 7 ocp providers |
| `01_installation_dashboard/pipelines/tekton/pipeline-dash-acm-onboard.yml` | Tekton definition: pipeline dash acm onboard |
| `01_installation_dashboard/pipelines/tekton/pipeline-dash-loadbalancer.yml` | Tekton definition: pipeline dash loadbalancer |
| `01_installation_dashboard/pipelines/tekton/pipeline-dash-px-license.yml` | Tekton definition: pipeline dash px license |
| `01_installation_dashboard/pipelines/tekton/pipeline-mtv-target-routes.yml` | Tekton definition: pipeline mtv target routes |
| `01_installation_dashboard/pipelines/tekton/pipelinerun.yml` | Tekton definition: pipelinerun |
| `01_installation_dashboard/pipelines/tekton/pvc.yml` | Tekton definition: pvc |
| `01_installation_dashboard/pipelines/tekton/tasks.yml` | Tekton definition: tasks |
| `01_installation_dashboard/pipelines/tekton/triggers.yml` | Tekton definition: triggers |
| `01_installation_dashboard/portworx/aro_portworx_enterprise/portworx_enterprise.yaml` | Kubernetes resource template: portworx_enterprise |
| `01_installation_dashboard/portworx/gcp_portworx_enterprise/portworx_enterprise.yaml` | Kubernetes resource template: portworx_enterprise |
| `01_installation_dashboard/portworx/ocp_aws_portworx_enterprise/portworx_enterprise.yaml` | Kubernetes resource template: portworx_enterprise |
| `01_installation_dashboard/portworx/rosa_portworx_enterprise/portworx_enterprise.yaml` | Kubernetes resource template: portworx_enterprise |
| `01_installation_dashboard/setup.sh` | Shell helper: setup |

## 02_workload

| File | Purpose |
|------|---------|
| `02_workload/package-lock.json` | Locked npm dependency versions |
| `02_workload/package.json` | npm dependencies and commands |
| `02_workload/portable-infra-detect.sh` | Shell helper: portable infra detect |
| `02_workload/public/app.js` | Browser logic or local test helper |
| `02_workload/public/index.html` | Browser interface or standalone preview |
| `02_workload/public/standalone.html` | Browser interface or standalone preview |
| `02_workload/public/styles.css` | Browser styles |
| `02_workload/server.js` | HTTP server and API implementation |

## 03_artifact_server

| File | Purpose |
|------|---------|
| `03_artifact_server/Containerfile` | Container build recipe |
| `03_artifact_server/package-lock.json` | Locked npm dependency versions |
| `03_artifact_server/package.json` | npm dependencies and commands |
| `03_artifact_server/public/index.html` | Browser interface or standalone preview |
| `03_artifact_server/server.js` | HTTP server and API implementation |

## 04_loadbalancer_app

| File | Purpose |
|------|---------|
| `04_loadbalancer_app/Containerfile` | Container build recipe |
| `04_loadbalancer_app/README.md` | Directory guide and entry points |
| `04_loadbalancer_app/config.yaml` | Application defaults and settings schema |
| `04_loadbalancer_app/configmap.yaml` | Supporting configuration |
| `04_loadbalancer_app/dashboard.html` | Browser interface or standalone preview |
| `04_loadbalancer_app/deploy/deploy_podman.yml` | Deployment manifest or retained local deployment example |
| `04_loadbalancer_app/deploy/inventory.ini` | Deployment manifest or retained local deployment example |
| `04_loadbalancer_app/deploy/teardown_podman.yml` | Deployment manifest or retained local deployment example |
| `04_loadbalancer_app/hosts.sh` | Shell helper: hosts |
| `04_loadbalancer_app/package.json` | npm dependencies and commands |
| `04_loadbalancer_app/server.js` | HTTP server and API implementation |
| `04_loadbalancer_app/test/config.test.yaml` | Supporting configuration |
| `04_loadbalancer_app/test/dummy-targets.js` | Browser logic or local test helper |
| `04_loadbalancer_app/test/harness.js` | Browser logic or local test helper |
| `04_loadbalancer_app/trigger.sh` | Shell helper: trigger |

## docs

| File | Purpose |
|------|---------|
| `docs/FILE-INVENTORY.md` | Reference: file inventory |
| `docs/architecture.md` | Reference: architecture |
| `docs/artifact-server.md` | Reference: artifact server |
| `docs/setup-runbook.md` | Setup sequence, recovered sizing presets and outstanding verification |
| `docs/installation-dashboard.md` | Reference: installation dashboard |
| `docs/load-balancer.md` | Reference: load balancer |
| `docs/portworx-dr.md` | Reference: portworx dr |
| `docs/public-source-of-truth.md` | Reference: public source of truth |
| `docs/vm-build-pipeline.md` | Reference: vm build pipeline |
| `docs/workload-app.md` | Reference: workload app |

## scripts

| File | Purpose |
|------|---------|
| `scripts/configure-source.py` | Python helper: configure source |
| `scripts/source-config.sh` | Shell helper: source config |

## tests

| File | Purpose |
|------|---------|
| `tests/component-packaging.py` | Local regression check: component packaging |
| `tests/infra-detection.py` | Local regression check: infra detection |
| `tests/legacy-environment.cjs` | Local regression check: legacy environment |
| `tests/operator-current-templates.cjs` | Local regression check: operator current templates |
| `tests/pipeline-references.py` | Local regression check: pipeline references |
| `tests/pipeline-source.cjs` | Local regression check: pipeline source |
| `tests/source-config.py` | Local regression check: source config |
| `tests/workload-dev.cjs` | Local regression check: workload dev |
