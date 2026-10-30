const { apiRequest, setClusterScanResult, getCluster } = require('./cluster');
const { OPERATORS, listYamlFiles, readYamlFile, generateAndSave, parseYamlDocuments } = require('./templates');
const config = require('./config');

const cfg = config.get();
const ops = cfg.operators;

const prereqChecks = {
  pipelines: checkPipelinesPrereqs,
  virt: checkVirtPrereqs,
  mtv: checkMtvPrereqs,
  acm: checkAcmPrereqs,
  storage: checkStoragePrereqs,
  'px-multicluster': checkPxMulticlusterPrereqs
};

const OPERATOR_CHECKS = {};
for (const [key, op] of Object.entries(ops)) {
  OPERATOR_CHECKS[key] = {
    csvPrefix: op.csvPrefix,
    namespace: op.namespace,
    crCheck: op.crCheck || null,
    crdGroups: op.crdGroups || [],
    webhookPrefixes: op.webhookPrefixes || [],
    checkPrereqs: prereqChecks[key] || (() => ({ ok: true, message: 'Ready.' }))
  };
}

async function checkPipelinesPrereqs() {
  return { ok: true, message: 'No special prerequisites. Ready for OpenShift Pipelines.' };
}

async function checkVirtPrereqs(clusterName) {
  const nodesResp = await apiRequest(clusterName, '/api/v1/nodes');
  if (!nodesResp.ok) return { ok: false, message: 'Cannot query cluster nodes' };
  const nodesData = await nodesResp.json();
  const workers = nodesData.items.filter(n => {
    const labels = n.metadata.labels || {};
    return labels['node-role.kubernetes.io/worker'] !== undefined;
  });
  if (workers.length === 0) {
    return { ok: false, message: 'No worker nodes found. OpenShift Virtualization requires worker nodes.' };
  }

  const infraResp = await apiRequest(clusterName, '/apis/config.openshift.io/v1/infrastructures/cluster');
  let platform = 'unknown';
  let controlPlaneTopology = 'unknown';
  if (infraResp.ok) {
    const infra = await infraResp.json();
    platform = (infra.status?.platformStatus?.type || 'unknown').toLowerCase();
    controlPlaneTopology = (infra.status?.controlPlaneTopology || 'unknown').toLowerCase();
  }

  const knownVirtPlatforms = ['baremetal', 'none', 'azure', 'aws', 'gcp'];
  if (!knownVirtPlatforms.includes(platform)) {
    return { ok: true, message: `Platform "${platform}" detected. Virtualization support depends on nested virt capability. ${workers.length} worker node(s) found.`, warning: true };
  }

  if (platform === 'baremetal' || platform === 'none') {
    return { ok: true, message: `${workers.length} bare-metal worker node(s). Ready for OpenShift Virtualization.` };
  }

  if (platform === 'aws') {
    if (controlPlaneTopology === 'external') {
      return { ok: false, message: 'Hosted control planes require separate virtualization compatibility validation.' };
    }
    const metalWorkers = workers.filter(n => {
      const instanceType = n.metadata.labels?.['node.kubernetes.io/instance-type'] || '';
      return instanceType.includes('.metal');
    });
    if (metalWorkers.length === 0) {
      const instanceTypes = [...new Set(workers.map(n =>
        n.metadata.labels?.['node.kubernetes.io/instance-type'] || 'unknown'
      ))];
      return { ok: false, message: `AWS requires bare-metal instance types (e.g. c5n.metal, m5.metal, m5d.metal) for OpenShift Virtualization. Found ${workers.length} worker(s) with types: ${instanceTypes.join(', ')}. Add a machine pool with a .metal instance type.` };
    }
    return { ok: true, message: `${metalWorkers.length} bare-metal worker(s) on AWS (${metalWorkers.map(n => n.metadata.labels?.['node.kubernetes.io/instance-type']).filter(Boolean).join(', ')}). Ready for OpenShift Virtualization.` };
  }

  if (platform === 'azure') {
    // ARO requires Dsv5 or Dsv6 family with 8+ cores
    const virtCapableWorkers = workers.filter(n => {
      const vmSize = (n.metadata.labels?.['node.kubernetes.io/instance-type'] || '').toLowerCase();
      return /standard_(d|e)\d+a?s?_v[56]/.test(vmSize);
    });
    const workerSizes = [...new Set(workers.map(n =>
      n.metadata.labels?.['node.kubernetes.io/instance-type'] || 'unknown'
    ))];
    if (virtCapableWorkers.length === 0) {
      return { ok: false, message: `ARO requires Dsv5 or Dsv6 family VMs (8+ cores) for OpenShift Virtualization. Found workers with: ${workerSizes.join(', ')}. Supported examples: Standard_D8s_v5, Standard_D16s_v5, Standard_D32s_v5, Standard_D96ds_v5.` };
    }
    // Check minimum 8 cores on the matching workers
    const smallWorkers = virtCapableWorkers.filter(n => {
      const vmSize = n.metadata.labels?.['node.kubernetes.io/instance-type'] || '';
      const coreMatch = vmSize.match(/standard_\w?(\d+)/i);
      return coreMatch && parseInt(coreMatch[1], 10) < 8;
    });
    if (smallWorkers.length > 0 && smallWorkers.length === virtCapableWorkers.length) {
      return { ok: false, message: `ARO requires a minimum of 8-core Dsv5/Dsv6 VMs for OpenShift Virtualization. Found workers with: ${workerSizes.join(', ')}. Use Standard_D8s_v5 or larger.` };
    }
    return { ok: true, message: `${virtCapableWorkers.length} compatible worker(s) on ARO (${workerSizes.join(', ')}). Ready for OpenShift Virtualization.` };
  }

  if (platform === 'gcp') {
    // OSD/GCP requires C3 bare-metal instances
    const metalWorkers = workers.filter(n => {
      const machineType = (n.metadata.labels?.['node.kubernetes.io/instance-type'] || '').toLowerCase();
      return machineType.includes('-metal');
    });
    if (metalWorkers.length === 0) {
      const machineTypes = [...new Set(workers.map(n =>
        n.metadata.labels?.['node.kubernetes.io/instance-type'] || 'unknown'
      ))];
      return { ok: false, message: `GCP requires C3 bare-metal instances for OpenShift Virtualization (e.g. c3-standard-192-metal). Found ${workers.length} worker(s) with types: ${machineTypes.join(', ')}. Add a machine pool with C3 bare-metal instances.` };
    }
    return { ok: true, message: `${metalWorkers.length} bare-metal worker(s) on GCP. Ready for OpenShift Virtualization.` };
  }

  return { ok: true, message: `${workers.length} worker node(s) on ${platform}. Ready for OpenShift Virtualization.` };
}

