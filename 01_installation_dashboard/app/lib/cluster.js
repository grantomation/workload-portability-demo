const fs = require('fs');
const path = require('path');
const config = require('./config');

const NAMESPACE = process.env.NAMESPACE || config.get().namespace;
const SECRET_NAME = config.get().clustersSecret || 'installation-dashboard-clusters';
const CONFIG_SECRET = config.get().configSecret || 'installation-dashboard-config';
const DATA_DIR = process.env.DATA_DIR || '/data';
const YAML_DIR = path.join(DATA_DIR, 'yaml');

let clusters = {};
let tokenCache = {};
let dashboardConfig = {};

function inCluster() {
  return fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
}

function localK8sClient() {
  const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
  const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  return { token, ca, base: `https://${host}:${port}` };
}

async function loadClusters() {
  if (!inCluster()) {
    const file = path.join(DATA_DIR, 'clusters.json');
    if (fs.existsSync(file)) {
      clusters = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (backfillPositions()) await saveClusters();
    }
    return;
  }
  const k8s = localK8sClient();
  try {
    const resp = await k8sFetch(`${k8s.base}/api/v1/namespaces/${NAMESPACE}/secrets/${SECRET_NAME}`, {
      headers: { Authorization: `Bearer ${k8s.token}` },
      ca: k8s.ca
    });
    if (resp.ok) {
      const secret = await resp.json();
      if (secret.data && secret.data.clusters) {
        clusters = JSON.parse(Buffer.from(secret.data.clusters, 'base64').toString());
      }
    }
  } catch (e) {
    console.error('Failed to load clusters from Secret:', e.message);
  }
  if (backfillPositions()) await saveClusters();
}

function backfillPositions() {
  let maxPos = 0;
  let dirty = false;
  for (const c of Object.values(clusters)) {
    if (c.lbPosition != null && c.lbPosition !== 999) maxPos = Math.max(maxPos, c.lbPosition);
  }
  for (const c of Object.values(clusters)) {
    if (c.lbPosition == null) { c.lbPosition = ++maxPos; dirty = true; }
    if ((c.assignedRoles || []).includes('acm') && !c.excludeFromLb) { c.excludeFromLb = true; dirty = true; }
  }
  return dirty;
}

async function saveClusters() {
  if (!inCluster()) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'clusters.json'), JSON.stringify(clusters, null, 2));
    return;
  }
  const k8s = localK8sClient();
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: SECRET_NAME, namespace: NAMESPACE },
    data: { clusters: Buffer.from(JSON.stringify(clusters)).toString('base64') }
  };
  try {
    let resp = await k8sFetch(`${k8s.base}/api/v1/namespaces/${NAMESPACE}/secrets/${SECRET_NAME}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${k8s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ca: k8s.ca
    });
    if (resp.status === 404) {
      resp = await k8sFetch(`${k8s.base}/api/v1/namespaces/${NAMESPACE}/secrets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${k8s.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ca: k8s.ca
      });
    }
    if (!resp.ok) {
      const text = await resp.text();
      console.error('Failed to save clusters Secret:', resp.status, text);
    }
  } catch (e) {
    console.error('Failed to save clusters:', e.message);
  }
}

