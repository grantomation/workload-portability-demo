const fs = require('fs');
const { renderSource } = require('./source');
const path = require('path');
const { apiRequest, NAMESPACE } = require('./cluster');

const TEKTON_DIR = path.resolve(__dirname, '../../pipelines/tekton');

const API_PATHS = {
  Task: (ns, name) => `/apis/tekton.dev/v1/namespaces/${ns}/tasks/${name}`,
  Pipeline: (ns, name) => `/apis/tekton.dev/v1/namespaces/${ns}/pipelines/${name}`,
  PersistentVolumeClaim: (ns, name) => `/api/v1/namespaces/${ns}/persistentvolumeclaims/${name}`,
  TriggerTemplate: (ns, name) => `/apis/triggers.tekton.dev/v1beta1/namespaces/${ns}/triggertemplates/${name}`,
  TriggerBinding: (ns, name) => `/apis/triggers.tekton.dev/v1beta1/namespaces/${ns}/triggerbindings/${name}`,
  EventListener: (ns, name) => `/apis/triggers.tekton.dev/v1beta1/namespaces/${ns}/eventlisteners/${name}`,
  Route: (ns, name) => `/apis/route.openshift.io/v1/namespaces/${ns}/routes/${name}`,
};

function splitYamlDocuments(content) {
  return content.split(/^---$/m)
    .map(d => d.trim())
    .filter(d => d.length > 0 && d.includes('kind:'));
}