async function checkMtvPrereqs(clusterName) {
  const virtCheck = OPERATOR_CHECKS.virt;
  const cr = virtCheck.crCheck;
  const resp = await apiRequest(clusterName,
    `/apis/${cr.group}/${cr.version}/namespaces/${virtCheck.namespace}/${cr.resource}/${cr.name}`);
  if (!resp.ok) {
    return { ok: false, message: 'MTV requires OpenShift Virtualization. Install it first.' };
  }
  return { ok: true, message: 'OpenShift Virtualization ready. Configure the source provider in MTV after installation.' };
}

function parseMemory(memStr) {
  if (!memStr) return 0;
  const match = memStr.match(/^(\d+)(\w+)?$/);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'ki') return val * 1024;
  if (unit === 'mi') return val * 1024 * 1024;
  if (unit === 'gi') return val * 1024 * 1024 * 1024;
  return val;
}

async function checkAcmPrereqs(clusterName) {
  const s3 = config.get().s3 || {};
  const { getConfig: getDashboardConfig } = require('./cluster');
  const dashS3 = getDashboardConfig().s3 || {};
  const bucket = dashS3.bucket || s3.bucket || '';
  const secretKey = dashS3.secretKey || s3.secretKey || '';
  if (!bucket || !secretKey) {
    return { ok: false, message: 'S3 storage must be configured before installing ACM. Go to Settings and enter your S3 bucket, endpoint, and credentials. ACM Observability requires S3 for metrics storage.' };
  }

  const acmNs = OPERATOR_CHECKS.acm.namespace;
  const hubResp = await apiRequest(clusterName,
    `/apis/operator.open-cluster-management.io/v1/namespaces/${acmNs}/multiclusterhubs/multiclusterhub`);
  if (hubResp.ok) {
    return { ok: true, message: 'MultiClusterHub already exists. ACM appears installed.', existing: true };
  }
  const nodesResp = await apiRequest(clusterName, '/api/v1/nodes');
  if (!nodesResp.ok) return { ok: false, message: 'Cannot query cluster nodes' };
  const nodesData = await nodesResp.json();
  const workers = nodesData.items.filter(n =>
    n.metadata.labels?.['node-role.kubernetes.io/worker'] !== undefined);
  const totalMemBytes = workers.reduce((sum, n) =>
    sum + parseMemory(n.status?.allocatable?.memory || '0'), 0);
  const totalMemGi = Math.round(totalMemBytes / (1024 * 1024 * 1024));
  if (totalMemGi < 48) {
    return { ok: true, message: `${workers.length} worker(s) with ${totalMemGi}Gi allocatable memory. ACM recommends 48Gi+. Install may work but could be resource-constrained.`, warning: true };
  }
  return { ok: true, message: `${workers.length} worker(s) with ${totalMemGi}Gi allocatable memory. Ready for ACM.` };
}