function k8sFetch(url, opts = {}, redirectCount = 0) {
  const { ca, body, method, headers, noRedirect } = opts;
  const parsed = new URL(url);
  const mod = parsed.protocol === 'https:' ? require('https') : require('http');

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method || 'GET',
      headers: headers || {},
      rejectUnauthorized: false,
      timeout: 15000
    };
    if (ca) reqOpts.ca = ca;

    const bodyStr = body ? (typeof body === 'string' ? body : body.toString()) : null;
    if (bodyStr) reqOpts.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = mod.request(reqOpts, (res) => {
      if (!noRedirect && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(k8sFetch(redirectUrl, opts, redirectCount + 1));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: () => Promise.resolve(raw),
          json: () => {
            try { return Promise.resolve(JSON.parse(raw)); }
            catch (e) { return Promise.reject(new Error(`JSON parse error: ${raw.slice(0, 200)}`)); }
          }
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getToken(clusterName) {
  const cluster = clusters[clusterName];
  if (!cluster) throw new Error(`Unknown cluster: ${clusterName}`);

  const cached = tokenCache[clusterName];
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const apiUrl = cluster.api.replace(/\/$/, '');
  const metaResp = await k8sFetch(`${apiUrl}/.well-known/oauth-authorization-server`);
  if (!metaResp.ok) throw new Error(`Failed to discover OAuth endpoint on ${clusterName}`);
  const { authorization_endpoint } = await metaResp.json();

  const authUrl = `${authorization_endpoint}?response_type=token&client_id=openshift-challenging-client`;
  const authResp = await k8sFetch(authUrl, {
    method: 'GET',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${cluster.user}:${cluster.password}`).toString('base64'),
      'X-CSRF-Token': '1'
    },
    noRedirect: true
  });

  if (authResp.status === 302 || authResp.status === 301) {
    const location = authResp.headers.location || '';
    const hashMatch = location.match(/access_token=([^&]+)/);
    if (!hashMatch) {
      throw new Error(`Authentication failed for ${clusterName}: redirect had no token. Location: ${location.slice(0, 200)}`);
    }
    const token = decodeURIComponent(hashMatch[1]);
    const expiresMatch = location.match(/expires_in=(\d+)/);
    const expiresIn = expiresMatch ? parseInt(expiresMatch[1], 10) : 86400;
    tokenCache[clusterName] = {
      token,
      expiresAt: Date.now() + (expiresIn * 1000 - 30000)
    };
    return token;
  }

  if (authResp.ok || authResp.status >= 400) {
    const text = await authResp.text();
    throw new Error(`Authentication failed for ${clusterName}: ${authResp.status} ${text}`);
  }

  throw new Error(`Authentication failed for ${clusterName}: unexpected status ${authResp.status}`);
}

function clearToken(clusterName) {
  delete tokenCache[clusterName];
}

async function apiRequest(clusterName, apiPath, opts = {}) {
  const cluster = clusters[clusterName];
  if (!cluster) throw new Error(`Unknown cluster: ${clusterName}`);
  const apiUrl = cluster.api.replace(/\/$/, '');

  let token;
  try {
    token = await getToken(clusterName);
  } catch (e) {
    throw new Error(`Auth failed for ${clusterName}: ${e.message}`);
  }

  const resp = await k8sFetch(`${apiUrl}${apiPath}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers }
  });

  if (resp.status === 401) {
    clearToken(clusterName);
    token = await getToken(clusterName);
    const retry = await k8sFetch(`${apiUrl}${apiPath}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers }
    });
    return retry;
  }
  return resp;
}

async function testCluster(clusterName) {
  const resp = await apiRequest(clusterName, '/apis/config.openshift.io/v1/clusterversions');
  if (!resp.ok) throw new Error(`Cluster unreachable: ${resp.status}`);
  const cv = await resp.json();
  const version = cv.items?.[0]?.status?.desired?.version || 'unknown';

  const nodesResp = await apiRequest(clusterName, '/api/v1/nodes');
  let nodes = [];
  if (nodesResp.ok) {
    const nodesData = await nodesResp.json();
    nodes = nodesData.items.map(n => ({
      name: n.metadata.name,
      roles: Object.keys(n.metadata.labels || {}).filter(l => l.startsWith('node-role.kubernetes.io/')).map(l => l.split('/')[1]),
      instanceType: n.metadata.labels?.['node.kubernetes.io/instance-type'] || 'unknown',
      allocatableCpu: n.status?.allocatable?.cpu || '0',
      allocatableMemory: n.status?.allocatable?.memory || '0'
    }));
  }

  const infraResp = await apiRequest(clusterName, '/apis/config.openshift.io/v1/infrastructures/cluster');
  let platform = 'unknown';
  if (infraResp.ok) {
    const infra = await infraResp.json();
    platform = infra.status?.platformStatus?.type || 'unknown';
  }

  let stsEnabled = false;
  let oidcIssuer = '';
  const authResp = await apiRequest(clusterName, '/apis/config.openshift.io/v1/authentications/cluster');
  if (authResp.ok) {
    const auth = await authResp.json();
    const issuer = auth.spec?.serviceAccountIssuer || '';
    stsEnabled = issuer.length > 0 && issuer !== 'https://kubernetes.default.svc';
    if (stsEnabled) oidcIssuer = issuer.replace(/^https?:\/\//, '');
  }

  let hasCertManager = false;
  try {
    const cmResp = await apiRequest(clusterName, '/apis/cert-manager.io/v1/certificates');
    hasCertManager = cmResp.ok;
  } catch (e) { /* not installed */ }

  let consoleUrl = '';
  const ingressResp = await apiRequest(clusterName, '/apis/config.openshift.io/v1/ingresses/cluster');
  if (ingressResp.ok) {
    const ingress = await ingressResp.json();
    const appsDomain = ingress.spec?.domain || '';
    if (appsDomain) consoleUrl = `https://${config.get().consoleRoutePrefix || 'console-openshift-console'}.${appsDomain}`;
  }

  return { version, platform, nodes, consoleUrl, stsEnabled, oidcIssuer, hasCertManager, connected: true };
}

function listClusters() {
  return Object.entries(clusters).map(([name, c]) => {
    const base = {
      name,
      type: c.type || 'openshift',
      hasPassword: !!c.password,
      connectionStatus: c.connectionStatus || 'unknown',
      assignedRoles: c.assignedRoles || [],
      lbPosition: c.lbPosition ?? 999
    };
    if (base.type === 'legacy') {
      return { ...base, managementUrl: c.managementUrl || '', workloadUrl: c.workloadUrl || '' };
    }
    return {
      ...base,
      api: c.api,
      user: c.user,
      consoleUrl: c.consoleUrl || '',
      platform: c.platform || null,
      version: c.version || null,
      stsEnabled: c.stsEnabled || false,
      oidcIssuer: c.oidcIssuer || '',
      hasCertManager: c.hasCertManager || false,
      scanResult: c.scanResult || null,
      lastScan: c.lastScan || null,
      nodes: c.nodes || [],
      pipelineStatus: c.pipelineStatus || null,
      hasPxCredentials: !!(dashboardConfig.pxCredentials?.[name])
    };
  }).sort((a, b) => a.lbPosition - b.lbPosition);
}

function nextLbPosition() {
  const positions = Object.values(clusters)
    .map(c => c.lbPosition)
    .filter(p => p != null);
  return positions.length ? Math.max(...positions) + 1 : 1;
}

async function addCluster(name, data) {
  if (clusters[name]) throw new Error(`Cluster "${name}" already exists`);
  const type = data.type || 'openshift';

  if (type === 'legacy') {
    if (hasLegacyCluster()) throw new Error('A Legacy Infra cluster already exists');
    clusters[name] = {
      type: 'legacy',
      managementUrl: data.managementUrl,
      workloadUrl: data.workloadUrl,
      user: data.user,
      password: data.password,
      connectionStatus: 'unknown',
      lbPosition: 0
    };
    await saveClusters();
    return { name, type: 'legacy' };
  }

  clusters[name] = {
    type: 'openshift',
    api: data.api,
    user: data.user,
    password: data.password,
    connectionStatus: 'unknown',
    lbPosition: nextLbPosition()
  };
  try {
    const info = await testCluster(name);
    clusters[name].connectionStatus = 'connected';
    clusters[name].version = info.version;
    clusters[name].platform = info.platform;
    clusters[name].nodes = info.nodes;
    clusters[name].stsEnabled = info.stsEnabled || false;
    clusters[name].oidcIssuer = info.oidcIssuer || '';
    clusters[name].hasCertManager = info.hasCertManager || false;
    if (info.consoleUrl) clusters[name].consoleUrl = info.consoleUrl;
    await saveClusters();
    return { name, ...info };
  } catch (e) {
    clusters[name].connectionStatus = 'error';
    clusters[name].connectionError = e.message;
    await saveClusters();
    return { name, connected: false, error: e.message };
  }
}

async function updateCluster(name, updates) {
  if (!clusters[name]) throw new Error(`Cluster "${name}" not found`);
  const isLegacy = (clusters[name].type || 'openshift') === 'legacy';
  if (isLegacy) {
    if (updates.managementUrl) clusters[name].managementUrl = updates.managementUrl;
    if (updates.workloadUrl) clusters[name].workloadUrl = updates.workloadUrl;
  } else {
    if (updates.api) clusters[name].api = updates.api;
  }
  if (updates.user) clusters[name].user = updates.user;
  if (updates.password) clusters[name].password = updates.password;
  clearToken(name);
  await saveClusters();
  return { name, updated: true };
}

async function removeCluster(name) {
  if (!clusters[name]) throw new Error(`Cluster "${name}" not found`);
  delete clusters[name];
  clearToken(name);
  const clusterYamlDir = path.join(YAML_DIR, name);
  if (fs.existsSync(clusterYamlDir)) {
    fs.rmSync(clusterYamlDir, { recursive: true, force: true });
  }
  await saveClusters();
}

function getCluster(name) {
  return clusters[name] || null;
}

async function setClusterScanResult(name, scanResult) {
  if (clusters[name]) {
    clusters[name].scanResult = scanResult;
    clusters[name].lastScan = new Date().toISOString();
    clusters[name].connectionStatus = 'connected';
    await saveClusters();
  }
}

async function setClusterConnectionStatus(name, status) {
  if (clusters[name]) {
    clusters[name].connectionStatus = status;
    await saveClusters();
  }
}

async function updateClusterTestResult(name, info) {
  if (clusters[name]) {
    clusters[name].connectionStatus = 'connected';
    clusters[name].nodes = info.nodes;
    clusters[name].version = info.version;
    clusters[name].platform = info.platform;
    clusters[name].stsEnabled = info.stsEnabled || false;
    clusters[name].oidcIssuer = info.oidcIssuer || '';
    clusters[name].hasCertManager = info.hasCertManager || false;
    if (info.consoleUrl) clusters[name].consoleUrl = info.consoleUrl;
    await saveClusters();
  }
}

async function addClusterRole(name, role) {
  if (clusters[name]) {
    if (!clusters[name].assignedRoles) clusters[name].assignedRoles = [];
    if (!clusters[name].assignedRoles.includes(role)) {
      clusters[name].assignedRoles.push(role);
    }
    if (role === 'acm') clusters[name].excludeFromLb = true;
    await saveClusters();
  }
}

async function removeClusterRole(name, role) {
  if (clusters[name] && clusters[name].assignedRoles) {
    clusters[name].assignedRoles = clusters[name].assignedRoles.filter(r => r !== role);
    if (role === 'acm') delete clusters[name].excludeFromLb;
    await saveClusters();
  }
}

async function setClusterPipelineStatus(name, pipelineStatus) {
  if (clusters[name]) {
    clusters[name].pipelineStatus = pipelineStatus;
    await saveClusters();
  }
}

async function setLicenseApplied(name, applied) {
  if (clusters[name]) {
    clusters[name].licenseApplied = applied;
    await saveClusters();
  }
}

async function reorderClusters(orderedNames) {
  let pos = 0;
  for (const name of orderedNames) {
    if (clusters[name]) {
      if ((clusters[name].type || 'openshift') === 'legacy') {
        clusters[name].lbPosition = 0;
      } else {
        clusters[name].lbPosition = ++pos;
      }
    }
  }
  await saveClusters();
}

function hasLegacyCluster() {
  return Object.values(clusters).some(c => c.type === 'legacy');
}

function getLegacyCluster() {
  for (const [name, c] of Object.entries(clusters)) {
    if (c.type === 'legacy') {
      const host = (c.managementUrl || '').replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
      return {
        name,
        managementUrl: c.managementUrl,
        sdkUrl: `https://${host}/sdk`,
        host,
        user: c.user,
        passwordB64: Buffer.from(c.password || '').toString('base64'),
        userB64: Buffer.from(c.user || '').toString('base64'),
      };
    }
  }
  return null;
}

function hasBuildRole() {
  return Object.values(clusters).some(c =>
    (c.assignedRoles || []).includes('build')
  );
}

function hasAcmRole() {
  return Object.values(clusters).some(c =>
    (c.assignedRoles || []).includes('acm')
  );
}

function isLegacyCluster(name) {
  return clusters[name] && (clusters[name].type || 'openshift') === 'legacy';
}

function hasPortworxRole() {
  return Object.values(clusters).some(c =>
    (c.assignedRoles || []).includes('portworx')
  );
}

async function loadConfig() {
  if (!inCluster()) {
    const file = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(file)) {
      dashboardConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return;
  }
  const k8s = localK8sClient();
  try {
    const resp = await k8sFetch(`${k8s.base}/api/v1/namespaces/${NAMESPACE}/secrets/${CONFIG_SECRET}`, {
      headers: { Authorization: `Bearer ${k8s.token}` },
      ca: k8s.ca
    });
    if (resp.ok) {
      const secret = await resp.json();
      if (secret.data && secret.data.config) {
        dashboardConfig = JSON.parse(Buffer.from(secret.data.config, 'base64').toString());
      }
    }
  } catch (e) {
    console.error('Failed to load config from Secret:', e.message);
  }
}

async function saveConfig() {
  if (!inCluster()) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(dashboardConfig, null, 2));
    return;
  }
  const k8s = localK8sClient();
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: CONFIG_SECRET, namespace: NAMESPACE },
    data: { config: Buffer.from(JSON.stringify(dashboardConfig)).toString('base64') }
  };
  try {
    let resp = await k8sFetch(`${k8s.base}/api/v1/namespaces/${NAMESPACE}/secrets/${CONFIG_SECRET}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${k8s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ca: k8s.ca
    });
    if (resp.status === 404) {
      resp = await k8sFetch(`${k8s.base}/api/v1/namespaces/${NAMESPACE}/secrets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${k8s.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ca: k8s.ca
      });
    }
    if (!resp.ok) {
      const text = await resp.text();
      console.error('Failed to save config Secret:', resp.status, text);
    }
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

