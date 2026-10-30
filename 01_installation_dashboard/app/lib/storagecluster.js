const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cluster = require('./cluster');
const config = require('./config');

const SPEC_BASE = path.resolve(__dirname, '../..');

function storageNamespace() {
  return config.get().operators?.storage?.namespace || 'portworx';
}

function resolvePlatformKey(clusterName) {
  const c = cluster.getCluster(clusterName);
  if (!c) throw new Error(`Unknown cluster: ${clusterName}`);
  const platform = c.platform || '';
  const api = c.api || '';
  const stsEnabled = c.stsEnabled || false;
  const hasCertManager = c.hasCertManager || false;

  const cfg = config.get();
  const rules = cfg.portworx?.platformDetection || [];

  for (const rule of rules) {
    if (rule.platform !== platform) continue;
    if (rule.matchApi && !api.includes(rule.matchApi)) continue;
    if (rule.matchSts === true && !stsEnabled) continue;
    if (rule.matchSts === false && stsEnabled) continue;
    if (rule.matchCertManager === true && !hasCertManager) continue;
    if (rule.matchCertManager === false && hasCertManager) continue;
    return rule.key;
  }

  throw new Error(`Unsupported platform: ${platform || 'unknown'}. Run Test on the Setup tab first.`);
}

function getPlatformConfig(platformKey) {
  const cfg = config.get();
  const platformCfg = cfg.portworx?.platforms?.[platformKey];
  if (!platformCfg) throw new Error(`No StorageCluster config for platform: ${platformKey}`);
  return platformCfg;
}

function getSpecPath(platformKey) {
  const platformCfg = getPlatformConfig(platformKey);
  const cfg = config.get();
  const specDir = cfg.portworx?.specDir || 'portworx';
  const fullPath = path.resolve(SPEC_BASE, specDir, platformCfg.spec);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`StorageCluster spec not found: ${platformCfg.spec}`);
  }
  return fullPath;
}

function readSpec(platformKey) {
  const specPath = getSpecPath(platformKey);
  const content = fs.readFileSync(specPath, 'utf8');
  return { content, parsed: yaml.load(content) };
}

function injectCredentials(spec, platformKey, creds) {
  const platformCfg = getPlatformConfig(platformKey);
  const mode = platformCfg.credentialMode;

  if (mode === 'workloadIdentity') {
    const wi = platformCfg.workloadIdentity;
    if (!creds || !creds[wi.credField]) {
      throw new Error(`${platformKey} credentials not configured. Save them in the Configure tab first.`);
    }
    spec.spec = spec.spec || {};
    spec.spec.workloadIdentity = {
      credentials: [{
        cloudProvider: wi.cloudProvider,
        key: wi.key,
        value: creds[wi.credField]
      }]
    };
  }
}

async function createCredentialSecret(clusterName, platformKey, emitEvent) {
  const platformCfg = getPlatformConfig(platformKey);
  if (platformCfg.credentialMode !== 'secret') return;

  const creds = cluster.getPxCredentials(clusterName);
  if (!creds) {
    throw new Error(`${platformKey} credentials not configured. Save them in the Configure tab first.`);
  }

  const secretCfg = platformCfg.secret;
  const data = {};
  for (const [secretKey, credField] of Object.entries(secretCfg.keys)) {
    const value = creds[credField];
    if (!value) throw new Error(`Missing credential field: ${credField}`);
    data[secretKey] = Buffer.from(value).toString('base64');
  }

  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretCfg.name, namespace: secretCfg.namespace },
    type: 'Opaque',
    data
  };

  emitEvent({ type: 'storagecluster', cluster: clusterName, action: `Creating ${secretCfg.name} secret...`, status: 'info' });

  let resp = await cluster.apiRequest(clusterName,
    `/api/v1/namespaces/${secretCfg.namespace}/secrets`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

  if (resp.status === 409) {
    resp = await cluster.apiRequest(clusterName,
      `/api/v1/namespaces/${secretCfg.namespace}/secrets/${secretCfg.name}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create ${secretCfg.name} secret: ${resp.status} ${text}`);
  }
}

async function applySpec(clusterName, spec, emitEvent) {
  const scName = spec.metadata?.name;
  emitEvent({ type: 'storagecluster', cluster: clusterName, action: `Applying StorageCluster ${scName}...`, status: 'info' });

  const scNs = storageNamespace();
  const checkResp = await cluster.apiRequest(clusterName,
    `/apis/core.libopenstorage.org/v1/namespaces/${scNs}/storageclusters/${scName}`);

  if (checkResp.ok) {
    const existing = await checkResp.json();
    spec.metadata.resourceVersion = existing.metadata.resourceVersion;
    const resp = await cluster.apiRequest(clusterName,
      `/apis/core.libopenstorage.org/v1/namespaces/${scNs}/storageclusters/${scName}`, {
        method: 'PUT',
        body: JSON.stringify(spec)
      });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to update StorageCluster: ${resp.status} ${text}`);
    }
    emitEvent({ type: 'storagecluster', cluster: clusterName, action: 'StorageCluster updated', status: 'info' });
  } else {
    const resp = await cluster.apiRequest(clusterName,
      `/apis/core.libopenstorage.org/v1/namespaces/${scNs}/storageclusters`, {
        method: 'POST',
        body: JSON.stringify(spec)
      });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create StorageCluster: ${resp.status} ${text}`);
    }
    emitEvent({ type: 'storagecluster', cluster: clusterName, action: 'StorageCluster created', status: 'info' });
  }
}