async function checkPxMulticlusterPrereqs() {
  return { ok: true, message: 'ACM will be installed as part of the ACM role before Portworx Multi-Cluster.' };
}

async function checkStoragePrereqs(clusterName) {
  const pxCfg = cfg.portworx || {};
  const minWorkers = pxCfg.minWorkers || 3;

  const infraResp = await apiRequest(clusterName, '/apis/config.openshift.io/v1/infrastructures/cluster');
  let platform = 'unknown';
  if (infraResp.ok) {
    const infra = await infraResp.json();
    platform = (infra.status?.platformStatus?.type || 'unknown').toLowerCase();
  }

  const nodesResp = await apiRequest(clusterName, '/api/v1/nodes');
  if (!nodesResp.ok) return { ok: false, message: 'Cannot query cluster nodes' };
  const nodesData = await nodesResp.json();
  const workers = nodesData.items.filter(n =>
    n.metadata.labels?.['node-role.kubernetes.io/worker'] !== undefined);

  if (workers.length === 0) {
    return { ok: false, message: 'No worker nodes found. Portworx requires worker nodes.' };
  }

  if (workers.length < minWorkers) {
    return { ok: true, message: `Only ${workers.length} worker node(s) found. Portworx recommends at least ${minWorkers} for production quorum. Install may work but with reduced resilience.`, warning: true, platform };
  }

  const platformCfg = findPlatformConfig(platform, clusterName);

  if (platformCfg?.prereqs) {
    const prereqs = platformCfg.prereqs;

    if (prereqs.credentialSecret) {
      const cs = prereqs.credentialSecret;
      const secretResp = await apiRequest(clusterName, `/api/v1/namespaces/${cs.namespace}/secrets/${cs.name}`);
      if (!secretResp.ok) {
        return { ok: false, message: cs.missingMessage, platform };
      }
      const secret = await secretResp.json();
      const allPresent = (cs.requiredKeys || []).every(key =>
        secret.data?.[key] && Buffer.from(secret.data[key], 'base64').toString().trim()
      );
      if (!allPresent) {
        return { ok: false, message: cs.emptyMessage, platform };
      }
    }

    return { ok: true, message: `${workers.length} ${prereqs.readyMessage}`, platform };
  }

  const fallback = pxCfg.prereqMessages || {};
  if (platform === 'baremetal' || platform === 'none') {
    return { ok: true, message: `${workers.length} ${fallback.baremetal || 'bare-metal worker(s).'}`, platform };
  }

  const msg = (fallback.unknown || 'worker(s) on {{platform}}.').replace('{{platform}}', platform);
  return { ok: true, message: `${workers.length} ${msg}`, platform, warning: true };
}

function findPlatformConfig(platform, clusterName) {
  const pxCfg = cfg.portworx || {};
  const { getCluster } = require('./cluster');
  const c = getCluster(clusterName);
  const api = c?.api || '';
  const stsEnabled = c?.stsEnabled || false;
  const hasCertManager = c?.hasCertManager || false;
  const rules = pxCfg.platformDetection || [];
  for (const rule of rules) {
    if (rule.platform.toLowerCase() !== platform.toLowerCase()) continue;
    if (rule.matchApi && !api.includes(rule.matchApi)) continue;
    if (rule.matchSts === true && !stsEnabled) continue;
    if (rule.matchSts === false && stsEnabled) continue;
    if (rule.matchCertManager === true && !hasCertManager) continue;
    if (rule.matchCertManager === false && hasCertManager) continue;
    return pxCfg.platforms?.[rule.key];
  }
  return null;
}