function extractField(doc, field) {
  const match = doc.match(new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function extractName(doc) {
  const metaIdx = doc.indexOf('metadata:');
  if (metaIdx === -1) return null;
  const afterMeta = doc.slice(metaIdx);
  const nameMatch = afterMeta.match(/^\s+name:\s*(.+)$/m);
  return nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : null;
}

function injectNamespace(doc, ns) {
  const metaIdx = doc.indexOf('metadata:');
  if (metaIdx === -1) return doc;
  const afterMeta = doc.slice(metaIdx);
  const nextTopLevel = afterMeta.search(/\n[a-zA-Z]/);
  const metaSection = nextTopLevel !== -1 ? afterMeta.slice(0, nextTopLevel) : afterMeta;
  if (/^\s+namespace:/m.test(metaSection)) {
    return doc.replace(/(metadata:\s*\n(?:\s+\S.*\n)*?\s+)namespace:\s*.+/m, `$1namespace: ${ns}`);
  }
  return doc.replace(/(metadata:\s*\n)/, `$1  namespace: ${ns}\n`);
}

function loadTektonFiles(ns) {
  if (!fs.existsSync(TEKTON_DIR)) {
    console.error(`Tekton directory not found: ${TEKTON_DIR}`);
    return [];
  }

  const fileOrder = [
    'pvc.yml',
    'tasks.yml',
    'pipeline-1-builder.yml',
    'pipeline-2-build-backend-vm.yml',
    'pipeline-3-build-frontend-vm.yml',
    'pipeline-4-vm-tests.yml',
    'pipeline-5-artifact-server.yml',
    'pipeline-6-migration-components.yml',
    'pipeline-7-ocp-providers.yml',
    'pipeline-mtv-target-routes.yml',
    'pipeline-dash-loadbalancer.yml',
    'pipeline-dash-acm-onboard.yml',
    'pipeline-dash-px-license.yml',
    'triggers.yml',
  ];

  const manifests = [];

  for (const filename of fileOrder) {
    const filePath = path.join(TEKTON_DIR, filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`Tekton file not found, skipping: ${filename}`);
      continue;
    }

    const raw = renderSource(fs.readFileSync(filePath, 'utf8'));
    const docs = splitYamlDocuments(raw);

    for (const doc of docs) {
      const kind = extractField(doc, 'kind');
      const name = extractName(doc);
      if (!kind || !name) continue;

      const apiPathFn = API_PATHS[kind];
      if (!apiPathFn) {
        console.warn(`Unknown kind "${kind}" in ${filename}, skipping`);
        continue;
      }

      const content = injectNamespace(doc, ns);

      manifests.push({
        kind,
        name,
        apiPath: apiPathFn(ns, name),
        content,
        source: filename,
      });
    }
  }

  return manifests;
}

function getManifests(ns) {
  return loadTektonFiles(ns);
}

function sccClusterRoleBindingName(ns) {
  return `pipeline-privileged-${ns}`;
}

async function ensurePrivilegedSCC(clusterName, ns, emitEvent) {
  const crbName = sccClusterRoleBindingName(ns);
  if (emitEvent) emitEvent({
    type: 'pipelines', cluster: clusterName,
    action: `Granting privileged SCC to pipeline SA in ${ns}...`, status: 'info'
  });
  const content = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${crbName}
subjects:
  - kind: ServiceAccount
    name: pipeline
    namespace: ${ns}
roleRef:
  kind: ClusterRole
  name: system:openshift:scc:privileged
  apiGroup: rbac.authorization.k8s.io`;

  const resp = await apiRequest(clusterName,
    `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${crbName}?fieldManager=installation-dashboard&force=true`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/apply-patch+yaml' }, body: content });

  if (resp.ok) {
    if (emitEvent) emitEvent({
      type: 'pipelines', cluster: clusterName,
      action: 'Privileged SCC granted', status: 'success'
    });
  } else {
    const text = await resp.text();
    if (emitEvent) emitEvent({
      type: 'pipelines', cluster: clusterName,
      action: `Failed to grant SCC: ${text}`, status: 'error'
    });
  }
}

async function ensureMtvProviderRbac(clusterName, ns, emitEvent) {
  const mtvNs = 'openshift-mtv';
  const crName = 'mtv-provider-manager';
  const rbName = 'pipeline-mtv-provider-manager';

  const crContent = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${crName}
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: ["forklift.konveyor.io"]
    resources: ["providers"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]`;

  const rbContent = `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${rbName}
  namespace: ${mtvNs}
subjects:
  - kind: ServiceAccount
    name: pipeline
    namespace: ${ns}
roleRef:
  kind: ClusterRole
  name: ${crName}
  apiGroup: rbac.authorization.k8s.io`;

  await apiRequest(clusterName,
    `/apis/rbac.authorization.k8s.io/v1/clusterroles/${crName}?fieldManager=installation-dashboard&force=true`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/apply-patch+yaml' }, body: crContent });

  const resp = await apiRequest(clusterName,
    `/apis/rbac.authorization.k8s.io/v1/namespaces/${mtvNs}/rolebindings/${rbName}?fieldManager=installation-dashboard&force=true`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/apply-patch+yaml' }, body: rbContent });

  if (resp.ok) {
    if (emitEvent) emitEvent({
      type: 'pipelines', cluster: clusterName,
      action: 'MTV provider RBAC granted', status: 'success'
    });
  }
}

async function ensureMtvTargetRoutesRbac(clusterName, ns, emitEvent) {
  const crName = 'mtv-target-routes-manager';
  const crbName = 'pipeline-mtv-target-routes';
  const targetNs = 'portable-workload';

  const crContent = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${crName}
rules:
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "create"]
  - apiGroups: ["route.openshift.io"]
    resources: ["routes", "routes/custom-host"]
    verbs: ["get", "list", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "create", "update", "patch"]`;

  const crbContent = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${crbName}
subjects:
  - kind: ServiceAccount
    name: pipeline
    namespace: ${ns}
roleRef:
  kind: ClusterRole
  name: ${crName}
  apiGroup: rbac.authorization.k8s.io`;

  await apiRequest(clusterName,
    `/apis/rbac.authorization.k8s.io/v1/clusterroles/${crName}?fieldManager=installation-dashboard&force=true`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/apply-patch+yaml' }, body: crContent });

  const resp = await apiRequest(clusterName,
    `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${crbName}?fieldManager=installation-dashboard&force=true`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/apply-patch+yaml' }, body: crbContent });

  if (resp.ok) {
    if (emitEvent) emitEvent({
      type: 'pipelines', cluster: clusterName,
      action: 'MTV target routes RBAC granted', status: 'success'
    });
  }
}

async function waitForTektonCRDs(clusterName, emitEvent) {
  if (emitEvent) emitEvent({
    type: 'pipelines', cluster: clusterName,
    action: 'Waiting for Tekton CRDs to become available (up to 180s)...', status: 'info'
  });
  for (let i = 0; i < 36; i++) {
    try {
      const [tektonResp, triggersResp] = await Promise.all([
        apiRequest(clusterName, '/apis/tekton.dev/v1'),
        apiRequest(clusterName, '/apis/triggers.tekton.dev/v1beta1')
      ]);
      if (tektonResp.ok && triggersResp.ok) {
        if (emitEvent) emitEvent({
          type: 'pipelines', cluster: clusterName,
          action: 'Tekton CRDs ready', status: 'success'
        });
        return;
      }
    } catch (e) { /* keep waiting */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  if (emitEvent) emitEvent({
    type: 'pipelines', cluster: clusterName,
    action: 'Tekton CRDs not ready after 180s — attempting apply anyway', status: 'warning'
  });
}

async function deployPipelines(clusterName, emitEvent) {
  const ns = NAMESPACE;

  await ensurePrivilegedSCC(clusterName, ns, emitEvent);
  await ensureMtvProviderRbac(clusterName, ns, emitEvent);
  await ensureMtvTargetRoutesRbac(clusterName, ns, emitEvent);
  await waitForTektonCRDs(clusterName, emitEvent);

  const manifests = getManifests(ns);

  if (manifests.length === 0) {
    if (emitEvent) emitEvent({
      type: 'pipelines', cluster: clusterName,
      action: `No Tekton manifests found in ${TEKTON_DIR}`, status: 'error'
    });
    return [];
  }

  if (emitEvent) emitEvent({
    type: 'pipelines', cluster: clusterName,
    action: `Found ${manifests.length} resources across ${new Set(manifests.map(m => m.source)).size} files`, status: 'info'
  });

  const results = [];

  for (const m of manifests) {
    if (emitEvent) emitEvent({
      type: 'pipelines', cluster: clusterName,
      action: `Applying ${m.kind} ${m.name}...`, status: 'info'
    });

    try {
      const resp = await apiRequest(clusterName,
        `${m.apiPath}?fieldManager=installation-dashboard&force=true`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/apply-patch+yaml' }, body: m.content });

      if (resp.ok) {
        results.push({ kind: m.kind, name: m.name, status: 'applied' });
        if (emitEvent) emitEvent({
          type: 'pipelines', cluster: clusterName,
          action: `Applied ${m.kind} ${m.name}`, status: 'success'
        });
      } else {
        const text = await resp.text();
        results.push({ kind: m.kind, name: m.name, status: 'error', error: text });
        if (emitEvent) emitEvent({
          type: 'pipelines', cluster: clusterName,
          action: `Failed ${m.kind} ${m.name}: ${text}`, status: 'error'
        });
      }
    } catch (e) {
      results.push({ kind: m.kind, name: m.name, status: 'error', error: e.message });
      if (emitEvent) emitEvent({
        type: 'pipelines', cluster: clusterName,
        action: `Error: ${e.message}`, status: 'error'
      });
    }
  }

  if (emitEvent) emitEvent({
    type: 'pipelines', cluster: clusterName,
    action: `Deployment pipelines deployed (${results.filter(r => r.status === 'applied').length}/${results.length} resources)`,
    status: 'success'
  });

  return results;
}

async function removePipelines(clusterName, emitEvent) {
  const ns = NAMESPACE;

  if (emitEvent) emitEvent({
    type: 'pipelines', cluster: clusterName,
    action: 'Removing deployment pipelines...', status: 'info'
  });

  const manifests = getManifests(ns).reverse();

  for (const m of manifests) {
    try {
      await apiRequest(clusterName, m.apiPath, { method: 'DELETE' });
    } catch (e) { /* ignore delete errors */ }
  }

  const crbName = sccClusterRoleBindingName(ns);
  try {
    await apiRequest(clusterName,
      `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${crbName}`,
      { method: 'DELETE' });
  } catch (e) { /* ignore */ }

  const runArtifacts = [
    `/apis/route.openshift.io/v1/namespaces/${ns}/routes/golden-artifacts`,
    `/api/v1/namespaces/${ns}/services/golden-artifacts`,
    `/apis/apps/v1/namespaces/${ns}/deployments/golden-artifacts`,
    `/apis/image.openshift.io/v1/namespaces/${ns}/imagestreams/golden-builder`,
    `/apis/image.openshift.io/v1/namespaces/${ns}/imagestreams/faux-loadbalancer`,
    `/apis/route.openshift.io/v1/namespaces/${ns}/routes/loadbalancer`,
    `/apis/route.openshift.io/v1/namespaces/${ns}/routes/portable-workload`,
    `/api/v1/namespaces/${ns}/services/loadbalancer`,
    `/apis/apps/v1/namespaces/${ns}/deployments/loadbalancer`,
    `/api/v1/namespaces/${ns}/configmaps/faux-lb-config`,
    `/api/v1/namespaces/${ns}/configmaps/acm-onboard-status`
  ];
  for (const p of runArtifacts) {
    try {
      await apiRequest(clusterName, p, { method: 'DELETE' });
    } catch (e) { /* ignore */ }
  }

  if (emitEvent) emitEvent({
    type: 'pipelines', cluster: clusterName,
    action: 'Deployment pipelines removed', status: 'success'
  });
}

async function checkPipelineStatus(clusterName) {
  const manifests = getManifests(NAMESPACE);
  const probes = [
    manifests.find(m => m.kind === 'PersistentVolumeClaim'),
    manifests.find(m => m.kind === 'Pipeline' && m.name === '1-build-vm-builder-image'),
    manifests.find(m => m.kind === 'EventListener')
  ].filter(Boolean);

  let deployed = 0;
  const total = probes.length;

  try {
    const results = await Promise.all(probes.map(async (m) => {
      try {
        const resp = await apiRequest(clusterName, m.apiPath);
        return resp.ok;
      } catch {
        return false;
      }
    }));
    deployed = results.filter(Boolean).length;
  } catch {
    return { status: 'error', deployed: 0, total };
  }

  if (deployed === total) return { status: 'deployed', deployed, total };
  if (deployed === 0) return { status: 'not_deployed', deployed, total };
  return { status: 'partial', deployed, total };
}

module.exports = { deployPipelines, removePipelines, getManifests, checkPipelineStatus, NAMESPACE };