function injectPlacement(spec) {
  const cfg = config.get();
  const excludeTaints = cfg.portworx?.excludeTaints;
  if (!excludeTaints || excludeTaints.length === 0) return;

  spec.spec = spec.spec || {};
  spec.spec.placement = spec.spec.placement || {};
  spec.spec.placement.tolerations = (spec.spec.placement.tolerations || [])
    .filter(t => !excludeTaints.some(e => e.key === t.key));
  spec.spec.placement.nodeAffinity = {
    requiredDuringSchedulingIgnoredDuringExecution: {
      nodeSelectorTerms: [{
        matchExpressions: excludeTaints.map(t => ({
          key: t.key,
          operator: 'DoesNotExist'
        }))
      }]
    }
  };
}

async function deploy(clusterName, emitEvent) {
  const platformKey = resolvePlatformKey(clusterName);
  const { parsed: spec } = readSpec(platformKey);
  const creds = cluster.getPxCredentials(clusterName);

  emitEvent({ type: 'storagecluster', cluster: clusterName, action: `Deploying StorageCluster (${platformKey})...`, status: 'started' });

  injectCredentials(spec, platformKey, creds);
  injectPlacement(spec);
  await createCredentialSecret(clusterName, platformKey, emitEvent);
  await applySpec(clusterName, spec, emitEvent);

  emitEvent({ type: 'storagecluster', cluster: clusterName, action: 'StorageCluster deployed successfully', status: 'complete' });
}

async function getStatus(clusterName) {
  const c = cluster.getCluster(clusterName);
  const result = {
    storageCluster: { exists: false, status: 'unknown', name: '' },
    credentials: { configured: false, type: '' },
    consolePlugin: false,
    licenseApplied: c?.licenseApplied || false
  };

  const creds = cluster.getPxCredentials(clusterName);
  if (creds) {
    result.credentials.configured = true;
    result.credentials.type = creds.type;
  }

  try {
    const resp = await cluster.apiRequest(clusterName,
      `/apis/core.libopenstorage.org/v1/namespaces/${storageNamespace()}/storageclusters`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.items && data.items.length > 0) {
        const sc = data.items[0];
        result.storageCluster.exists = true;
        result.storageCluster.name = sc.metadata.name;
        const phase = sc.status?.phase || '';
        if (phase === 'Online' || phase === 'Running') {
          result.storageCluster.status = 'online';
          result.licenseApplied = true;
        } else if (phase === 'Initializing' || phase === 'Installing') {
          result.storageCluster.status = 'initializing';
        } else if (phase) {
          result.storageCluster.status = phase.toLowerCase();
        }
      }
    }
  } catch (e) { /* cluster unreachable */ }

  try {
    const resp = await cluster.apiRequest(clusterName, '/apis/operator.openshift.io/v1/consoles/cluster');
    if (resp.ok) {
      const data = await resp.json();
      const plugins = data.spec?.plugins || [];
      result.consolePlugin = plugins.includes(config.get().operators?.storage?.consolePlugin || 'portworx');
    }
  } catch (e) { /* ignore */ }

  return result;
}

function previewSpec(clusterName) {
  const platformKey = resolvePlatformKey(clusterName);
  const { content } = readSpec(platformKey);
  return { platformKey, content };
}

async function deleteStorageCluster(clusterName, emitEvent) {
  emitEvent({ type: 'storagecluster', cluster: clusterName, action: 'Deleting StorageCluster...', status: 'started' });

  const scNs = storageNamespace();
  const listResp = await cluster.apiRequest(clusterName,
    `/apis/core.libopenstorage.org/v1/namespaces/${scNs}/storageclusters`);
  if (!listResp.ok) {
    throw new Error(`Failed to list StorageClusters: ${listResp.status}`);
  }

  const data = await listResp.json();
  const items = data.items || [];
  if (items.length === 0) {
    emitEvent({ type: 'storagecluster', cluster: clusterName, action: 'No StorageCluster found', status: 'complete' });
    return;
  }

  for (const sc of items) {
    const name = sc.metadata.name;
    const resp = await cluster.apiRequest(clusterName,
      `/apis/core.libopenstorage.org/v1/namespaces/${scNs}/storageclusters/${name}`, {
        method: 'DELETE'
      });
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text();
      throw new Error(`Failed to delete StorageCluster ${name}: ${resp.status} ${text}`);
    }
    emitEvent({ type: 'storagecluster', cluster: clusterName, action: `Deleted StorageCluster ${name}`, status: 'info' });
  }

  emitEvent({ type: 'storagecluster', cluster: clusterName, action: 'StorageCluster deleted', status: 'complete' });
}

module.exports = {
  resolvePlatformKey,
  readSpec,
  deploy,
  deleteStorageCluster,
  getStatus,
  previewSpec
};