async function scanCluster(clusterName, emitEvent) {
  const results = {};
  for (const [key, check] of Object.entries(OPERATOR_CHECKS)) {
    if (emitEvent) emitEvent({ type: 'scan', cluster: clusterName, operator: key, status: 'scanning' });
    try {
      const status = await checkOperatorStatus(clusterName, key);
      const prereqs = await check.checkPrereqs(clusterName);
      results[key] = {
        name: OPERATORS[key].name,
        status: status.phase,
        csvName: status.csvName,
        crStatus: status.crStatus,
        prereqs,
        yamlGenerated: listYamlFiles(clusterName, key).length > 0
      };
    } catch (e) {
      results[key] = {
        name: OPERATORS[key].name,
        status: 'error',
        error: e.message,
        prereqs: { ok: false, message: e.message }
      };
    }
    if (emitEvent) emitEvent({ type: 'scan', cluster: clusterName, operator: key, result: results[key] });
  }
  await setClusterScanResult(clusterName, results);
  return results;
}

async function checkOperatorStatus(clusterName, operatorKey) {
  const check = OPERATOR_CHECKS[operatorKey];
  if (!check || !check.csvPrefix) return { phase: 'placeholder' };

  const csvResp = await apiRequest(clusterName,
    `/apis/operators.coreos.com/v1alpha1/namespaces/${check.namespace}/clusterserviceversions`);

  let phase = 'not_installed';
  let csvName = null;

  if (csvResp.ok) {
    const csvData = await csvResp.json();
    const csv = csvData.items?.find(c => c.metadata.name.startsWith(check.csvPrefix));
    if (csv) {
      csvName = csv.metadata.name;
      phase = (csv.status?.phase || 'unknown').toLowerCase();
      if (phase === 'succeeded') phase = 'installed';
      else if (phase === 'installing') phase = 'installing';
      else if (phase === 'failed') phase = 'error';
    }
  }

  let crStatus = null;
  if (check.crCheck && phase === 'installed') {
    const cr = check.crCheck;
    let crPath;
    if (cr.name) {
      crPath = cr.clusterScoped
        ? `/apis/${cr.group}/${cr.version}/${cr.resource}/${cr.name}`
        : `/apis/${cr.group}/${cr.version}/namespaces/${check.namespace}/${cr.resource}/${cr.name}`;
    } else {
      crPath = cr.clusterScoped
        ? `/apis/${cr.group}/${cr.version}/${cr.resource}`
        : `/apis/${cr.group}/${cr.version}/namespaces/${check.namespace}/${cr.resource}`;
    }
    const crResp = await apiRequest(clusterName, crPath);
    if (crResp.ok) {
      const crData = await crResp.json();
      if (cr.name) {
        crStatus = crData.status?.phase || crData.status?.conditions?.[0]?.type || 'exists';
      } else {
        const items = crData.items || [];
        crStatus = items.length > 0 ? (items[0].status?.phase || 'exists') : 'not_created';
      }
    } else {
      crStatus = 'not_created';
    }
  }

  return { phase, csvName, crStatus };
}

const KIND_META = {
  'Namespace': { plural: 'namespaces', clusterScoped: true },
  'Subscription': { plural: 'subscriptions' },
  'ConfigMap': { plural: 'configmaps' },
  'OperatorGroup': { plural: 'operatorgroups' },
  'HyperConverged': { plural: 'hyperconvergeds' },
  'ForkliftController': { plural: 'forkliftcontrollers' },
  'Provider': { plural: 'providers' },
  'MultiClusterHub': { plural: 'multiclusterhubs' },
  'ClusterRole': { plural: 'clusterroles', clusterScoped: true },
  'ClusterRoleBinding': { plural: 'clusterrolebindings', clusterScoped: true },
  'Role': { plural: 'roles' },
  'RoleBinding': { plural: 'rolebindings' },
  'Service': { plural: 'services' },
  'Route': { plural: 'routes' },
  'Secret': { plural: 'secrets' },
  'MultiClusterObservability': { plural: 'multiclusterobservabilities', clusterScoped: true },
};

const WAIT_AFTER = new Set(['03-subscription.yaml', '04-subscription.yaml', '04-forkliftcontroller.yaml']);

const WAIT_FOR_API = {
  'acm:04-multiclusterhub.yaml': '/apis/observability.open-cluster-management.io/v1beta2'
};