function getConfig() {
  return { ...dashboardConfig };
}

async function setConfig(updates) {
  Object.assign(dashboardConfig, updates);
  await saveConfig();
}

function getPxCredentials(clusterName) {
  const creds = dashboardConfig.pxCredentials || {};
  return creds[clusterName] || null;
}

async function setPxCredentials(clusterName, creds) {
  if (!dashboardConfig.pxCredentials) dashboardConfig.pxCredentials = {};
  dashboardConfig.pxCredentials[clusterName] = creds;
  await saveConfig();
}

module.exports = {
  loadClusters,
  listClusters,
  addCluster,
  updateCluster,
  removeCluster,
  getCluster,
  testCluster,
  getToken,
  clearToken,
  apiRequest,
  setClusterScanResult,
  setClusterConnectionStatus,
  updateClusterTestResult,
  addClusterRole,
  removeClusterRole,
  setClusterPipelineStatus,
  setLicenseApplied,
  reorderClusters,
  hasLegacyCluster,
  getLegacyCluster,
  hasBuildRole,
  hasAcmRole,
  hasPortworxRole,
  isLegacyCluster,
  loadConfig,
  saveConfig,
  getConfig,
  setConfig,
  getPxCredentials,
  setPxCredentials,
  k8sFetch,
  localK8sClient,
  inCluster,
  NAMESPACE,
  YAML_DIR
};
