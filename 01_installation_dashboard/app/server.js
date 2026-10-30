const fs = require('fs');
const express = require('express');
const path = require('path');
const config = require('./lib/config');
const cluster = require('./lib/cluster');
const templates = require('./lib/templates');
const operators = require('./lib/operators');
const roles = require('./lib/roles');
const pipelines = require('./lib/pipelines');
const storagecluster = require('./lib/storagecluster');
const yaml = require('js-yaml');

const pipelineCfg = config.get().pipelines || {};

function yamlToJson(yamlStr) {
  return JSON.stringify(yaml.load(yamlStr));
}

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/api/events')) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store');
  }
}));

const sseClients = new Set();

function emitEvent(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/operators', (req, res) => {
  const ops = Object.entries(templates.OPERATORS).map(([key, op]) => ({
    key,
    name: op.name,
    namespace: op.namespace,
    available: op.manifests !== null
  }));
  res.json(ops);
});

app.get('/api/clusters', (req, res) => {
  res.json(cluster.listClusters());
});

app.post('/api/clusters', async (req, res) => {
  try {
    const { name, type, api, managementUrl, workloadUrl, user, password } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    if (type === 'legacy') {
      if (!managementUrl || !workloadUrl || !user || !password) {
        return res.status(400).json({ error: 'managementUrl, workloadUrl, user, and password are required for Legacy Infra' });
      }
      emitEvent({ type: 'cluster', action: 'adding', name });
      const result = await cluster.addCluster(name, { type: 'legacy', managementUrl, workloadUrl, user, password });
      emitEvent({ type: 'cluster', action: 'added', name });
      return res.json(result);
    }

    if (!api || !user || !password) {
      return res.status(400).json({ error: 'api, user, and password are required' });
    }
    emitEvent({ type: 'cluster', action: 'adding', name });
    const result = await cluster.addCluster(name, { api, user, password });
    emitEvent({ type: 'cluster', action: 'added', name, connected: result.connected !== false });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/clusters/reorder', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of cluster names' });
    await cluster.reorderClusters(order);
    emitEvent({ type: 'cluster', action: 'reordered' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/lb-route', async (req, res) => {
  let url = '';
  try {
    if (cluster.inCluster()) {
      const k8s = cluster.localK8sClient();
      const resp = await cluster.k8sFetch(
        `${k8s.base}/apis/config.openshift.io/v1/ingresses/cluster`,
        { headers: { Authorization: `Bearer ${k8s.token}` }, ca: k8s.ca }
      );
      if (resp.ok) {
        const ingress = await resp.json();
        const appsDomain = ingress.spec?.domain || '';
        if (appsDomain) url = `https://${pipelineCfg.lbRoutePrefix || 'loadbalancer'}.${appsDomain}`;
      }
    }
  } catch (e) { /* cluster not available */ }
  res.json({ url });
});

app.get('/api/artifacts-route', async (req, res) => {
  let url = '';
  try {
    if (cluster.inCluster()) {
      const k8s = cluster.localK8sClient();
      const ns = pipelines.NAMESPACE;
      const resp = await cluster.k8sFetch(
        `${k8s.base}/apis/route.openshift.io/v1/namespaces/${ns}/routes/artifacts`,
        { headers: { Authorization: `Bearer ${k8s.token}` }, ca: k8s.ca }
      );
      if (resp.ok) {
        const route = await resp.json();
        const host = route.spec?.host || '';
        if (host) url = `https://${host}`;
      }
    }
  } catch (e) { /* route not available */ }
  res.json({ url });
});

app.get('/api/lb-trigger', async (req, res) => {
  const enabled = cluster.hasBuildRole();
  let url = '';
  try {
    if (cluster.inCluster()) {
      const k8s = cluster.localK8sClient();
      const resp = await cluster.k8sFetch(
        `${k8s.base}/apis/config.openshift.io/v1/ingresses/cluster`,
        { headers: { Authorization: `Bearer ${k8s.token}` }, ca: k8s.ca }
      );
      if (resp.ok) {
        const ingress = await resp.json();
        const appsDomain = ingress.spec?.domain || '';
        url = `https://${pipelineCfg.lbEventListener || 'el-lb-build-listener'}-${cluster.NAMESPACE}.${appsDomain}/`;
      }
    }
  } catch (e) {
    console.error('Failed to discover lb-trigger URL:', e.message);
  }
  res.json({ url, enabled });
});

app.post('/api/lb-trigger', async (req, res) => {
  const enabled = cluster.hasBuildRole();
  if (!enabled) return res.status(400).json({ error: 'No cluster has the Build role assigned' });

  let url = '';
  try {
    if (cluster.inCluster()) {
      const k8s = cluster.localK8sClient();
      const ingressResp = await cluster.k8sFetch(
        `${k8s.base}/apis/config.openshift.io/v1/ingresses/cluster`,
        { headers: { Authorization: `Bearer ${k8s.token}` }, ca: k8s.ca }
      );
      if (ingressResp.ok) {
        const ingress = await ingressResp.json();
        const appsDomain = ingress.spec?.domain || '';
        url = `https://${pipelineCfg.lbEventListener || 'el-lb-build-listener'}-${cluster.NAMESPACE}.${appsDomain}/`;
      }
    }
  } catch (e) {
    return res.status(500).json({ error: `Failed to discover trigger URL: ${e.message}` });
  }

  if (!url) return res.status(500).json({ error: 'Could not determine EventListener URL' });

  try {
    const triggerResp = await cluster.k8sFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const text = await triggerResp.text();
    emitEvent({ type: 'pipelines', action: 'Loadbalancer build triggered', status: 'info' });
    res.json({ ok: true, status: triggerResp.status, response: text });
  } catch (e) {
    res.status(500).json({ error: `Trigger request failed: ${e.message}` });
  }
});

app.post('/api/acm-onboard', async (req, res) => {
  const enabled = cluster.hasAcmRole();
  if (!enabled) return res.status(400).json({ error: 'No cluster has the ACM role assigned' });

  let url = '';
  try {
    if (cluster.inCluster()) {
      const k8s = cluster.localK8sClient();
      const ingressResp = await cluster.k8sFetch(
        `${k8s.base}/apis/config.openshift.io/v1/ingresses/cluster`,
        { headers: { Authorization: `Bearer ${k8s.token}` }, ca: k8s.ca }
      );
      if (ingressResp.ok) {
        const ingress = await ingressResp.json();
        const appsDomain = ingress.spec?.domain || '';
        url = `https://${pipelineCfg.acmEventListener || 'el-acm-onboard-listener'}-${cluster.NAMESPACE}.${appsDomain}/`;
      }
    }
  } catch (e) {
    return res.status(500).json({ error: `Failed to discover trigger URL: ${e.message}` });
  }

  if (!url) return res.status(500).json({ error: 'Could not determine EventListener URL' });

  try {
    const triggerResp = await cluster.k8sFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const text = await triggerResp.text();
    emitEvent({ type: 'acm', action: 'ACM cluster onboarding triggered', status: 'info' });
    res.json({ ok: true, status: triggerResp.status, response: text });
  } catch (e) {
    res.status(500).json({ error: `Trigger request failed: ${e.message}` });
  }
});

app.get('/api/acm-onboard/status', async (req, res) => {
  if (!cluster.inCluster()) return res.json({ status: 'unavailable' });

  try {
    const k8s = cluster.localK8sClient();
    const cmResp = await cluster.k8sFetch(
      `${k8s.base}/api/v1/namespaces/${cluster.NAMESPACE}/configmaps/${pipelineCfg.acmStatusConfigMap || 'acm-onboard-status'}`,
      { headers: { Authorization: `Bearer ${k8s.token}` }, ca: k8s.ca }
    );
    if (!cmResp.ok) return res.json({ status: 'idle' });
    const cm = await cmResp.json();
    const statusData = cm.data?.status || '{}';
    res.json(JSON.parse(statusData));
  } catch (e) {
    res.json({ status: 'idle' });
  }
});

app.put('/api/clusters/:name', async (req, res) => {
  try {
    const result = await cluster.updateCluster(req.params.name, req.body);
    emitEvent({ type: 'cluster', action: 'updated', name: req.params.name });
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.delete('/api/clusters/:name', async (req, res) => {
  try {
    await cluster.removeCluster(req.params.name);
    emitEvent({ type: 'cluster', action: 'removed', name: req.params.name });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/test', async (req, res) => {
  if (cluster.isLegacyCluster(req.params.name)) {
    return res.status(400).json({ error: 'Not supported for Legacy Infra clusters' });
  }
  try {
    const info = await cluster.testCluster(req.params.name);
    await cluster.updateClusterTestResult(req.params.name, info);
    res.json(info);
  } catch (e) {
    console.error(`Test cluster ${req.params.name}:`, e);
    await cluster.setClusterConnectionStatus(req.params.name, 'error');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/scan', async (req, res) => {
  if (cluster.isLegacyCluster(req.params.name)) {
    return res.status(400).json({ error: 'Not supported for Legacy Infra clusters' });
  }
  try {
    emitEvent({ type: 'scan', cluster: req.params.name, status: 'started' });

    const info = await cluster.testCluster(req.params.name);
    await cluster.updateClusterTestResult(req.params.name, info);

    const results = await operators.scanCluster(req.params.name, emitEvent);
    const c = cluster.getCluster(req.params.name);
    if (c && (c.assignedRoles || []).includes('build')) {
      const ps = await pipelines.checkPipelineStatus(req.params.name);
      await cluster.setClusterPipelineStatus(req.params.name, ps);
    }

    emitEvent({ type: 'scan', cluster: req.params.name, status: 'complete' });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/generate/:operator', (req, res) => {
  try {
    const files = templates.generateAndSave(req.params.name, req.params.operator);
    emitEvent({
      type: 'generate', cluster: req.params.name,
      operator: req.params.operator, files
    });
    res.json({ files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/clusters/:name/yaml/:operator', (req, res) => {
  try {
    const files = templates.listYamlFiles(req.params.name, req.params.operator);
    res.json({ files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/clusters/:name/yaml/:operator/:file', (req, res) => {
  try {
    const content = templates.readYamlFile(req.params.name, req.params.operator, req.params.file);
    res.json({ content });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.put('/api/clusters/:name/yaml/:operator/:file', (req, res) => {
  try {
    templates.writeYamlFile(req.params.name, req.params.operator, req.params.file, req.body.content);
    emitEvent({
      type: 'yaml_edited', cluster: req.params.name,
      operator: req.params.operator, file: req.params.file
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/install/:operator', async (req, res) => {
  try {
    emitEvent({
      type: 'install', cluster: req.params.name,
      operator: req.params.operator, status: 'started'
    });
    const results = await operators.installOperator(req.params.name, req.params.operator, emitEvent);
    emitEvent({
      type: 'install', cluster: req.params.name,
      operator: req.params.operator, status: 'complete', results
    });
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/roles', (req, res) => {
  const cfg = config.get();
  const list = Object.entries(roles.ROLES).map(([key, r]) => ({
    key, name: r.name, description: r.description, operators: r.operators, extras: r.extras || [],
    operatorResources: Object.fromEntries(
      r.operators.map(op => [op, {
        cpu: cfg.operators[op]?.resources?.cpu || 0,
        memory: cfg.operators[op]?.resources?.memory || 0
      }])
    )
  }));
  res.json(list);
});

app.get('/api/clusters/:name/capacity', (req, res) => {
  const capacity = roles.getClusterCapacity(req.params.name);
  if (!capacity) {
    return res.status(400).json({ error: 'No node data. Run Test first.' });
  }
  res.json(capacity);
});

app.post('/api/clusters/:name/roles/:role', async (req, res) => {
  if (cluster.isLegacyCluster(req.params.name)) {
    return res.status(400).json({ error: 'Not supported for Legacy Infra clusters' });
  }
  try {
    const check = roles.canAssignRole(req.params.name, req.params.role);
    if (!check.ok) {
      return res.status(400).json({ error: check.message, capacity: check.capacity });
    }
    if (check.alreadyAssigned) {
      return res.json({ status: 'already_assigned', message: check.message });
    }

    const role = roles.ROLES[req.params.role];
    const currentOps = roles.getRoleOperators(cluster.getCluster(req.params.name)?.assignedRoles || []);
    for (const op of role.operators) {
      if (currentOps.includes(op)) continue;
      if (op === 'mtv' && role.operators.includes('virt')) continue;
      const opCheck = operators.OPERATOR_CHECKS[op];
      if (opCheck?.checkPrereqs) {
        const prereq = await opCheck.checkPrereqs(req.params.name);
        if (!prereq.ok) {
          return res.status(400).json({ error: prereq.message });
        }
      }
    }

    res.json({ status: 'installing' });

    // Run installation in background — progress via SSE
    (async () => {
      try {
        emitEvent({
          type: 'role', cluster: req.params.name,
          role: req.params.role, status: 'started',
          action: `Assigning role ${roles.ROLES[req.params.role].name}`
        });

        const allResults = {};
        const failedOperators = [];
        const role = roles.ROLES[req.params.role];
        const hubManaged = role.hubManaged || [];
        for (const op of role.operators) {
          if (hubManaged.includes(op)) {
            allResults[op] = [{ status: 'applied', message: 'Installed by ACM hub' }];
            emitEvent({
              type: 'install', cluster: req.params.name, operator: op,
              action: `${templates.OPERATORS[op]?.name || op} — installed by ACM hub`, status: 'info'
            });
            continue;
          }
          if (templates.OPERATORS[op]?.manifests === null) {
            allResults[op] = [{ status: 'skipped', message: 'Not yet available' }];
            continue;
          }
          emitEvent({
            type: 'install', cluster: req.params.name,
            operator: op, role: req.params.role,
            action: `Installing ${templates.OPERATORS[op]?.name || op}...`, status: 'info'
          });
          try {
            const results = await operators.installOperator(req.params.name, op, emitEvent);
            allResults[op] = results;
            if (results.some(r => r.status === 'error')) {
              failedOperators.push(op);
            }
          } catch (e) {
            allResults[op] = [{ status: 'error', error: e.message }];
            failedOperators.push(op);
          }
        }

        if (failedOperators.length > 0) {
          emitEvent({
            type: 'role', cluster: req.params.name,
            role: req.params.role, status: 'failed',
            action: `Role assignment failed: ${failedOperators.join(', ')} did not install`
          });
          return;
        }

        await cluster.addClusterRole(req.params.name, req.params.role);

        emitEvent({
          type: 'role', cluster: req.params.name,
          role: req.params.role, status: 'complete'
        });

        if (req.params.role === 'acm') {
          try {
            await cluster.apiRequest(req.params.name,
              '/api/v1/namespaces/multicluster-engine/configmaps/flightctl-discovery',
              { method: 'DELETE' });
            emitEvent({ type: 'role', cluster: req.params.name, action: 'FlightCtl discovery configmap removed', status: 'info' });
          } catch (e) { /* may not exist yet */ }
        }

        if (req.params.role === 'build') {
          await pipelines.deployPipelines(req.params.name, emitEvent);
          const ps = await pipelines.checkPipelineStatus(req.params.name);
          await cluster.setClusterPipelineStatus(req.params.name, ps);
        }

        if (req.params.role === 'mtv') {
          const buildCluster = cluster.listClusters().find(c => (c.assignedRoles || []).includes('build'));
          if (buildCluster) {
            const pipelineName = 'mtv-target-routes';
            const runName = `${pipelineName}-run-${Date.now().toString(36)}`;
            const ns = pipelines.NAMESPACE;
            const body = JSON.stringify({
              apiVersion: 'tekton.dev/v1',
              kind: 'PipelineRun',
              metadata: { name: runName, namespace: ns, labels: { 'tekton.dev/pipeline': pipelineName } },
              spec: { pipelineRef: { name: pipelineName }, params: [{ name: 'namespace', value: ns }] }
            });
            const resp = await cluster.apiRequest(buildCluster.name,
              `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns`, { method: 'POST', body });
            if (resp.ok) {
              emitEvent({ type: 'role', cluster: req.params.name, action: 'MTV target routes pipeline triggered', status: 'info' });
            } else {
              emitEvent({ type: 'role', cluster: req.params.name, action: 'MTV target routes pipeline trigger failed', status: 'warning' });
            }
          }
        }
        emitEvent({ type: 'scan', cluster: req.params.name, status: 'started' });
        await operators.scanCluster(req.params.name, emitEvent);
        emitEvent({ type: 'scan', cluster: req.params.name, status: 'complete' });
      } catch (e) {
        console.error('Background install failed:', e.message);
        emitEvent({
          type: 'role', cluster: req.params.name,
          role: req.params.role, status: 'failed',
          action: `Install error: ${e.message}`
        });
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/roles/:role/reapply', async (req, res) => {
  if (cluster.isLegacyCluster(req.params.name)) {
    return res.status(400).json({ error: 'Not supported for Legacy Infra clusters' });
  }
  try {
    const role = roles.ROLES[req.params.role];
    if (!role) return res.status(404).json({ error: 'Unknown role' });

    const c = cluster.getCluster(req.params.name);
    if (!c || !(c.assignedRoles || []).includes(req.params.role)) {
      return res.status(400).json({ error: 'Role is not assigned' });
    }

    res.json({ status: 'reapplying' });

    const clusterName = req.params.name;
    const roleKey = req.params.role;

    (async () => {
      try {
        console.log(`Re-apply started: role=${roleKey} cluster=${clusterName} operators=${role.operators}`);
        emitEvent({
          type: 'role', cluster: clusterName,
          role: roleKey, status: 'started',
          action: `Re-applying role ${role.name}`
        });

        const failedOperators = [];
        const hubManaged = role.hubManaged || [];
        for (const op of role.operators) {
          console.log(`Re-apply: processing operator ${op}`);
          if (hubManaged.includes(op)) {
            console.log(`Re-apply: skipping ${op} (installed by ACM hub)`);
            continue;
          }
          if (templates.OPERATORS[op]?.manifests === null) {
            console.log(`Re-apply: skipping ${op} (no manifests)`);
            continue;
          }
          console.log(`Re-apply: about to emit event for ${op}`);
          emitEvent({
            type: 'install', cluster: clusterName,
            operator: op, role: roleKey,
            action: `Re-applying ${templates.OPERATORS[op]?.name || op}...`, status: 'info'
          });
          console.log(`Re-apply: calling installOperator for ${op}`);
          try {
            const results = await operators.installOperator(clusterName, op, emitEvent);
            console.log(`Re-apply: installOperator ${op} done, results:`, results.map(r => `${r.name}:${r.status}`).join(', '));
            if (results.some(r => r.status === 'error')) failedOperators.push(op);
          } catch (e) {
            console.error(`Re-apply operator ${op} error:`, e);
            failedOperators.push(op);
          }
        }

        if (failedOperators.length > 0) {
          emitEvent({
            type: 'role', cluster: clusterName,
            role: roleKey, status: 'failed',
            action: `Re-apply failed: ${failedOperators.join(', ')}`
          });
          return;
        }

        emitEvent({
          type: 'role', cluster: clusterName,
          role: roleKey, status: 'complete',
          action: `Role ${role.name} re-applied`
        });

        if (roleKey === 'acm') {
          try {
            await cluster.apiRequest(clusterName,
              '/api/v1/namespaces/multicluster-engine/configmaps/flightctl-discovery',
              { method: 'DELETE' });
            emitEvent({ type: 'role', cluster: clusterName, action: 'FlightCtl discovery configmap removed', status: 'info' });
          } catch (e) { /* may not exist */ }
        }

        if (roleKey === 'build') {
          await pipelines.deployPipelines(clusterName, emitEvent);
          const ps = await pipelines.checkPipelineStatus(clusterName);
          await cluster.setClusterPipelineStatus(clusterName, ps);
        }

        if (roleKey === 'mtv') {
          const buildCluster = cluster.listClusters().find(c => (c.assignedRoles || []).includes('build'));
          if (buildCluster) {
            const pipelineName = 'mtv-target-routes';
            const runName = `${pipelineName}-run-${Date.now().toString(36)}`;
            const ns = pipelines.NAMESPACE;
            const body = JSON.stringify({
              apiVersion: 'tekton.dev/v1',
              kind: 'PipelineRun',
              metadata: { name: runName, namespace: ns, labels: { 'tekton.dev/pipeline': pipelineName } },
              spec: { pipelineRef: { name: pipelineName }, params: [{ name: 'namespace', value: ns }] }
            });
            const resp = await cluster.apiRequest(buildCluster.name,
              `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns`, { method: 'POST', body });
            if (resp.ok) {
              emitEvent({ type: 'role', cluster: clusterName, action: 'MTV target routes pipeline triggered', status: 'info' });
            } else {
              emitEvent({ type: 'role', cluster: clusterName, action: 'MTV target routes pipeline trigger failed', status: 'warning' });
            }
          }
        }
        emitEvent({ type: 'scan', cluster: clusterName, status: 'started' });
        await operators.scanCluster(clusterName, emitEvent);
        emitEvent({ type: 'scan', cluster: clusterName, status: 'complete' });
      } catch (e) {
        console.error('Background re-apply failed:', e);
        emitEvent({
          type: 'role', cluster: clusterName,
          role: roleKey, status: 'failed',
          action: `Re-apply error: ${e.message}`
        });
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clusters/:name/roles/:role/preview-unassign', (req, res) => {
  const c = cluster.getCluster(req.params.name);
  if (!c) return res.status(404).json({ error: 'Cluster not found' });
  const role = roles.ROLES[req.params.role];
  if (!role) return res.status(400).json({ error: 'Unknown role' });

  const remainingRoles = (c.assignedRoles || []).filter(r => r !== req.params.role);
  const remainingOps = roles.getRoleOperators(remainingRoles);
  const hubManaged = role.hubManaged || [];
  const orphanedOps = role.operators.filter(op => !remainingOps.includes(op) && !hubManaged.includes(op));
  const sharedOps = role.operators.filter(op => remainingOps.includes(op) || hubManaged.includes(op));

  const warnings = [];
  if (orphanedOps.includes('virt'))
    warnings.push('OpenShift Virtualization will be removed. Any running VMs on this cluster will be deleted.');
  if (orphanedOps.includes('pipelines'))
    warnings.push('OpenShift Pipelines will be removed. Any running pipeline runs will be cancelled.');
  if (orphanedOps.includes('mtv'))
    warnings.push('MTV will be removed. Any in-progress VM migrations will be cancelled.');
  if (orphanedOps.includes('acm'))
    warnings.push('ACM will be removed. Managed cluster connections from this hub will be lost. Virt and MTV (managed by ACM) will also be removed.');
  if (orphanedOps.includes('storage'))
    warnings.push('Portworx will be removed. All Portworx-managed volumes and DR pairs on this cluster will be affected.');

  res.json({
    role: req.params.role,
    roleName: role.name,
    willUninstall: orphanedOps.map(op => templates.OPERATORS[op]?.name || op),
    keptByOtherRoles: sharedOps.map(op => templates.OPERATORS[op]?.name || op),
    warnings
  });
});

app.delete('/api/clusters/:name/roles/:role', async (req, res) => {
  const c = cluster.getCluster(req.params.name);
  if (!c) return res.status(404).json({ error: 'Cluster not found' });
  const role = roles.ROLES[req.params.role];
  if (!role) return res.status(400).json({ error: 'Unknown role' });

  const remainingRoles = (c.assignedRoles || []).filter(r => r !== req.params.role);
  const remainingOps = roles.getRoleOperators(remainingRoles);
  const hubManaged = role.hubManaged || [];
  const orphanedOps = role.operators.filter(op => !remainingOps.includes(op) && !hubManaged.includes(op));

  // Remove role immediately and respond fast (uninstall runs in background via SSE)
  await cluster.removeClusterRole(req.params.name, req.params.role);
  res.json({ ok: true, uninstalled: orphanedOps });

  // Background: uninstall orphaned operators and scan
  (async () => {
    try {
      if (req.params.role === 'build') {
        await pipelines.removePipelines(req.params.name, emitEvent);
        await cluster.setClusterPipelineStatus(req.params.name, { status: 'not_deployed', deployed: 0, total: 0 });
      }

      if (orphanedOps.length > 0) {
        emitEvent({
          type: 'role', cluster: req.params.name,
          role: req.params.role, status: 'uninstalling',
          action: `Unassigning role ${role.name}, uninstalling: ${orphanedOps.join(', ')}`
        });
        for (const op of orphanedOps) {
          await operators.uninstallOperator(req.params.name, op, emitEvent);
          templates.deleteYamlFiles(req.params.name, op);
        }
      }

      emitEvent({
        type: 'role', cluster: req.params.name,
        role: req.params.role, status: 'removed'
      });

      emitEvent({ type: 'scan', cluster: req.params.name, status: 'started' });
      await operators.scanCluster(req.params.name, emitEvent);
      emitEvent({ type: 'scan', cluster: req.params.name, status: 'complete' });
    } catch (e) {
      console.error('Background uninstall failed:', e.message);
      emitEvent({
        type: 'role', cluster: req.params.name,
        role: req.params.role, status: 'error',
        action: `Uninstall error: ${e.message}`
      });
    }
  })();
});

app.get('/api/summary', (req, res) => {
  const allClusters = cluster.listClusters();

  const ocpClusters = allClusters.filter(c => (c.type || 'openshift') !== 'legacy');
  const connectivity = { connected: 0, error: 0, unknown: 0 };
  for (const c of ocpClusters) {
    const bucket = connectivity[c.connectionStatus] !== undefined ? c.connectionStatus : 'unknown';
    connectivity[bucket]++;
  }

  const roleSummary = {};
  for (const [key, role] of Object.entries(roles.ROLES)) {
    roleSummary[key] = { name: role.name, assigned: [], unassigned: [] };
    for (const c of allClusters) {
      if ((c.assignedRoles || []).includes(key)) {
        roleSummary[key].assigned.push(c.name);
      } else {
        roleSummary[key].unassigned.push(c.name);
      }
    }
  }

  const opSummary = {};
  for (const opKey of Object.keys(templates.OPERATORS)) {
    opSummary[opKey] = { name: templates.OPERATORS[opKey].name, installed: 0, not_installed: 0, installing: 0, error: 0, unknown: 0, placeholder: 0 };
    for (const c of allClusters) {
      const scan = c.scanResult || {};
      const opStatus = scan[opKey]?.status || 'unknown';
      if (opSummary[opKey][opStatus] !== undefined) {
        opSummary[opKey][opStatus]++;
      } else {
        opSummary[opKey].unknown++;
      }
    }
  }

  const pipelineSummary = { deployed: 0, not_deployed: 0, partial: 0, error: 0, not_applicable: 0 };
  for (const c of allClusters) {
    if (!(c.assignedRoles || []).includes('build')) {
      pipelineSummary.not_applicable++;
    } else {
      const ps = c.pipelineStatus?.status || 'not_deployed';
      if (pipelineSummary[ps] !== undefined) pipelineSummary[ps]++;
      else pipelineSummary.not_deployed++;
    }
  }

  const nextSteps = [];
  const errorClusters = allClusters.filter(c => c.connectionStatus === 'error');
  if (errorClusters.length > 0) {
    nextSteps.push({ priority: 'high', message: `${errorClusters.length} cluster(s) have connection errors: ${errorClusters.map(c => c.name).join(', ')}. Run Test to reconnect.` });
  }
  const unscanned = allClusters.filter(c => !c.scanResult && c.connectionStatus === 'connected');
  if (unscanned.length > 0) {
    nextSteps.push({ priority: 'medium', message: `${unscanned.length} connected cluster(s) have not been scanned: ${unscanned.map(c => c.name).join(', ')}. Run Scan to discover installed operators.` });
  }
  for (const [key, rs] of Object.entries(roleSummary)) {
    if (rs.assigned.length === 0 && allClusters.length > 0) {
      nextSteps.push({ priority: 'low', message: `No cluster has the ${rs.name} role assigned.` });
    }
  }

  res.json({
    totalClusters: allClusters.length,
    connectivity,
    roles: roleSummary,
    operators: opSummary,
    pipelines: pipelineSummary,
    clusters: allClusters.map(c => ({
      name: c.name,
      connectionStatus: c.connectionStatus,
      assignedRoles: c.assignedRoles || [],
      scanResult: c.scanResult || null,
      pipelineStatus: c.pipelineStatus || null
    })),
    nextSteps
  });
});

app.get('/api/config/s3', (req, res) => {
  const config = cluster.getConfig();
  const s3 = config.s3 || {};
  res.json({
    bucket: s3.bucket || '',
    region: s3.region || '',
    endpoint: s3.endpoint || '',
    accessKey: s3.accessKey || '',
    hasSecretKey: !!s3.secretKey
  });
});

app.put('/api/config/s3', async (req, res) => {
  const { bucket, region, endpoint, accessKey, secretKey } = req.body;
  if (!bucket || !region || !endpoint || !accessKey) {
    return res.status(400).json({ error: 'Required: bucket, region, endpoint, accessKey' });
  }
  const existing = cluster.getConfig().s3 || {};
  const s3 = { bucket, region, endpoint, accessKey, secretKey: secretKey || existing.secretKey };
  if (!s3.secretKey) {
    return res.status(400).json({ error: 'Secret key is required' });
  }
  await cluster.setConfig({ s3 });
  emitEvent({ type: 'config', action: 'S3 bucket configuration saved', status: 'success' });
  res.json({ ok: true });
});

app.get('/api/config/px-license', (req, res) => {
  const config = cluster.getConfig();
  res.json({ configured: !!config.pxLicenseKey });
});

app.put('/api/config/px-license', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'License key is required' });
  await cluster.setConfig({ pxLicenseKey: key });
  emitEvent({ type: 'config', action: 'Portworx license key saved', status: 'success' });
  res.json({ ok: true });
});

app.get('/api/clusters/:name/px-credentials', async (req, res) => {
  const creds = cluster.getPxCredentials(req.params.name);
  const result = creds ? { ...creds, configured: true } : { configured: false };
  if (result.clientSecret) result.clientSecret = '********';
  if (result.secretKey) result.secretKey = '********';
  if (result.jsonKey) { result.hasJsonKey = true; delete result.jsonKey; }
  try {
    const c = cluster.getCluster(req.params.name);
    let oidcIssuer = c?.oidcIssuer || '';
    if (!oidcIssuer && c?.stsEnabled) {
      try {
        const authResp = await cluster.apiRequest(req.params.name,
          '/apis/config.openshift.io/v1/authentications/cluster');
        if (authResp.ok) {
          const auth = await authResp.json();
          const issuer = auth.spec?.serviceAccountIssuer || '';
          if (issuer && issuer !== 'https://kubernetes.default.svc') {
            oidcIssuer = issuer.replace(/^https?:\/\//, '');
            await cluster.updateClusterTestResult(req.params.name,
              { ...c, oidcIssuer, hasCertManager: c.hasCertManager || false });
          }
        }
      } catch (e) { /* cluster unreachable */ }
    }
    const platformKey = storagecluster.resolvePlatformKey(req.params.name);
    const cfg = config.get();
    const platformCfg = cfg.portworx?.platforms?.[platformKey];
    if (platformCfg?.helpCommand) {
      result.helpCommand = platformCfg.helpCommand
        .replace(/\{\{oidcIssuer\}\}/g, oidcIssuer);
    }
  } catch (e) { /* platform not detected yet */ }
  return res.json(result);
});

app.put('/api/clusters/:name/px-credentials', async (req, res) => {
  const c = cluster.getCluster(req.params.name);
  if (!c) return res.status(404).json({ error: 'Cluster not found' });
  await cluster.setPxCredentials(req.params.name, req.body);
  emitEvent({ type: 'config', action: `Portworx cloud credentials saved for ${req.params.name}`, status: 'success' });
  res.json({ ok: true });
});

app.get('/api/clusters/:name/storagecluster/status', async (req, res) => {
  if (cluster.isLegacyCluster(req.params.name)) {
    return res.status(400).json({ error: 'Not supported for Legacy Infra clusters' });
  }
  try {
    const status = await storagecluster.getStatus(req.params.name);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clusters/:name/storagecluster/spec', (req, res) => {
  try {
    const preview = storagecluster.previewSpec(req.params.name);
    res.json(preview);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/storagecluster', async (req, res) => {
  if (cluster.isLegacyCluster(req.params.name)) {
    return res.status(400).json({ error: 'Not supported for Legacy Infra clusters' });
  }
  const c = cluster.getCluster(req.params.name);
  if (!c) return res.status(404).json({ error: 'Cluster not found' });
  if (!(c.assignedRoles || []).includes('portworx')) {
    return res.status(400).json({ error: 'Portworx role not assigned to this cluster' });
  }

  res.json({ status: 'deploying' });

  (async () => {
    try {
      await storagecluster.deploy(req.params.name, emitEvent);

      const dashConfig = cluster.getConfig();
      if (dashConfig.pxLicenseKey) {
        const buildCluster = cluster.listClusters().find(c => (c.assignedRoles || []).includes('build'));
        if (buildCluster) {
          const pipelineName = pipelineCfg.licenseTask || 'dash-px-license-activate';
          const runName = `${pipelineName}-run-${Date.now().toString(36)}`;
          const ns = pipelines.NAMESPACE;
          const body = JSON.stringify({
            apiVersion: 'tekton.dev/v1',
            kind: 'PipelineRun',
            metadata: { name: runName, namespace: ns, labels: { 'tekton.dev/pipeline': pipelineName } },
            spec: { pipelineRef: { name: pipelineName }, params: [{ name: 'namespace', value: ns }] }
          });
          const resp = await cluster.apiRequest(buildCluster.name,
            `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns`, { method: 'POST', body });
          if (resp.ok) {
            await cluster.setLicenseApplied(req.params.name, true);
            emitEvent({ type: 'storagecluster', cluster: req.params.name, action: 'License activation pipeline triggered', status: 'info' });
          } else {
            emitEvent({ type: 'storagecluster', cluster: req.params.name, action: 'License pipeline trigger failed — apply manually', status: 'warning' });
          }
        }
      }
    } catch (e) {
      console.error('StorageCluster deploy failed:', e.message);
      emitEvent({
        type: 'storagecluster', cluster: req.params.name,
        action: `Deploy failed: ${e.message}`, status: 'error'
      });
    }
  })();
});

app.delete('/api/clusters/:name/storagecluster', async (req, res) => {
  if (cluster.isLegacyCluster(req.params.name)) {
    return res.status(400).json({ error: 'Not supported for Legacy Infra clusters' });
  }
  const c = cluster.getCluster(req.params.name);
  if (!c) return res.status(404).json({ error: 'Cluster not found' });

  res.json({ status: 'deleting' });

  (async () => {
    try {
      await storagecluster.deleteStorageCluster(req.params.name, emitEvent);
    } catch (e) {
      console.error('StorageCluster delete failed:', e.message);
      emitEvent({
        type: 'storagecluster', cluster: req.params.name,
        action: `Delete failed: ${e.message}`, status: 'error'
      });
    }
  })();
});

app.post('/api/px-license/apply', async (req, res) => {
  const dashConfig = cluster.getConfig();
  if (!dashConfig.pxLicenseKey) {
    return res.status(400).json({ error: 'No Portworx license key configured' });
  }
  const buildCluster = cluster.listClusters().find(c => (c.assignedRoles || []).includes('build'));
  if (!buildCluster) {
    return res.status(400).json({ error: 'No build cluster found' });
  }

  try {
    const pipelineName = pipelineCfg.licenseTask || 'dash-px-license-activate';
    const runName = `${pipelineName}-run-${Date.now().toString(36)}`;
    const ns = pipelines.NAMESPACE;
    const body = JSON.stringify({
      apiVersion: 'tekton.dev/v1',
      kind: 'PipelineRun',
      metadata: { name: runName, namespace: ns, labels: { 'tekton.dev/pipeline': pipelineName } },
      spec: { pipelineRef: { name: pipelineName }, params: [{ name: 'namespace', value: ns }] }
    });
    const resp = await cluster.apiRequest(buildCluster.name,
      `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns`, { method: 'POST', body });

    if (resp.ok) {
      const pxClusters = cluster.listClusters().filter(c =>
        (c.assignedRoles || []).includes('portworx') && (c.type || 'openshift') === 'openshift');
      for (const c of pxClusters) {
        await cluster.setLicenseApplied(c.name, true);
      }
      res.json({ status: 'triggered', clusters: pxClusters.map(c => c.name) });
    } else {
      const text = await resp.text();
      res.status(500).json({ error: `Pipeline trigger failed: ${text}` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pipeline Management ──
app.get('/api/clusters/:name/tekton/pipelines', async (req, res) => {
  try {
    const ns = pipelines.NAMESPACE;
    const resp = await cluster.apiRequest(req.params.name,
      `/apis/tekton.dev/v1/namespaces/${ns}/pipelines`);
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to list pipelines' });
    const data = await resp.json();
    const items = (data.items || []).map(p => ({
      name: p.metadata.name,
      taskCount: (p.spec?.tasks || []).length,
      created: p.metadata.creationTimestamp
    }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clusters/:name/tekton/pipelineruns', async (req, res) => {
  try {
    const ns = pipelines.NAMESPACE;
    const resp = await cluster.apiRequest(req.params.name,
      `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns?limit=200`);
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to list pipeline runs' });
    const data = await resp.json();
    const items = (data.items || []).map(pr => {
      const conditions = pr.status?.conditions || [];
      const succeeded = conditions.find(c => c.type === 'Succeeded');
      let status = 'unknown';
      if (succeeded) {
        if (succeeded.status === 'True') status = 'succeeded';
        else if (succeeded.status === 'False') status = 'failed';
        else status = 'running';
      } else if (pr.status?.startTime) {
        status = 'running';
      } else {
        status = 'pending';
      }
      const taskRuns = pr.status?.childReferences || [];
      const taskStatuses = taskRuns.map(tr => {
        const trConditions = tr.conditions || [];
        const trSucceeded = trConditions.find(c => c.type === 'Succeeded');
        let trStatus = 'pending';
        if (trSucceeded) {
          if (trSucceeded.status === 'True') trStatus = 'succeeded';
          else if (trSucceeded.status === 'False') trStatus = 'failed';
          else trStatus = 'running';
        } else if (tr.status?.startTime) {
          trStatus = 'running';
        }
        return { name: tr.pipelineTaskName || tr.name, status: trStatus };
      });
      return {
        name: pr.metadata.name,
        pipeline: pr.spec?.pipelineRef?.name || pr.metadata.labels?.['tekton.dev/pipeline'] || '',
        status,
        reason: succeeded?.reason || '',
        message: succeeded?.message || '',
        startTime: pr.status?.startTime || pr.metadata.creationTimestamp,
        completionTime: pr.status?.completionTime || null,
        tasks: taskStatuses
      };
    });
    items.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/tekton/pipelines/:pipeline/run', async (req, res) => {
  try {
    const ns = pipelines.NAMESPACE;
    const pipelineName = req.params.pipeline;
    const runName = `${pipelineName}-run-${Date.now().toString(36)}`;

    const pipelineResp = await cluster.apiRequest(req.params.name,
      `/apis/tekton.dev/v1/namespaces/${ns}/pipelines/${pipelineName}`);
    let workspaces = [];
    if (pipelineResp.ok) {
      const pipelineDef = await pipelineResp.json();
      const requiredWs = pipelineDef.spec?.workspaces || [];
      const wsPvc = pipelineCfg.workspacePvc || 'wp-build-workspace';
        workspaces = requiredWs.map(ws => {
        if (ws.name === 'shared-workspace') {
          return { name: ws.name, persistentVolumeClaim: { claimName: wsPvc } };
        }
        return { name: ws.name, emptyDir: {} };
      });
    }

    const spec = {
      pipelineRef: { name: pipelineName },
      params: [{ name: 'namespace', value: ns }]
    };
    if (workspaces.length > 0) spec.workspaces = workspaces;

    const body = JSON.stringify({
      apiVersion: 'tekton.dev/v1',
      kind: 'PipelineRun',
      metadata: {
        name: runName,
        namespace: ns,
        labels: { 'tekton.dev/pipeline': pipelineName }
      },
      spec
    });
    const resp = await cluster.apiRequest(req.params.name,
      `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns`,
      { method: 'POST', body });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: text });
    }
    const pr = await resp.json();
    emitEvent({
      type: 'pipelines', cluster: req.params.name,
      action: `Pipeline ${pipelineName} triggered (${runName})`, status: 'info'
    });
    res.json({ name: pr.metadata.name, status: 'created' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clusters/:name/tekton/pipelineruns/:run/cancel', async (req, res) => {
  try {
    const ns = pipelines.NAMESPACE;
    const body = JSON.stringify([{ op: 'add', path: '/spec/status', value: 'CancelledRunFinally' }]);
    const resp = await cluster.apiRequest(req.params.name,
      `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns/${req.params.run}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json-patch+json' }, body });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: text });
    }
    emitEvent({
      type: 'pipelines', cluster: req.params.name,
      action: `Pipeline run ${req.params.run} cancelled`, status: 'info'
    });
    res.json({ status: 'cancelled' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clusters/:name/install/:operator/status', async (req, res) => {
  try {
    const status = await operators.getInstallStatus(req.params.name, req.params.operator, emitEvent);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Demo: Disaster Recovery ──
const drConfig = config.get().portworx?.dr || {};
const DR_NAMESPACE = drConfig.namespace;
const DR_API_GROUP = drConfig.apiGroup;
const DR_API_VERSION = drConfig.apiVersion;

function findDrCluster() {
  const all = cluster.listClusters();
  const acm = all.find(c => (c.assignedRoles || []).includes('acm'));
  if (acm) return acm.name;
  return null;
}

function getPxChain() {
  return cluster.listClusters()
    .filter(c => (c.assignedRoles || []).includes('portworx')
             && !(c.assignedRoles || []).includes('acm'))
    .sort((a, b) => (a.lbPosition || 999) - (b.lbPosition || 999));
}

function buildDrpPairs(pxClusters) {
  const pairs = [];
  for (let i = 0; i < pxClusters.length; i++) {
    const src = pxClusters[i].name;
    const dst = pxClusters[(i + 1) % pxClusters.length].name;
    const num = String(i + 1).padStart(2, '0');
    pairs.push({ name: `${num}-${src}-${dst}`, src, dst });
  }
  return pairs;
}

app.get('/api/demo/drp-status', async (req, res) => {
  const drCluster = findDrCluster();
  if (!drCluster) return res.json({ pairs: [], protectionGroups: [] });

  try {
    const drpResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs`);
    const pgResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups`);

    const drpItems = drpResp.ok ? (await drpResp.json()).items || [] : [];
    const pgItems = pgResp.ok ? (await pgResp.json()).items || [] : [];

    const pairs = drpItems.map(d => {
      const conditions = d.status?.conditions || [];
      const readyCond = conditions.find(c => c.type === 'Ready');
      return {
        name: d.metadata.name,
        ready: readyCond?.status === 'True',
        status: readyCond?.reason || d.status?.schedulerStatus || 'Pending',
        conditions: conditions.map(c => ({ type: c.type, status: c.status }))
      };
    });

    const protectionGroups = pgItems.map(p => ({
      name: p.metadata.name,
      drpRef: p.spec?.disasterRecoveryPairRef || '',
      state: p.status?.protectionState || 'Pending',
      intervalMinutes: p.spec?.replicationSchedulePolicy?.interval?.intervalMinutes || 0
    }));

    res.json({ pairs, protectionGroups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/demo/create-drps', async (req, res) => {
  const drCluster = findDrCluster();
  if (!drCluster) return res.status(400).json({ error: 'No ACM cluster found' });

  const pxClusters = getPxChain();
  if (pxClusters.length < 2) return res.status(400).json({ error: 'Need at least 2 Portworx clusters' });

  const pairs = buildDrpPairs(pxClusters);
  const s3 = cluster.getConfig().s3 || {};
  if (!s3.bucket || !s3.accessKey || !s3.secretKey) {
    return res.status(400).json({ error: 'S3 configuration incomplete' });
  }

  res.json({ status: 'creating', pairs: pairs.map(p => p.name) });

  (async () => {
    try {
      for (const pair of pairs) {
        emitEvent({ type: 'demo', action: `Creating DRP: ${pair.name}`, status: 'info' });

        const existsResp = await cluster.apiRequest(drCluster,
          `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs/${pair.name}`);
        if (existsResp.ok) {
          emitEvent({ type: 'demo', action: `DRP ${pair.name} already exists — skipped`, status: 'info' });
          continue;
        }

        const drpVars = { drp: { name: pair.name, src: pair.src, dst: pair.dst } };

        const drpYaml = templates.loadDrTemplate('02-drp.yaml', drpVars);
        const drpResp = await cluster.apiRequest(drCluster,
          `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs`,
          { method: 'POST', body: yamlToJson(drpYaml) });

        if (drpResp.ok) {
          emitEvent({ type: 'demo', action: `DRP ${pair.name} created`, status: 'success' });
        } else {
          const text = await drpResp.text();
          emitEvent({ type: 'demo', action: `DRP ${pair.name} failed: ${text}`, status: 'error' });
        }
      }
      emitEvent({ type: 'demo', action: 'DRP creation complete', status: 'success' });
    } catch (e) {
      emitEvent({ type: 'demo', action: `DRP creation error: ${e.message}`, status: 'error' });
    }
  })();
});

app.delete('/api/demo/delete-drps', async (req, res) => {
  const drCluster = findDrCluster();
  if (!drCluster) return res.status(400).json({ error: 'No ACM cluster found' });

  try {
    const pgResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups`);
    if (pgResp.ok) {
      const pgs = (await pgResp.json()).items || [];
      for (const pg of pgs) {
        await cluster.apiRequest(drCluster,
          `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups/${pg.metadata.name}`,
          { method: 'DELETE' });
        emitEvent({ type: 'demo', action: `PG ${pg.metadata.name} deleted`, status: 'info' });
      }
    }

    const drpResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs`);
    if (drpResp.ok) {
      const drps = (await drpResp.json()).items || [];
      for (const drp of drps) {
        await cluster.apiRequest(drCluster,
          `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs/${drp.metadata.name}`,
          { method: 'DELETE' });
        emitEvent({ type: 'demo', action: `DRP ${drp.metadata.name} deleted`, status: 'info' });
      }
    }

    emitEvent({ type: 'demo', action: 'All DRPs and PGs deleted', status: 'success' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function waitForDrpReady(drCluster, pairName, emitFn, maxWaitSec = 180) {
  const drpPath = `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs/${pairName}`;

  const drpResp = await cluster.apiRequest(drCluster, drpPath);
  if (!drpResp.ok) throw new Error(`DRP ${pairName} not found on hub`);
  const drp = await drpResp.json();
  const src = drp.spec.sourceCluster;
  const dst = drp.spec.destinationCluster;

  const requiredConditions = [
    'Ready',
    `${src}-Ready`, `${dst}-Ready`,
    `${src}-BackupLocationCreated`, `${dst}-BackupLocationCreated`
  ];

  emitFn({ type: 'demo', action: `Waiting for DRP ${pairName} to be ready on ${src} and ${dst}...`, status: 'info' });

  const start = Date.now();
  while (true) {
    const resp = await cluster.apiRequest(drCluster, drpPath);
    if (resp.ok) {
      const data = await resp.json();
      const conditions = data.status?.conditions || [];
      const allReady = requiredConditions.every(type => {
        const cond = conditions.find(c => c.type === type);
        return cond && cond.status === 'True';
      });
      if (allReady) {
        emitFn({ type: 'demo', action: `DRP ${pairName} ready on both spokes`, status: 'info' });
        return { src, dst };
      }
    }

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed >= maxWaitSec) {
      throw new Error(`DRP ${pairName} not ready after ${maxWaitSec}s. Check DRP status on ACM.`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

app.post('/api/demo/create-pg/:pairName', async (req, res) => {
  const drCluster = findDrCluster();
  if (!drCluster) return res.status(400).json({ error: 'No ACM cluster found' });

  const pairName = req.params.pairName;
  const pxClusters = getPxChain();
  const pairs = buildDrpPairs(pxClusters);
  const pairIndex = pairs.findIndex(p => p.name === pairName);
  if (pairIndex === -1) return res.status(404).json({ error: `Unknown pair: ${pairName}` });

  try {
    const existsResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups/${pairName}`);
    if (existsResp.ok) return res.json({ status: 'exists', name: pairName });

    await waitForDrpReady(drCluster, pairName, emitEvent);

    const pgYaml = templates.loadDrTemplate('03-pg.yaml', {
      drp: { name: pairName },
      pg: { name: pairName }
    });

    const pgResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups`,
      { method: 'POST', body: yamlToJson(pgYaml) });

    if (pgResp.ok) {
      emitEvent({ type: 'demo', action: `Protection Group ${pairName} created (startApplications: false)`, status: 'success' });
      res.json({ status: 'created', name: pairName });
    } else {
      const text = await pgResp.text();
      res.status(pgResp.status).json({ error: text });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/demo/delete-pg/:pairName', async (req, res) => {
  const drCluster = findDrCluster();
  if (!drCluster) return res.status(400).json({ error: 'No ACM cluster found' });

  const pairName = req.params.pairName;

  try {
    const resp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups/${pairName}`,
      { method: 'DELETE' });
    if (resp.ok || resp.status === 404) {
      emitEvent({ type: 'demo', action: `Protection Group ${pairName} deleted`, status: 'success' });
      res.json({ ok: true });
    } else {
      const text = await resp.text();
      res.status(resp.status).json({ error: text });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const SPOKE_DR_NAMESPACES = [config.get().operators?.storage?.namespace || 'portworx', 'kube-system'];

async function listByName(clusterName, apiPath) {
  const resp = await cluster.apiRequest(clusterName, apiPath);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.items || []).map(i => i.metadata.name);
}

async function getLiveUids(drCluster) {
  const drpResp = await cluster.apiRequest(drCluster,
    `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs`);
  const drpUids = drpResp.ok ? (await drpResp.json()).items.map(i => i.metadata.uid) : [];

  const pgResp = await cluster.apiRequest(drCluster,
    `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups`);
  const pgUids = pgResp.ok ? (await pgResp.json()).items.map(i => i.metadata.uid) : [];

  return { drpUids, pgUids };
}

function matchesAnyUid(name, uids) {
  return uids.some(uid => name.includes(uid));
}

async function auditSpoke(clusterName, drpUids, pgUids) {
  const orphans = [];
  for (const ns of SPOKE_DR_NAMESPACES) {
    for (const kind of ['backuplocations', 'clusterpairs']) {
      const names = await listByName(clusterName,
        `/apis/stork.libopenstorage.org/v1alpha1/namespaces/${ns}/${kind}`);
      for (const name of names) {
        if (!matchesAnyUid(name, drpUids)) {
          orphans.push({ kind, name, namespace: ns });
        }
      }
    }

    for (const kind of ['migrationschedules', 'migrations']) {
      const names = await listByName(clusterName,
        `/apis/stork.libopenstorage.org/v1alpha1/namespaces/${ns}/${kind}`);
      for (const name of names) {
        if (!matchesAnyUid(name, pgUids)) {
          orphans.push({ kind, name, namespace: ns });
        }
      }
    }

    const secrets = await listByName(clusterName, `/api/v1/namespaces/${ns}/secrets`);
    for (const name of secrets) {
      if ((name.startsWith('backup-location-') || name.startsWith('peer-kubeconfig-')) && !matchesAnyUid(name, drpUids)) {
        orphans.push({ kind: 'secret', name, namespace: ns });
      }
    }
  }

  const schedPolicies = await listByName(clusterName,
    '/apis/stork.libopenstorage.org/v1alpha1/schedulepolicies');
  for (const name of schedPolicies) {
    if (name.startsWith('portworx-') && !matchesAnyUid(name, pgUids)) {
      orphans.push({ kind: 'schedulepolicies', name, namespace: '' });
    }
  }

  return orphans;
}

async function deleteOrphan(clusterName, orphan) {
  let apiPath;
  if (orphan.kind === 'secret') {
    apiPath = `/api/v1/namespaces/${orphan.namespace}/secrets/${orphan.name}`;
  } else if (orphan.namespace === '') {
    apiPath = `/apis/stork.libopenstorage.org/v1alpha1/${orphan.kind}/${orphan.name}`;
  } else {
    apiPath = `/apis/stork.libopenstorage.org/v1alpha1/namespaces/${orphan.namespace}/${orphan.kind}/${orphan.name}`;
  }
  const resp = await cluster.apiRequest(clusterName, apiPath, { method: 'DELETE' });
  return resp.ok || resp.status === 404;
}

app.get('/api/demo/dr-audit', async (req, res) => {
  const drCluster = findDrCluster();
  if (!drCluster) return res.status(400).json({ error: 'No ACM cluster found' });

  try {
    const { drpUids, pgUids } = await getLiveUids(drCluster);
    const pxClusters = getPxChain();
    const results = {};

    for (const c of pxClusters) {
      const orphans = await auditSpoke(c.name, drpUids, pgUids);
      if (orphans.length > 0) results[c.name] = orphans;
    }

    res.json({ liveDrpCount: drpUids.length, livePgCount: pgUids.length, orphans: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/demo/prepare-onprem', async (req, res) => {
  const pxClusters = getPxChain();
  if (pxClusters.length === 0) return res.status(400).json({ error: 'No Portworx clusters found' });

  const target = pxClusters[pxClusters.length - 1];
  const ns = config.get().portworx?.dr?.protectedNamespace || 'portable-workload';

  try {
    emitEvent({ type: 'demo', action: `Deleting namespace ${ns} on ${target.name}`, status: 'started' });

    const resp = await cluster.apiRequest(target.name, `/api/v1/namespaces/${ns}`, { method: 'DELETE' });
    if (resp.ok || resp.status === 404) {
      const msg = resp.status === 404
        ? `Namespace ${ns} not found on ${target.name} — already clean`
        : `Namespace ${ns} deleted on ${target.name}`;
      emitEvent({ type: 'demo', action: msg, status: 'completed' });
      res.json({ cluster: target.name, namespace: ns, result: msg });
    } else {
      const body = await resp.text();
      throw new Error(`Failed to delete namespace ${ns} on ${target.name}: ${resp.status} ${body}`);
    }
  } catch (e) {
    emitEvent({ type: 'demo', action: `Prepare on-prem failed: ${e.message}`, status: 'error' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/demo/dr-deep-clean', async (req, res) => {
  const drCluster = findDrCluster();
  if (!drCluster) return res.status(400).json({ error: 'No ACM cluster found' });

  try {
    emitEvent({ type: 'demo', action: 'Deep clean started', status: 'started' });

    const drpResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs`);
    const drps = drpResp.ok ? (await drpResp.json()).items || [] : [];

    const pgResp = await cluster.apiRequest(drCluster,
      `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups`);
    const pgs = pgResp.ok ? (await pgResp.json()).items || [] : [];

    for (const pg of pgs) {
      await cluster.apiRequest(drCluster,
        `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/protectiongroups/${pg.metadata.name}`,
        { method: 'DELETE' });
      emitEvent({ type: 'demo', action: `PG ${pg.metadata.name} deleted (hub)`, status: 'info' });
    }

    for (const drp of drps) {
      await cluster.apiRequest(drCluster,
        `/apis/${DR_API_GROUP}/${DR_API_VERSION}/namespaces/${DR_NAMESPACE}/disasterrecoverypairs/${drp.metadata.name}`,
        { method: 'DELETE' });
      emitEvent({ type: 'demo', action: `DRP ${drp.metadata.name} deleted (hub)`, status: 'info' });
    }

    if (drps.length > 0) {
      emitEvent({ type: 'demo', action: 'Waiting for agent cleanup (25s)...', status: 'info' });
      await new Promise(r => setTimeout(r, 25000));
    }

    const pxClusters = getPxChain();
    const { drpUids, pgUids } = await getLiveUids(drCluster);
    let totalCleaned = 0;

    for (const c of pxClusters) {
      const orphans = await auditSpoke(c.name, drpUids, pgUids);
      for (const orphan of orphans) {
        const ok = await deleteOrphan(c.name, orphan);
        if (ok) {
          emitEvent({ type: 'demo', action: `Cleaned ${orphan.kind}/${orphan.name} on ${c.name}`, status: 'info' });
          totalCleaned++;
        }
      }
    }

    emitEvent({ type: 'demo', action: `Deep clean complete. ${drps.length} DRP(s), ${pgs.length} PG(s) removed from hub. ${totalCleaned} orphan(s) cleaned from spokes.`, status: 'success' });
    res.json({ ok: true, drpsDeleted: drps.length, pgsDeleted: pgs.length, orphansCleaned: totalCleaned });
  } catch (e) {
    emitEvent({ type: 'demo', action: `Deep clean failed: ${e.message}`, status: 'error' });
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  await cluster.loadClusters();
  await cluster.loadConfig();
  app.listen(PORT, () => {
    console.log(`Installation Dashboard listening on port ${PORT}`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