function extractYamlField(yaml, field) {
  const re = new RegExp(`^\\s*${field}:\\s*(.+)`, 'm');
  const m = yaml.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

async function resolveLatestChannel(clusterName, packageName) {
  const resp = await apiRequest(clusterName,
    `/apis/packages.operators.coreos.com/v1/namespaces/openshift-marketplace/packagemanifests/${packageName}`);
  if (!resp.ok) return null;
  const pkg = await resp.json();
  const channels = (pkg.status?.channels || []).map(c => c.name);
  if (channels.length === 0) return null;
  channels.sort((a, b) => {
    const aNums = a.match(/[\d.]+/g)?.map(Number) || [0];
    const bNums = b.match(/[\d.]+/g)?.map(Number) || [0];
    for (let i = 0; i < Math.max(aNums.length, bNums.length); i++) {
      if ((aNums[i] || 0) !== (bNums[i] || 0)) return (aNums[i] || 0) - (bNums[i] || 0);
    }
    return 0;
  });
  return channels[channels.length - 1];
}

async function installOperator(clusterName, operatorKey, emitEvent) {
  // Apply only current templates, not obsolete files retained in the YAML cache.
  const files = generateAndSave(clusterName, operatorKey).sort();
  if (files.length === 0) {
    throw new Error(`No YAML files available for ${operatorKey}.`);
  }

  const results = [];
  for (const file of files) {
    const raw = readYamlFile(clusterName, operatorKey, file);
    const docs = parseYamlDocuments(raw);

    for (let content of docs) {
    const apiVersion = extractYamlField(content, 'apiVersion');
    const kind = extractYamlField(content, 'kind') || file;
    const km = KIND_META[kind];

    if (kind === 'Subscription') {
      const specIdx = content.indexOf('\nspec:');
      const specContent = specIdx >= 0 ? content.slice(specIdx) : content;
      const pkgName = extractYamlField(specContent, 'name');
      if (pkgName) {
        const latest = await resolveLatestChannel(clusterName, pkgName);
        if (latest) {
          content = content.replace(/channel:\s*.+/, `channel: ${latest}`);
          if (emitEvent) emitEvent({
            type: 'install', cluster: clusterName, operator: operatorKey,
            action: `Resolved ${pkgName} channel: ${latest}`, status: 'info'
          });
        }
      }
    }

    const name = extractYamlField(content, 'name');
    const ns = extractYamlField(content, 'namespace');

    if (kind === 'OperatorGroup' && ns) {
      const ogResp = await apiRequest(clusterName,
        `/apis/operators.coreos.com/v1/namespaces/${ns}/operatorgroups`);
      if (ogResp.ok) {
        const ogData = await ogResp.json();
        if ((ogData.items || []).length > 0) {
          const existing = ogData.items[0].metadata.name;
          if (emitEvent) emitEvent({
            type: 'install', cluster: clusterName, operator: operatorKey,
            action: `OperatorGroup already exists in ${ns} (${existing}), skipping`, status: 'info'
          });
          results.push({ file, kind, name, status: 'skipped', info: `existing OG: ${existing}` });
          continue;
        }
      }
    }

    if (emitEvent) emitEvent({
      type: 'install', cluster: clusterName, operator: operatorKey,
      action: `Applying ${kind} ${name || ''}`, file
    });

    try {
      if (!apiVersion || !km) {
        results.push({ file, kind, name, status: 'error', error: `Unknown resource kind: ${kind}` });
        continue;
      }

      const prefix = apiVersion.includes('/') ? 'apis' : 'api';
      const apiPath = km.clusterScoped
        ? `/${prefix}/${apiVersion}/${km.plural}/${name}`
        : `/${prefix}/${apiVersion}/namespaces/${ns}/${km.plural}/${name}`;

      const resp = await apiRequest(clusterName, `${apiPath}?fieldManager=installation-dashboard&force=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/apply-patch+yaml' },
        body: content
      });

      if (resp.ok) {
        results.push({ file, kind, name, status: 'applied' });
        if (emitEvent) emitEvent({
          type: 'install', cluster: clusterName, operator: operatorKey,
          action: `Applied ${kind} ${name || ''}`, status: 'success'
        });
      } else {
        const text = await resp.text();
        results.push({ file, kind, name, status: 'error', error: text });
        if (emitEvent) emitEvent({
          type: 'install', cluster: clusterName, operator: operatorKey,
          action: `Failed ${kind} ${name || ''}: ${text}`, status: 'error'
        });
      }

      if (WAIT_AFTER.has(file)) {
        if (emitEvent) emitEvent({
          type: 'install', cluster: clusterName, operator: operatorKey,
          action: 'Waiting for operator CSV to install CRDs (up to 120s)...', status: 'info'
        });
        await waitForCRD(clusterName, operatorKey, emitEvent);
      }

      const apiWaitKey = `${operatorKey}:${file}`;
      const apiWaitPath = WAIT_FOR_API[apiWaitKey];
      if (apiWaitPath) {
        if (emitEvent) emitEvent({
          type: 'install', cluster: clusterName, operator: operatorKey,
          action: `Waiting for ${apiWaitPath} to become available (up to 300s)...`, status: 'info'
        });
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const resp = await apiRequest(clusterName, apiWaitPath);
            if (resp.ok) {
              if (emitEvent) emitEvent({
                type: 'install', cluster: clusterName, operator: operatorKey,
                action: 'API available, continuing...', status: 'success'
              });
              break;
            }
          } catch (e) { /* keep waiting */ }
          if (i > 0 && i % 6 === 0 && emitEvent) {
            emitEvent({
              type: 'install', cluster: clusterName, operator: operatorKey,
              action: `Still waiting for API (${(i + 1) * 5}s)...`, status: 'info'
            });
          }
          if (i === 59) {
            const msg = `API ${apiWaitPath} not available after 300s`;
            if (emitEvent) emitEvent({
              type: 'install', cluster: clusterName, operator: operatorKey,
              action: msg, status: 'error'
            });
            throw new Error(msg);
          }
        }
      }
    } catch (e) {
      results.push({ file, kind, name, status: 'error', error: e.message });
      if (emitEvent) emitEvent({
        type: 'install', cluster: clusterName, operator: operatorKey,
        action: `Error: ${e.message}`, status: 'error'
      });
    }
    } // end docs loop
  }

  const opCfg = config.get().operators?.[operatorKey];
  console.log(`installOperator ${operatorKey}: consolePlugin=${opCfg?.consolePlugin || 'none'}`);
  if (opCfg?.consolePlugin) {
    await enableConsolePlugin(clusterName, opCfg.consolePlugin, emitEvent);
  }

  return results;
}

async function enableConsolePlugin(clusterName, pluginName, emitEvent) {
  console.log(`enableConsolePlugin: cluster=${clusterName} plugin=${pluginName}`);
  if (emitEvent) emitEvent({
    type: 'install', cluster: clusterName, operator: pluginName,
    action: `Enabling ${pluginName} console plugin...`, status: 'info'
  });

  const resp = await apiRequest(clusterName, '/apis/operator.openshift.io/v1/consoles/cluster');
  console.log(`enableConsolePlugin: console GET status=${resp.status}`);
  if (!resp.ok) {
    if (emitEvent) emitEvent({
      type: 'install', cluster: clusterName, operator: pluginName,
      action: 'Could not read console config — plugin not enabled', status: 'error'
    });
    return;
  }

  const consoleConfig = await resp.json();
  const plugins = consoleConfig.spec?.plugins || [];

  if (plugins.includes(pluginName)) {
    if (emitEvent) emitEvent({
      type: 'install', cluster: clusterName, operator: pluginName,
      action: 'Console plugin already enabled', status: 'info'
    });
    return;
  }

  plugins.push(pluginName);
  const patchResp = await apiRequest(clusterName, '/apis/operator.openshift.io/v1/consoles/cluster', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { plugins } })
  });

  if (!patchResp.ok) {
    const text = await patchResp.text();
    if (emitEvent) emitEvent({
      type: 'install', cluster: clusterName, operator: pluginName,
      action: `Console plugin failed: ${text}`, status: 'error'
    });
  } else {
    if (emitEvent) emitEvent({
      type: 'install', cluster: clusterName, operator: pluginName,
      action: 'Console plugin enabled', status: 'info'
    });
  }
}

async function waitForCRD(clusterName, operatorKey, emitEvent) {
  const check = OPERATOR_CHECKS[operatorKey];
  if (!check?.crCheck) return;

  const cr = check.crCheck;
  const crdPath = `/apis/${cr.group}/${cr.version}`;
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const csvStatus = await checkOperatorStatus(clusterName, operatorKey);
    if (csvStatus.phase === 'error') {
      const msg = `Operator CSV failed: ${csvStatus.csvName || operatorKey}`;
      if (emitEvent) emitEvent({
        type: 'install', cluster: clusterName, operator: operatorKey,
        action: msg, status: 'error'
      });
      throw new Error(msg);
    }

    try {
      const resp = await apiRequest(clusterName, crdPath);
      if (resp.ok) {
        if (emitEvent) emitEvent({
          type: 'install', cluster: clusterName, operator: operatorKey,
          action: 'CRD is available, continuing...', status: 'success'
        });
        return;
      }
    } catch (e) { /* keep waiting */ }

    if (i > 0 && i % 6 === 0 && emitEvent) {
      emitEvent({
        type: 'install', cluster: clusterName, operator: operatorKey,
        action: `Still waiting for CRDs (${(i + 1) * 5}s, CSV phase: ${csvStatus.phase})...`, status: 'info'
      });
    }
  }

  const msg = `CRD not available after ${maxAttempts * 5}s — operator may have failed to install`;
  if (emitEvent) emitEvent({
    type: 'install', cluster: clusterName, operator: operatorKey,
    action: msg, status: 'error'
  });
  throw new Error(msg);
}

async function getInstallStatus(clusterName, operatorKey, emitEvent) {
  const status = await checkOperatorStatus(clusterName, operatorKey);
  const check = OPERATOR_CHECKS[operatorKey];

  let events = [];
  if (check?.namespace) {
    const eventsResp = await apiRequest(clusterName,
      `/api/v1/namespaces/${check.namespace}/events?limit=20`);
    if (eventsResp.ok) {
      const eventsData = await eventsResp.json();
      events = (eventsData.items || [])
        .sort((a, b) => new Date(b.lastTimestamp || b.metadata.creationTimestamp) - new Date(a.lastTimestamp || a.metadata.creationTimestamp))
        .slice(0, 10)
        .map(e => ({
          type: e.type,
          reason: e.reason,
          message: e.message,
          time: e.lastTimestamp || e.metadata.creationTimestamp,
          involvedObject: `${e.involvedObject.kind}/${e.involvedObject.name}`
        }));
    }
  }

  return { ...status, events };
}

async function uninstallOperator(clusterName, operatorKey, emitEvent) {
  const check = OPERATOR_CHECKS[operatorKey];
  if (!check) throw new Error(`Unknown operator: ${operatorKey}`);
  const results = [];

  // 1. Delete CR (triggers operator cleanup — VMs, pipelines, etc.)
  if (check.crCheck) {
    const cr = check.crCheck;
    const crPath = cr.clusterScoped
      ? `/apis/${cr.group}/${cr.version}/${cr.resource}/${cr.name}`
      : `/apis/${cr.group}/${cr.version}/namespaces/${check.namespace}/${cr.resource}/${cr.name}`;
    if (emitEvent) emitEvent({
      type: 'uninstall', cluster: clusterName, operator: operatorKey,
      action: `Deleting ${cr.resource}/${cr.name}...`, status: 'info'
    });
    const resp = await apiRequest(clusterName, crPath, { method: 'DELETE' });
    results.push({ resource: `${cr.resource}/${cr.name}`, status: resp.ok ? 'deleted' : 'not_found' });

    // Wait for CR deletion (operator needs time to clean up workloads)
    if (resp.ok) {
      if (emitEvent) emitEvent({
        type: 'uninstall', cluster: clusterName, operator: operatorKey,
        action: `Waiting for ${cr.resource}/${cr.name} cleanup (up to 120s)...`, status: 'info'
      });
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const check2 = await apiRequest(clusterName, crPath);
        if (!check2.ok) break;
      }
    }
  }

  // 2. Delete Subscription
  if (check.csvPrefix) {
    const subResp = await apiRequest(clusterName,
      `/apis/operators.coreos.com/v1alpha1/namespaces/${check.namespace}/subscriptions`);
    if (subResp.ok) {
      const subs = await subResp.json();
      for (const sub of (subs.items || [])) {
        if (sub.metadata.name.includes(check.csvPrefix) || sub.spec?.name?.includes(check.csvPrefix)) {
          if (emitEvent) emitEvent({
            type: 'uninstall', cluster: clusterName, operator: operatorKey,
            action: `Deleting Subscription ${sub.metadata.name}...`, status: 'info'
          });
          await apiRequest(clusterName,
            `/apis/operators.coreos.com/v1alpha1/namespaces/${check.namespace}/subscriptions/${sub.metadata.name}`,
            { method: 'DELETE' });
          results.push({ resource: `Subscription/${sub.metadata.name}`, status: 'deleted' });
        }
      }
    }

    // 3. Delete CSV
    const csvResp = await apiRequest(clusterName,
      `/apis/operators.coreos.com/v1alpha1/namespaces/${check.namespace}/clusterserviceversions`);
    if (csvResp.ok) {
      const csvs = await csvResp.json();
      for (const csv of (csvs.items || [])) {
        if (csv.metadata.name.startsWith(check.csvPrefix)) {
          if (emitEvent) emitEvent({
            type: 'uninstall', cluster: clusterName, operator: operatorKey,
            action: `Deleting CSV ${csv.metadata.name}...`, status: 'info'
          });
          await apiRequest(clusterName,
            `/apis/operators.coreos.com/v1alpha1/namespaces/${check.namespace}/clusterserviceversions/${csv.metadata.name}`,
            { method: 'DELETE' });
          results.push({ resource: `CSV/${csv.metadata.name}`, status: 'deleted' });
        }
      }
    }
  }

  // 4. Delete webhooks first (orphaned webhooks block CRD deletion)
  if (check.webhookPrefixes && check.webhookPrefixes.length > 0) {
    if (emitEvent) emitEvent({
      type: 'uninstall', cluster: clusterName, operator: operatorKey,
      action: 'Cleaning up webhooks...', status: 'info'
    });
    for (const whType of ['validatingwebhookconfigurations', 'mutatingwebhookconfigurations']) {
      const whResp = await apiRequest(clusterName,
        `/apis/admissionregistration.k8s.io/v1/${whType}`);
      if (whResp.ok) {
        const whData = await whResp.json();
        for (const wh of (whData.items || [])) {
          if (check.webhookPrefixes.some(p => wh.metadata.name.includes(p))) {
            await apiRequest(clusterName,
              `/apis/admissionregistration.k8s.io/v1/${whType}/${wh.metadata.name}`,
              { method: 'DELETE' });
            results.push({ resource: `Webhook/${wh.metadata.name}`, status: 'deleted' });
          }
        }
      }
    }
  }

  // 5. Delete CRDs belonging to this operator
  if (check.crdGroups && check.crdGroups.length > 0) {
    if (emitEvent) emitEvent({
      type: 'uninstall', cluster: clusterName, operator: operatorKey,
      action: 'Cleaning up CRDs...', status: 'info'
    });
    const crdResp = await apiRequest(clusterName,
      '/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
    if (crdResp.ok) {
      const crdData = await crdResp.json();
      const matching = (crdData.items || []).filter(crd => {
        const crdGroup = crd.spec?.group || '';
        return check.crdGroups.some(g => crdGroup === g || crdGroup.endsWith('.' + g));
      });
      for (const crd of matching) {
        // Remove finalizers first to prevent stuck deletions
        if (crd.metadata.finalizers && crd.metadata.finalizers.length > 0) {
          await apiRequest(clusterName,
            `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${crd.metadata.name}`,
            { method: 'PATCH', headers: { 'Content-Type': 'application/merge-patch+json' },
              body: JSON.stringify({ metadata: { finalizers: [] } }) });
        }
        await apiRequest(clusterName,
          `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${crd.metadata.name}`,
          { method: 'DELETE' });
        results.push({ resource: `CRD/${crd.metadata.name}`, status: 'deleted' });
      }
      if (matching.length > 0 && emitEvent) emitEvent({
        type: 'uninstall', cluster: clusterName, operator: operatorKey,
        action: `Removed ${matching.length} CRDs`, status: 'info'
      });
    }
  }

  // 6. Delete Namespace (only for operators with their own namespace)
  const sharedNamespaces = cfg.sharedNamespaces || ['openshift-operators', 'openshift-marketplace'];
  if (check.namespace && !sharedNamespaces.includes(check.namespace)) {
    if (emitEvent) emitEvent({
      type: 'uninstall', cluster: clusterName, operator: operatorKey,
      action: `Deleting namespace ${check.namespace}...`, status: 'info'
    });
    const nsResp = await apiRequest(clusterName,
      `/api/v1/namespaces/${check.namespace}`, { method: 'DELETE' });
    results.push({ resource: `Namespace/${check.namespace}`, status: nsResp.ok ? 'deleted' : 'not_found' });
  }

  if (emitEvent) emitEvent({
    type: 'uninstall', cluster: clusterName, operator: operatorKey,
    action: `${OPERATORS[operatorKey]?.name || operatorKey} uninstalled`, status: 'success'
  });

  return results;
}

module.exports = {
  scanCluster,
  checkOperatorStatus,
  installOperator,
  uninstallOperator,
  getInstallStatus,
  OPERATOR_CHECKS
};
