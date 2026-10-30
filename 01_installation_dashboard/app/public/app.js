let selectedCluster = null;
let selectedRole = null;
let clusters = [];
let availableRoles = [];
let scanningOperators = new Set();
let assigningRole = null;
let assigningCluster = null;
let testingCluster = null;
let capacity = null;
let eventSource = null;
let activeTab = 'roles';
let overviewRefreshTimer = null;
let lbTrigger = { url: '', enabled: false };
let dragSrcEl = null;
let lastAssignError = null;
let acmPollTimer = null;
let acmLastSeen = {};
let logEntries = [];
let pipelineRunPollTimer = null;

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Request failed: ${resp.status}`);
  return data;
}

// ── SSE ──
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'connected') return;
    addLogEntry(data);

    if (data.type === 'cluster') refreshClusters();
    if (data.type === 'scan' && data.cluster === selectedCluster) {
      if (data.operator && data.status === 'scanning') {
        scanningOperators.add(data.operator);
      }
      if (data.operator && data.result) {
        scanningOperators.delete(data.operator);
        const c = clusters.find(c => c.name === selectedCluster);
        if (c) {
          if (!c.scanResult) c.scanResult = {};
          c.scanResult[data.operator] = data.result;
        }
      }
      if (data.status === 'complete') {
        scanningOperators.clear();
        refreshClusters().then(() => {
          refreshCapacity();
          if (activeTab === 'roles') renderRoles();
          updatePortworxTabVisibility();
          updateBuildTabVisibility();
          updateMtvGuideTabVisibility();
        });
      }
      if (activeTab === 'roles') renderRoles();
    }
    if (data.type === 'role') {
      if (data.cluster === assigningCluster && data.role === assigningRole) {
        if (data.status === 'complete' || data.status === 'removed' || data.status === 'failed') {
          assigningRole = null;
          assigningCluster = null;
          if (data.status === 'failed') {
            lastAssignError = { role: data.role, message: data.action || 'Installation failed' };
          }
        }
      }
      if (data.cluster === selectedCluster) {
        if (data.status === 'complete' || data.status === 'removed') {
          refreshClusters().then(() => {
            refreshCapacity();
            if (activeTab === 'roles') renderRoles();
            updatePortworxTabVisibility();
            updateBuildTabVisibility();
            updateMtvGuideTabVisibility();
          });
        }
        if (activeTab === 'roles') renderRoles();
      }
    }
    if (data.type === 'pipelines' && data.cluster === selectedCluster) {
      const c = clusters.find(c => c.name === selectedCluster);
      if (c) {
        if (data.status === 'success') {
          c.pipelineStatus = { status: 'deployed' };
        } else if (data.status === 'info') {
          c.pipelineStatus = { status: 'deploying' };
        }
        if (activeTab === 'roles') renderRoles();
        updateBuildTabVisibility();
        updateMtvGuideTabVisibility();
        if (activeTab === 'build-assets') updateBuildAssetsTab();
      }
    }
    if (!selectedCluster && ['cluster', 'scan', 'role'].includes(data.type)) {
      clearTimeout(overviewRefreshTimer);
      overviewRefreshTimer = setTimeout(loadOverview, 1000);
    }
    if (data.type === 'storagecluster') {
      if (activeTab === 'portworx-config' && data.cluster === selectedCluster) {
        renderPortworxStatus();
      }
    }
  };
  eventSource.onerror = () => {
    eventSource.close();
    setTimeout(connectSSE, 3000);
  };
}

function addLogEntry(data) {
  const now = new Date().toLocaleTimeString();
  let cls = 'info';
  let msg = '';

  if (data.type === 'scan') {
    msg = data.result
      ? `[${data.cluster}] ${data.operator}: ${data.result.status}`
      : `[${data.cluster}] Scanning ${data.operator || ''}...`;
  } else if (data.type === 'install') {
    msg = data.action || `[${data.cluster}] ${data.operator} install ${data.status}`;
    cls = data.status === 'error' ? 'error' : data.status === 'success' ? 'success' : 'info';
  } else if (data.type === 'role') {
    msg = data.action || `[${data.cluster}] Role ${data.role} ${data.status}`;
    cls = data.status === 'complete' ? 'success' : 'info';
  } else if (data.type === 'acm') {
    msg = data.action || `ACM ${data.status}`;
    cls = data.status === 'error' ? 'error' : data.status === 'success' ? 'success' : 'info';
  } else if (data.type === 'storagecluster') {
    msg = data.action || `[${data.cluster}] StorageCluster ${data.status}`;
    cls = data.status === 'complete' ? 'success' : data.status === 'error' ? 'error' : 'info';
  } else if (data.type === 'pipelines') {
    msg = data.action || `[${data.cluster}] Pipelines ${data.status}`;
    cls = data.status === 'error' ? 'error' : data.status === 'success' ? 'success' : 'info';
  } else if (data.type === 'config') {
    msg = data.action || `Configuration ${data.status}`;
    cls = data.status === 'success' ? 'success' : 'info';
  } else if (data.type === 'cluster') {
    msg = `Cluster ${data.name} ${data.action}`;
  } else {
    msg = JSON.stringify(data);
  }

  logEntries.unshift({ cls, msg, time: now });
  if (logEntries.length > 200) logEntries.length = 200;

  const log = document.getElementById('log-entries');
  if (log) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${cls}`;
    entry.innerHTML = `<span class="time">${now}</span>${msg}`;
    log.prepend(entry);
  }
}

// ── Tab Switching ──
function switchMainTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  updateTabContent();
}

function updateTabContent() {
  if (activeTab === 'roles') updateRolesTab();
  if (activeTab === 'build-assets') updateBuildAssetsTab();
  if (activeTab === 'portworx-config') updatePortworxConfigTab();
  if (activeTab === 'mtv-guide') updateMtvGuideTab();
}

// ── Portworx Tab Visibility ──
function isPortworxReady() {
  if (!selectedCluster) return false;
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c || c.type === 'legacy') return false;
  const hasPx = (c.assignedRoles || []).includes('portworx');
  const scan = c.scanResult || {};
  const storageInstalled = scan.storage?.status === 'installed';
  return hasPx && storageInstalled;
}

function updatePortworxTabVisibility() {
  const btn = document.getElementById('portworx-config-tab-btn');
  if (isPortworxReady()) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
    if (activeTab === 'portworx-config') {
      switchMainTab('roles');
    }
  }
}

// ── Build Assets Tab Visibility ──
function isBuildReady() {
  if (!selectedCluster) return false;
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c || c.type === 'legacy') return false;
  const hasBuild = (c.assignedRoles || []).includes('build');
  const scan = c.scanResult || {};
  const pipelinesInstalled = scan.pipelines?.status === 'installed';
  return hasBuild && pipelinesInstalled;
}

function updateBuildTabVisibility() {
  const btn = document.getElementById('build-assets-tab-btn');
  if (isBuildReady()) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
    if (activeTab === 'build-assets') {
      switchMainTab('roles');
    }
  }
}

// ── MTV Guide Tab Visibility ──
function isMtvReady() {
  if (!selectedCluster) return false;
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c || c.type === 'legacy') return false;
  const hasMtv = (c.assignedRoles || []).includes('mtv');
  const scan = c.scanResult || {};
  const mtvInstalled = scan.mtv?.status === 'installed';
  return hasMtv && mtvInstalled;
}

function updateMtvGuideTabVisibility() {
  const btn = document.getElementById('mtv-guide-tab-btn');
  if (isMtvReady()) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
    if (activeTab === 'mtv-guide') {
      switchMainTab('roles');
    }
  }
}

function updateMtvGuideTab() {}

function copyGuideBlock(btn) {
  const pre = btn.closest('.guide-code-block').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent);
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

// ── Build Assets Tab ──
async function updateBuildAssetsTab() {
  if (!selectedCluster) return;
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c) return;

  document.getElementById('build-cluster-name').textContent = `${c.name} — Build Assets`;

  const listEl = document.getElementById('pipeline-list');
  const runsEl = document.getElementById('pipeline-runs');

  listEl.innerHTML = '<div class="empty-state"><span class="spinner small"></span> Loading pipelines...</div>';
  runsEl.innerHTML = '';

  try {
    const [pipelineData, runData] = await Promise.all([
      api(`/api/clusters/${selectedCluster}/tekton/pipelines`),
      api(`/api/clusters/${selectedCluster}/tekton/pipelineruns`)
    ]);
    renderPipelineList(pipelineData, runData);
    renderPipelineRuns(runData);
    startPipelineRunPolling(runData);
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">Failed to load pipelines: ${e.message}</div>`;
  }
}

function renderPipelineList(pipelines, runs) {
  const el = document.getElementById('pipeline-list');
  if (!pipelines.length) {
    el.innerHTML = '<div class="empty-state">No pipelines found</div>';
    return;
  }
  const latestRun = {};
  for (const r of runs) {
    if (!latestRun[r.pipeline]) latestRun[r.pipeline] = r;
  }
  el.innerHTML = pipelines.map(p => {
    const run = latestRun[p.name];
    const st = run ? run.status : '';
    const cls = st === 'succeeded' ? ' succeeded' : st === 'failed' ? ' failed' : st === 'running' ? ' running' : '';
    let actionBtn;
    if (st === 'running' || st === 'pending') {
      actionBtn = `<button class="btn btn-danger btn-sm" onclick="cancelPipelineRun('${run.name}')">Cancel</button>`;
    } else if (st === 'succeeded' || st === 'failed') {
      actionBtn = `<button class="btn btn-primary btn-sm" onclick="runPipeline('${p.name}')">Re-run</button>`;
    } else {
      actionBtn = `<button class="btn btn-primary btn-sm" onclick="runPipeline('${p.name}')">Run</button>`;
    }

    let statusHtml = '';
    if (run) {
      const elapsed = formatRunDuration(run.startTime, run.completionTime);
      const statusCls = st === 'succeeded' ? 'succeeded' : st === 'failed' ? 'failed' : st === 'running' ? 'running' : 'pending';
      statusHtml = `<div class="pipeline-card-status">
        <span class="pipeline-run-status ${statusCls}">${st}</span>
        ${elapsed ? `<span class="pipeline-run-time">${elapsed}</span>` : ''}
      </div>`;
      if (st === 'failed' && run.message) {
        statusHtml += `<div class="pipeline-run-error">${run.message}</div>`;
      }
    }

    return `
    <div class="pipeline-card${cls}">
      <div class="pipeline-card-header">
        <span class="pipeline-name">${p.name}</span>
        <span class="pipeline-meta">${p.taskCount} task${p.taskCount !== 1 ? 's' : ''}</span>
      </div>
      ${statusHtml}
      <div class="pipeline-card-actions">
        ${actionBtn}
      </div>
    </div>`;
  }).join('');
}

function renderPipelineRuns(runs) {
  const el = document.getElementById('pipeline-runs');
  if (!runs.length) {
    el.innerHTML = '<div class="empty-state">No pipeline runs yet</div>';
    return;
  }
  el.innerHTML = runs.slice(0, 3).map(run => {
    const elapsed = formatRunDuration(run.startTime, run.completionTime);
    const statusCls = run.status === 'succeeded' ? 'succeeded'
      : run.status === 'failed' ? 'failed'
      : run.status === 'running' ? 'running' : 'pending';

    let tasksHtml = '';
    if (run.tasks && run.tasks.length > 0) {
      tasksHtml = `<div class="pipeline-run-tasks">${run.tasks.map(t =>
        `<div class="task-step ${t.status}" title="${t.name} — ${t.status}"></div>`
      ).join('')}</div>`;
    }

    return `
      <div class="pipeline-run-card ${statusCls}">
        <div class="pipeline-run-header">
          <div>
            <span class="pipeline-run-name">${run.pipeline}</span>
            <span class="pipeline-run-id">${run.name}</span>
          </div>
          <div class="pipeline-run-meta">
            <span class="pipeline-run-status ${statusCls}">${run.status}</span>
            <span class="pipeline-run-time">${elapsed}</span>
          </div>
        </div>
        ${tasksHtml}
        ${run.status === 'failed' && run.message ? `<div class="pipeline-run-error">${run.message}</div>` : ''}
      </div>
    `;
  }).join('');
}

function formatRunDuration(startTime, completionTime) {
  if (!startTime) return '';
  const start = new Date(startTime);
  const end = completionTime ? new Date(completionTime) : new Date();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

async function runPipeline(pipelineName) {
  try {
    const result = await api(`/api/clusters/${selectedCluster}/tekton/pipelines/${pipelineName}/run`, { method: 'POST' });
    addLogEntry({ type: 'pipelines', cluster: selectedCluster, action: `Pipeline ${pipelineName} started (${result.name})`, status: 'info' });
    startPipelineRunPolling([{ status: 'running' }]);
  } catch (e) {
    addLogEntry({ type: 'pipelines', cluster: selectedCluster, action: `Failed to run ${pipelineName}: ${e.message}`, status: 'error' });
  }
}

async function cancelPipelineRun(runName) {
  try {
    await api(`/api/clusters/${selectedCluster}/tekton/pipelineruns/${runName}/cancel`, { method: 'POST' });
    addLogEntry({ type: 'pipelines', cluster: selectedCluster, action: `Cancelled ${runName}`, status: 'info' });
    if (activeTab === 'build-assets') updateBuildAssetsTab();
  } catch (e) {
    addLogEntry({ type: 'pipelines', cluster: selectedCluster, action: `Failed to cancel ${runName}: ${e.message}`, status: 'error' });
  }
}

function startPipelineRunPolling(runs) {
  if (pipelineRunPollTimer) {
    clearInterval(pipelineRunPollTimer);
    pipelineRunPollTimer = null;
  }
  const hasActive = runs.some(r => r.status === 'running' || r.status === 'pending');
  if (hasActive && activeTab === 'build-assets') {
    pipelineRunPollTimer = setInterval(async () => {
      if (activeTab !== 'build-assets') {
        clearInterval(pipelineRunPollTimer);
        pipelineRunPollTimer = null;
        return;
      }
      try {
        const [pipelineData, runData] = await Promise.all([
          api(`/api/clusters/${selectedCluster}/tekton/pipelines`),
          api(`/api/clusters/${selectedCluster}/tekton/pipelineruns`)
        ]);
        renderPipelineList(pipelineData, runData);
        renderPipelineRuns(runData);
        const stillActive = runData.some(r => r.status === 'running' || r.status === 'pending');
        if (!stillActive) {
          clearInterval(pipelineRunPollTimer);
          pipelineRunPollTimer = null;
          updateExternalLinks();
        }
      } catch (e) { /* keep polling */ }
    }, 5000);
  }
}

// ── Cluster List ──
async function refreshClusters() {
  clusters = await api('/api/clusters');
  try {
    lbTrigger = await api('/api/lb-trigger');
  } catch (e) { /* ignore */ }
  renderClusters();
}

function renderClusters() {
  const list = document.getElementById('cluster-list');
  list.innerHTML = '';

  for (const c of clusters) {
    const isLegacy = c.type === 'legacy';
    const card = document.createElement('div');
    card.className = `cluster-card${c.name === selectedCluster ? ' selected' : ''}${isLegacy ? ' legacy' : ''}`;
    card.dataset.name = c.name;
    card.onclick = () => selectCluster(c.name);

    if (!isLegacy) {
      card.draggable = true;
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('drop', handleDrop);
      card.addEventListener('dragend', handleDragEnd);
    }

    const isTesting = testingCluster === c.name;
    const dotClass = c.connectionStatus === 'connected' ? 'connected'
      : c.connectionStatus === 'error' ? 'error' : 'unknown';
    const dotHtml = isTesting
      ? '<span class="spinner small"></span>'
      : `<span class="dot ${dotClass}"></span>`;

    const roleBadges = (c.assignedRoles || []).map(r =>
      `<span class="role-badge" style="font-size:0.65rem;padding:0.1rem 0.4rem;">${r}</span>`
    ).join('');

    if (isLegacy) {
      const consoleUrl = c.managementUrl || '';
      card.innerHTML = `
        <div class="cluster-card-header">
          ${dotHtml}
          <span class="name">${c.name}</span>
          <span class="type-badge">Legacy Infra</span>
          ${consoleUrl ? `<a href="${consoleUrl}" target="_blank" rel="noopener" class="console-link" title="Open management server" onclick="event.stopPropagation()">&#x2197;</a>` : ''}
        </div>
        <div class="cluster-card-actions">
          <button onclick="event.stopPropagation(); editCluster('${c.name}')">Edit</button>
          <button class="delete" onclick="event.stopPropagation(); deleteCluster('${c.name}')">Delete</button>
        </div>
      `;
    } else {
      const consoleUrl = c.consoleUrl || '';
      card.innerHTML = `
        <div class="cluster-card-header">
          <span class="drag-handle">&#x2630;</span>
          ${dotHtml}
          <span class="name">${c.name}</span>
          ${consoleUrl ? `<a href="${consoleUrl}" target="_blank" rel="noopener" class="console-link" title="Open Console" onclick="event.stopPropagation()">&#x2197;</a>` : ''}
        </div>
        ${roleBadges ? `<div style="margin-top:0.2rem;display:flex;gap:0.2rem;flex-wrap:wrap;">${roleBadges}</div>` : ''}
        <div class="cluster-card-actions">
          <button onclick="event.stopPropagation(); editCluster('${c.name}')">Edit</button>
          <button ${isTesting ? 'disabled' : ''} onclick="event.stopPropagation(); testCluster('${c.name}')">${isTesting ? '<span class="spinner small"></span>Testing' : 'Test'}</button>
          <button class="delete" onclick="event.stopPropagation(); deleteCluster('${c.name}')">Delete</button>
        </div>
      `;
    }
    list.appendChild(card);
  }

  const hasLegacy = clusters.some(c => c.type === 'legacy');
  const legacyBtn = document.getElementById('add-legacy-btn');
  if (legacyBtn) {
    legacyBtn.disabled = hasLegacy;
    legacyBtn.title = hasLegacy ? 'Only one Legacy Infra cluster allowed' : '';
  }

  updateBuildLbButton();
  updateOnboardAcmButton();
}

// ── Drag & Drop ──
function handleDragStart(e) {
  dragSrcEl = e.currentTarget;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', e.currentTarget.dataset.name);
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.currentTarget;
  if (target !== dragSrcEl && !target.classList.contains('legacy')) {
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    target.classList.remove('drag-above', 'drag-below');
    target.classList.add(e.clientY < midY ? 'drag-above' : 'drag-below');
  }
}

function handleDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  if (target === dragSrcEl || target.classList.contains('legacy')) return;
  target.classList.remove('drag-above', 'drag-below');
  const list = document.getElementById('cluster-list');
  const rect = target.getBoundingClientRect();
  if (e.clientY < rect.top + rect.height / 2) {
    list.insertBefore(dragSrcEl, target);
  } else {
    list.insertBefore(dragSrcEl, target.nextSibling);
  }
  saveClusterOrder();
}

function handleDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.cluster-card').forEach(c => {
    c.classList.remove('drag-above', 'drag-below');
  });
}

async function saveClusterOrder() {
  const cards = document.querySelectorAll('#cluster-list .cluster-card');
  const order = Array.from(cards).map(c => c.dataset.name);
  try {
    await api('/api/clusters/reorder', {
      method: 'PUT', body: JSON.stringify({ order })
    });
  } catch (e) {
    console.error('Reorder failed:', e.message);
  }
}

// ── Cluster Selection ──
function selectCluster(name) {
  selectedCluster = name;
  selectedRole = null;
  lastAssignError = null;
  localStorage.setItem('selectedCluster', name);
  document.getElementById('home-btn').classList.remove('active');
  document.getElementById('demo-btn').classList.remove('active');
  document.getElementById('overview-panel').classList.add('hidden');
  document.getElementById('demo-panel').classList.add('hidden');
  document.getElementById('cluster-view').classList.remove('hidden');
  renderClusters();
  updatePortworxTabVisibility();
  updateBuildTabVisibility();
  updateMtvGuideTabVisibility();
  switchMainTab('roles');
}

async function showOverview() {
  selectedCluster = null;
  selectedRole = null;
  localStorage.removeItem('selectedCluster');
  document.getElementById('home-btn').classList.add('active');
  document.getElementById('demo-btn').classList.remove('active');
  document.getElementById('overview-panel').classList.remove('hidden');
  document.getElementById('demo-panel').classList.add('hidden');
  document.getElementById('cluster-view').classList.add('hidden');
  renderClusters();
  loadOverview();
}

async function showDemo() {
  selectedCluster = null;
  selectedRole = null;
  localStorage.removeItem('selectedCluster');
  document.getElementById('home-btn').classList.remove('active');
  document.getElementById('demo-btn').classList.add('active');
  document.getElementById('overview-panel').classList.add('hidden');
  document.getElementById('demo-panel').classList.remove('hidden');
  document.getElementById('cluster-view').classList.add('hidden');
  renderClusters();
  await loadDemoPage();
}

// ── Roles Tab ──
async function updateRolesTab() {
  const noCluster = document.getElementById('roles-no-cluster');
  const content = document.getElementById('roles-content');

  if (!selectedCluster || clusters.find(c => c.name === selectedCluster)?.type === 'legacy') {
    noCluster.classList.remove('hidden');
    content.classList.add('hidden');
  } else {
    noCluster.classList.add('hidden');
    content.classList.remove('hidden');
    await renderRolesContent();
  }
}

async function renderRolesContent() {
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c) return;

  document.getElementById('config-cluster-name').textContent = c.name;
  document.getElementById('config-cluster-info').textContent =
    c.connectionStatus === 'connected' ? 'Connected' : c.connectionStatus;

  await refreshCapacity();
  renderCapacityBars('config');

  const badges = document.getElementById('config-roles-badges');
  badges.innerHTML = '';
  for (const r of (c.assignedRoles || [])) {
    const badge = document.createElement('span');
    badge.className = 'role-badge removable';
    badge.textContent = r;
    badge.title = 'Click to unassign';
    badge.onclick = () => unassignRole(r);
    badges.appendChild(badge);
  }

  renderRoles();
}

async function refreshCapacity() {
  if (!selectedCluster) return;
  try {
    capacity = await api(`/api/clusters/${selectedCluster}/capacity`);
  } catch (e) {
    capacity = null;
  }
}

function renderCapacityBars(prefix) {
  if (!capacity) return;
  const cpuPct = capacity.totalCpu > 0 ? Math.round((capacity.usedCpu / capacity.totalCpu) * 100) : 0;
  const memPct = capacity.totalMemGi > 0 ? Math.round((capacity.usedMemGi / capacity.totalMemGi) * 100) : 0;

  const cpuBar = document.getElementById(`${prefix}-cpu-bar`);
  if (cpuBar) {
    cpuBar.style.width = `${cpuPct}%`;
    cpuBar.className = `capacity-fill ${cpuPct > 80 ? 'red' : cpuPct > 60 ? 'yellow' : 'green'}`;
  }
  const cpuLabel = document.getElementById(`${prefix}-cpu-label`);
  if (cpuLabel) cpuLabel.textContent = `${capacity.usedCpu} / ${capacity.totalCpu} cores (${capacity.workerCount} workers)`;

  const memBar = document.getElementById(`${prefix}-mem-bar`);
  if (memBar) {
    memBar.style.width = `${memPct}%`;
    memBar.className = `capacity-fill ${memPct > 80 ? 'red' : memPct > 60 ? 'yellow' : 'green'}`;
  }
  const memLabel = document.getElementById(`${prefix}-mem-label`);
  if (memLabel) memLabel.textContent = `${capacity.usedMemGi} / ${capacity.totalMemGi} GiB`;
}

// ── Overview ──
async function loadOverview() {
  const container = document.getElementById('overview-content');
  container.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading overview...</div>';
  try {
    const summary = await api('/api/summary');
    renderOverviewContent(summary);
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Failed to load overview: ${e.message}</div>`;
  }
}

function renderDonut(segments, size, label, sublabel) {
  size = size || 110;
  const strokeWidth = 16;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;
  const total = segments.reduce((s, seg) => s + seg.value, 0);

  if (total === 0) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--border)" stroke-width="${strokeWidth}" />
      ${label != null ? `<text x="${cx}" y="${cy}" text-anchor="middle" dy="-0.1em" class="donut-center-label">${label}</text>` : ''}
      ${sublabel ? `<text x="${cx}" y="${cy}" text-anchor="middle" dy="1.3em" class="donut-center-sub">${sublabel}</text>` : ''}
    </svg>`;
  }

  let currentOffset = 0;
  let circles = '';

  for (const seg of segments) {
    if (seg.value === 0) continue;
    const dashLength = (seg.value / total) * circumference;
    const gap = total > 1 && segments.filter(s => s.value > 0).length > 1 ? 2 : 0;
    circles += `<circle cx="${cx}" cy="${cy}" r="${radius}"
      fill="none" stroke="${seg.color}" stroke-width="${strokeWidth}"
      stroke-dasharray="${Math.max(0, dashLength - gap)} ${circumference - Math.max(0, dashLength - gap)}"
      stroke-dashoffset="${-currentOffset}"
      stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})" />`;
    currentOffset += dashLength;
  }

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--border)" stroke-width="${strokeWidth}" />
    ${circles}
    ${label != null ? `<text x="${cx}" y="${cy}" text-anchor="middle" dy="-0.1em" class="donut-center-label">${label}</text>` : ''}
    ${sublabel ? `<text x="${cx}" y="${cy}" text-anchor="middle" dy="1.3em" class="donut-center-sub">${sublabel}</text>` : ''}
  </svg>`;
}

function renderOverviewContent(data) {
  const container = document.getElementById('overview-content');

  if (data.totalClusters === 0) {
    container.innerHTML = `
      <div class="empty-state" style="flex-direction:column;gap:1rem;height:50vh;">
        <p>No clusters registered yet.</p>
        <p style="font-size:0.85rem;color:var(--text-muted);">
          Add a cluster using the sidebar to get started.
        </p>
      </div>`;
    return;
  }

  const clusterNames = data.clusters.map(c => c.name);
  const roleKeys = Object.keys(data.roles).filter(rk => rk !== 'portworx');
  const matrixHead = `<tr><th>Role</th>${clusterNames.map(n =>
    `<th><span class="cluster-link" onclick="selectCluster('${n}')">${n}</span></th>`
  ).join('')}</tr>`;
  const matrixRows = roleKeys.map(rk => {
    const cells = clusterNames.map(cn => {
      const assigned = data.roles[rk].assigned.includes(cn);
      return `<td class="${assigned ? 'check' : 'dash'}">${assigned ? '&#10003;' : '–'}</td>`;
    }).join('');
    return `<tr><td>${data.roles[rk].name}</td>${cells}</tr>`;
  }).join('');

  const portworxRole = data.roles['portworx'];
  const portworxRow = portworxRole ? `<tr><td>${portworxRole.name}</td>${clusterNames.map(cn => {
    const assigned = portworxRole.assigned.includes(cn);
    return `<td class="${assigned ? 'check' : 'dash'}">${assigned ? '&#10003;' : '–'}</td>`;
  }).join('')}</tr>` : '';

  const pipelineRow = `<tr><td>Pipelines</td>${clusterNames.map(cn => {
    const cl = data.clusters.find(c => c.name === cn);
    if (!(cl.assignedRoles || []).includes('build')) return '<td class="dash">–</td>';
    const ps = cl.pipelineStatus?.status || 'unknown';
    if (ps === 'deployed') return '<td class="check">&#10003;</td>';
    if (ps === 'partial' || ps === 'deploying') return '<td style="color:var(--yellow)">&#9679;</td>';
    if (ps === 'error') return '<td style="color:var(--red)">&#10007;</td>';
    return '<td class="dash">&#9679;</td>';
  }).join('')}</tr>`;

  let nextStepsHtml = '';
  if (data.nextSteps.length > 0) {
    const items = data.nextSteps.map(s =>
      `<li><span class="step-dot ${s.priority}"></span>${s.message}</li>`
    ).join('');
    nextStepsHtml = `
      <div class="overview-card full-width">
        <h3>Next Steps</h3>
        <ul class="next-steps-list">${items}</ul>
      </div>`;
  }

  const storageRow = `<tr><td>StorageCluster</td>${clusterNames.map(cn => {
    const cl = data.clusters.find(c => c.name === cn);
    if (!(cl.assignedRoles || []).includes('portworx')) return '<td class="dash">–</td>';
    const crStatus = cl.scanResult?.storage?.crStatus;
    if (!crStatus || crStatus === 'not_created') return '<td style="color:var(--red)">&#10007;</td>';
    if (crStatus === 'Online' || crStatus === 'Running') return '<td class="check">&#10003;</td>';
    return `<td style="color:var(--yellow)" title="${crStatus}">&#9679;</td>`;
  }).join('')}</tr>`;

  container.innerHTML = `
    <div class="overview-grid">
      <div class="overview-card full-width">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3>Role Assignment</h3>
          <button id="overview-scan-btn" class="btn btn-secondary btn-sm" onclick="scanAllClusters()">Scan All</button>
        </div>
        <table class="role-matrix">
          <thead>${matrixHead}</thead>
          <tbody>${matrixRows}${pipelineRow}${portworxRow}${storageRow}</tbody>
        </table>
      </div>
      ${nextStepsHtml}
    </div>`;
}

// ── Roles ──
function renderRoles() {
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c) return;
  const scan = c?.scanResult || {};
  const assigned = c?.assignedRoles || [];

  const container = document.getElementById('role-cards');
  container.innerHTML = '';

  for (const role of availableRoles) {
    const isAssigned = assigned.includes(role.key);
    const isAssigning = assigningRole === role.key && assigningCluster === selectedCluster;

    const card = document.createElement('div');
    card.className = `role-card${isAssigned ? ' assigned' : ''}`;

    const opTags = role.operators.map(op => {
      const opScan = scan[op] || {};
      const opName = opScan.name || op;
      if (opScan.status === 'installed') return `<span class="op-tag installed">${opName}</span>`;
      return `<span class="op-tag">${opName}</span>`;
    }).join('');

    const extraTags = (role.extras || []).map(e => {
      if (e === 'Deployment Pipelines') {
        const ps = c?.pipelineStatus;
        let cls = 'extra';
        if (ps) {
          if (ps.status === 'deployed') cls = 'installed';
          else if (ps.status === 'not_deployed') cls = 'not-deployed';
          else if (ps.status === 'deploying' || ps.status === 'partial') cls = 'deploying';
          else if (ps.status === 'error') cls = 'op-error';
        }
        return `<span class="op-tag ${cls}">${e}</span>`;
      }
      return `<span class="op-tag extra">${e}</span>`;
    }).join('');

    const currentOps = getRoleOpsFromAssigned(assigned);
    const newOps = role.operators.filter(op => !currentOps.includes(op));
    let costHtml = '';
    if (!isAssigned && newOps.length > 0) {
      const res = role.operatorResources || {};
      const cost = newOps.reduce((acc, op) => {
        const r = res[op] || { cpu: 0, memory: 0 };
        return { c: acc.c + r.cpu, m: acc.m + r.memory };
      }, { c: 0, m: 0 });
      costHtml = `<div class="role-cost">+${cost.c} CPU, +${cost.m} GiB RAM</div>`;
    }

    let actionsHtml;
    if (isAssigned) {
      actionsHtml = `<span class="assigned-label">Assigned</span><button class="btn btn-accent btn-sm" onclick="event.stopPropagation(); reapplyRole('${role.key}')">Re-apply</button><button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); unassignRole('${role.key}')">Unassign</button>`;
    } else if (isAssigning) {
      actionsHtml = '<button class="btn btn-primary" disabled><span class="spinner small"></span>Assigning...</button>';
    } else {
      const notScanned = !Object.keys(scan).length;
      const blocked = notScanned || role.operators.some(op => {
        const prereqs = scan[op]?.prereqs;
        if (!prereqs || prereqs.ok || prereqs.warning) return false;
        if (op === 'mtv' && role.operators.includes('virt')) return false;
        return true;
      });
      actionsHtml = blocked
        ? '<button class="btn btn-primary" disabled>Assign</button>'
        : `<button class="btn btn-primary" onclick="event.stopPropagation(); assignRole('${role.key}')">Assign</button>`;
    }

    let errorHtml = '';
    if (lastAssignError && lastAssignError.role === role.key) {
      errorHtml = `<div class="role-error">${lastAssignError.message}</div>`;
    }

    let prereqWarningHtml = '';
    if (!isAssigned) {
      for (const op of role.operators) {
        if (op === 'mtv' && role.operators.includes('virt')) continue;
        const prereqs = scan[op]?.prereqs;
        if (prereqs?.warning) {
          prereqWarningHtml += `<div class="role-warning">${prereqs.message}</div>`;
        } else if (prereqs && !prereqs.ok) {
          prereqWarningHtml += `<div class="role-warning">${prereqs.message}</div>`;
        }
      }
    }

    let configLinkHtml = '';
    if (role.key === 'portworx' && isAssigned) {
      const storageInstalled = scan.storage?.status === 'installed';
      if (storageInstalled) {
        configLinkHtml = `<a class="px-config-link" onclick="event.stopPropagation(); switchMainTab('portworx-config')">Configure Portworx &rarr;</a>`;
      }
    }
    if (role.key === 'build' && isAssigned) {
      const ps = c?.pipelineStatus;
      if (ps?.status === 'deployed') {
        configLinkHtml = `<a class="px-config-link" onclick="event.stopPropagation(); switchMainTab('build-assets')">Build Assets &rarr;</a>`;
      }
    }
    if (role.key === 'mtv' && isAssigned) {
      const mtvInstalled = scan.mtv?.status === 'installed';
      if (mtvInstalled) {
        configLinkHtml = `<a class="px-config-link" onclick="event.stopPropagation(); switchMainTab('mtv-guide')">MTV Guide &rarr;</a>`;
      }
    }

    card.innerHTML = `
      <div class="role-card-header">
        <span class="name">${role.name}</span>
      </div>
      <div class="description">${role.description}</div>
      <div class="op-tags">${opTags}${extraTags}</div>
      ${costHtml}
      ${prereqWarningHtml}
      ${errorHtml}
      <div class="role-card-actions">${actionsHtml}</div>
      ${configLinkHtml}
    `;
    container.appendChild(card);
  }
}

function getRoleOpsFromAssigned(assignedRoles) {
  const ops = new Set();
  for (const rk of assignedRoles) {
    const role = availableRoles.find(r => r.key === rk);
    if (role) role.operators.forEach(op => ops.add(op));
  }
  return [...ops];
}

// ── Portworx Config Tab ──
async function updatePortworxConfigTab() {
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c) return;

  document.getElementById('px-config-cluster-name').textContent = `${c.name} — Portworx`;
  document.getElementById('px-config-cluster-info').textContent = c.platform || '';

  await renderPortworxStatus();
  renderPxCredsSection(c);
}

async function renderPortworxStatus() {
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c) return;

  const scan = c.scanResult || {};
  const hasPx = (c.assignedRoles || []).includes('portworx');
  const operatorInstalled = scan.storage?.status === 'installed';

  const setStatus = (id, installed, label, notLabel) => {
    const el = document.getElementById(id);
    el.textContent = installed ? (label || 'Installed') : (notLabel || 'Not Installed');
    el.className = `status-badge ${installed ? 'installed' : hasPx ? 'not_installed' : 'unknown'}`;
  };

  setStatus('op-status-operator', operatorInstalled);

  const applyBtn = document.getElementById('op-apply-sc-btn');
  const deleteBtn = document.getElementById('op-delete-sc-btn');
  const licenseBtn = document.getElementById('op-apply-license-btn');

  if (!hasPx || !operatorInstalled) {
    setStatus('op-status-sc', false, 'Online', 'Not Ready');
    setStatus('op-status-creds', false, 'Configured', 'Not Ready');
    setStatus('op-status-license', false, 'Applied', 'Not Ready');
    applyBtn.disabled = true;
    deleteBtn.classList.add('hidden');
    licenseBtn.disabled = true;
    return;
  }

  try {
    const sc = await api(`/api/clusters/${c.name}/storagecluster/status`);

    const scEl = document.getElementById('op-status-sc');
    if (sc.storageCluster.exists) {
      const phase = sc.storageCluster.status;
      if (phase === 'online') {
        scEl.textContent = 'Online';
        scEl.className = 'status-badge installed';
      } else if (phase === 'initializing') {
        scEl.textContent = 'Initializing...';
        scEl.className = 'status-badge installing';
      } else {
        scEl.textContent = phase || 'Exists';
        scEl.className = 'status-badge unknown';
      }
    } else {
      scEl.textContent = 'Not Created';
      scEl.className = 'status-badge not_installed';
    }

    const credsEl = document.getElementById('op-status-creds');
    credsEl.textContent = sc.credentials.configured ? 'Configured' : 'Not Configured';
    credsEl.className = `status-badge ${sc.credentials.configured ? 'installed' : 'not_installed'}`;

    setStatus('op-status-license', sc.licenseApplied, 'Applied', 'Not Applied');
    licenseBtn.disabled = !sc.storageCluster.exists;

    const uninstalling = sc.storageCluster.exists && sc.storageCluster.status === 'uninstalling';
    applyBtn.disabled = sc.storageCluster.exists;
    if (uninstalling) {
      applyBtn.textContent = 'StorageCluster Applied';
      deleteBtn.classList.remove('hidden');
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Uninstalling...';
    } else if (sc.storageCluster.exists) {
      applyBtn.textContent = 'StorageCluster Applied';
      deleteBtn.classList.remove('hidden');
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete StorageCluster';
    } else {
      applyBtn.textContent = 'Apply StorageCluster';
      applyBtn.disabled = false;
      deleteBtn.classList.add('hidden');
    }
  } catch (e) {
    setStatus('op-status-sc', false, 'Online', 'Unknown');
    setStatus('op-status-creds', false, 'Configured', 'Unknown');
    setStatus('op-status-license', false, 'Applied', 'Unknown');
    applyBtn.disabled = true;
  }
}

// ── Portworx Credentials ──
async function renderPxCredsSection(c) {
  document.getElementById('px-creds-azure').classList.add('hidden');
  document.getElementById('px-creds-aws-sts').classList.add('hidden');
  document.getElementById('px-creds-gcp').classList.add('hidden');
  document.getElementById('px-creds-aws-iam').classList.add('hidden');

  const clearInput = id => { const el = document.getElementById(id); if (el) { el.value = ''; el.placeholder = ''; } };
  clearInput('px-azure-client-id');
  clearInput('px-azure-client-secret');
  clearInput('px-azure-tenant-id');
  clearInput('px-aws-role-arn');
  clearInput('px-gcp-sa-key');
  clearInput('px-aws-access-key');
  clearInput('px-aws-secret-key');
  const clearText = id => { const el = document.getElementById(id); if (el) el.textContent = ''; };
  clearText('px-aws-sts-cmd');
  clearText('px-gcp-cmd');

  const platformEl = document.getElementById('px-creds-platform');
  const hintEl = document.getElementById('px-creds-hint');
  const statusEl = document.getElementById('px-creds-status');

  let creds = { configured: false };
  try {
    creds = await api(`/api/clusters/${c.name}/px-credentials`);
  } catch (e) { /* ignore */ }

  statusEl.textContent = creds.configured ? 'Configured' : 'Not Configured';
  statusEl.className = `status-badge ${creds.configured ? 'installed' : 'unknown'}`;

  const platform = c.platform || '';
  if (platform === 'Azure') {
    platformEl.textContent = 'ARO — Azure Service Principal';
    hintEl.textContent = 'ARO requires a service principal (managed identity is not supported on worker nodes).';
    document.getElementById('px-creds-azure').classList.remove('hidden');
    if (creds.configured) {
      document.getElementById('px-azure-client-id').value = creds.clientId || '';
      document.getElementById('px-azure-client-secret').value = '';
      document.getElementById('px-azure-client-secret').placeholder = '(configured)';
      document.getElementById('px-azure-tenant-id').value = creds.tenantId || '';
    }
  } else if (platform === 'AWS' && c.stsEnabled) {
    platformEl.textContent = 'AWS — STS (Workload Identity)';
    hintEl.textContent = 'This cluster uses STS with OIDC. Provide the IAM role ARN with EC2/EBS permissions trusted by the cluster OIDC provider.';
    document.getElementById('px-creds-aws-sts').classList.remove('hidden');
    if (creds.helpCommand) {
      document.getElementById('px-aws-sts-cmd').textContent = creds.helpCommand;
    }
    if (creds.configured) {
      document.getElementById('px-aws-role-arn').value = creds.roleArn || '';
    }
  } else if (platform === 'GCP') {
    platformEl.textContent = 'OSD — GCP Service Account';
    hintEl.textContent = 'OSD on GCP requires a service account JSON key with Compute and IAM permissions.';
    document.getElementById('px-creds-gcp').classList.remove('hidden');
    if (creds.helpCommand) {
      document.getElementById('px-gcp-cmd').textContent = creds.helpCommand;
    }
    if (creds.configured && creds.hasJsonKey) {
      document.getElementById('px-gcp-sa-key').value = '';
      document.getElementById('px-gcp-sa-key').placeholder = '(configured — paste new key to replace)';
    }
  } else if (platform === 'AWS') {
    platformEl.textContent = 'OCP on AWS — IAM Instance Profile';
    hintEl.textContent = 'Self-managed OCP uses the worker node IAM instance profile by default. Override only if the profile lacks EC2 volume permissions.';
    document.getElementById('px-creds-aws-iam').classList.remove('hidden');
    document.getElementById('px-aws-static-fields').classList.add('hidden');
  } else {
    platformEl.textContent = platform ? `${platform} Platform` : 'Unknown Platform';
    hintEl.textContent = 'Test the cluster connection to detect the platform, then configure credentials.';
  }
}

async function savePxCredentials() {
  const c = clusters.find(c => c.name === selectedCluster);
  if (!c) return;

  const platform = c.platform || '';
  let creds = {};

  if (platform === 'Azure') {
    creds = {
      type: 'azure-sp',
      clientId: document.getElementById('px-azure-client-id').value.trim(),
      clientSecret: document.getElementById('px-azure-client-secret').value,
      tenantId: document.getElementById('px-azure-tenant-id').value.trim()
    };
    if (!creds.clientId || !creds.tenantId) {
      alert('Client ID and Tenant ID are required');
      return;
    }
  } else if (platform === 'AWS' && c.stsEnabled) {
    creds = {
      type: 'aws-sts',
      roleArn: document.getElementById('px-aws-role-arn').value.trim()
    };
    if (!creds.roleArn) {
      alert('IAM Role ARN is required');
      return;
    }
  } else if (platform === 'GCP') {
    const jsonKey = document.getElementById('px-gcp-sa-key').value.trim();
    if (!jsonKey) {
      alert('Service Account JSON key is required');
      return;
    }
    try { JSON.parse(jsonKey); } catch (e) {
      alert('Invalid JSON key format');
      return;
    }
    creds = { type: 'gcp-sa', jsonKey };
  } else if (platform === 'AWS') {
    const accessKey = document.getElementById('px-aws-access-key')?.value.trim();
    const secretKey = document.getElementById('px-aws-secret-key')?.value;
    if (accessKey && secretKey) {
      creds = { type: 'aws-static', accessKey, secretKey };
    } else {
      creds = { type: 'aws-iam' };
    }
  }

  try {
    await api(`/api/clusters/${selectedCluster}/px-credentials`, {
      method: 'PUT',
      body: JSON.stringify(creds)
    });
    addLogEntry({ type: 'config', action: `Portworx cloud credentials saved for ${selectedCluster}`, status: 'success' });
    renderPxCredsSection(c);
    renderPortworxStatus();
  } catch (e) {
    alert(`Save failed: ${e.message}`);
  }
}

// ── Scan ──
async function scanAllClusters() {
  const btn = document.getElementById('overview-scan-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner small"></span> Scanning...'; }
  try {
    const openshift = clusters.filter(c => (c.type || 'openshift') === 'openshift');
    await Promise.all(openshift.map(async c => {
      try {
        const result = await api(`/api/clusters/${c.name}/scan`, { method: 'POST' });
        c.scanResult = result;
        c.connectionStatus = 'connected';
      } catch (e) {
        addLogEntry({ type: 'scan', cluster: c.name, status: 'error', action: e.message });
      }
    }));
    await loadOverview();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Scan All'; }
  }
}

async function scanCluster() {
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Scanning...';
  scanningOperators.clear();
  try {
    const result = await api(`/api/clusters/${selectedCluster}/scan`, { method: 'POST' });
    const c = clusters.find(c => c.name === selectedCluster);
    if (c) {
      c.scanResult = result;
      c.connectionStatus = 'connected';
    }
    scanningOperators.clear();
    renderRoles();
    updatePortworxTabVisibility();
    updateBuildTabVisibility();
    updateMtvGuideTabVisibility();
    await refreshClusters();
  } catch (e) {
    addLogEntry({ type: 'scan', cluster: selectedCluster, status: 'error', action: e.message });
    scanningOperators.clear();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan';
  }
}

// ── Role Assignment ──
async function assignRole(roleKey) {
  assigningRole = roleKey;
  assigningCluster = selectedCluster;
  lastAssignError = null;
  renderRoles();
  try {
    const result = await api(`/api/clusters/${selectedCluster}/roles/${roleKey}`, { method: 'POST' });
    if (result.status === 'already_assigned') {
      addLogEntry({ type: 'role', cluster: selectedCluster, role: roleKey, action: 'Already assigned', status: 'info' });
      assigningRole = null;
      assigningCluster = null;
      renderRoles();
    }
  } catch (e) {
    lastAssignError = { role: roleKey, message: e.message };
    addLogEntry({ type: 'role', cluster: selectedCluster, role: roleKey, action: `Assign failed: ${e.message}`, status: 'error' });
    assigningRole = null;
    assigningCluster = null;
    renderRoles();
  }
}

async function reapplyRole(roleKey) {
  assigningRole = roleKey;
  assigningCluster = selectedCluster;
  renderRoles();
  try {
    await api(`/api/clusters/${selectedCluster}/roles/${roleKey}/reapply`, { method: 'POST' });
    addLogEntry({ type: 'role', cluster: selectedCluster, role: roleKey, action: `Re-applying role ${roleKey}...`, status: 'info' });
  } catch (e) {
    lastAssignError = { role: roleKey, message: e.message };
    addLogEntry({ type: 'role', cluster: selectedCluster, role: roleKey, action: `Re-apply failed: ${e.message}`, status: 'error' });
    assigningRole = null;
    assigningCluster = null;
    renderRoles();
  }
}

async function unassignRole(roleKey) {
  const preview = await api(`/api/clusters/${selectedCluster}/roles/${roleKey}/preview-unassign`);

  const warningsDiv = document.getElementById('unassign-warnings');
  const detailsDiv = document.getElementById('unassign-details');

  if (preview.warnings.length > 0) {
    warningsDiv.innerHTML = `<div class="warning-box">${preview.warnings.map(w => `<p>${w}</p>`).join('')}</div>`;
  } else {
    warningsDiv.innerHTML = '';
  }

  let detailsHtml = `<div class="unassign-detail">`;
  detailsHtml += `<strong>Unassigning "${preview.roleName}" from ${selectedCluster}</strong><br>`;
  if (preview.willUninstall.length > 0) {
    detailsHtml += `<br>Will uninstall: <span class="op-list">${preview.willUninstall.join(', ')}</span>`;
  }
  if (preview.keptByOtherRoles.length > 0) {
    detailsHtml += `<br>Kept (used by other roles): <span class="op-list">${preview.keptByOtherRoles.join(', ')}</span>`;
  }
  if (preview.willUninstall.length === 0) {
    detailsHtml += `<br>No operators will be uninstalled (all are used by other roles).`;
  }
  detailsHtml += `</div>`;
  detailsDiv.innerHTML = detailsHtml;

  const confirmBtn = document.getElementById('unassign-confirm-btn');
  confirmBtn.textContent = preview.willUninstall.length > 0 ? 'Unassign & Uninstall' : 'Unassign';
  confirmBtn.className = preview.willUninstall.length > 0 ? 'btn btn-danger' : 'btn btn-primary';

  const modal = document.getElementById('unassign-modal');
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const onConfirm = async () => {
      cleanup();
      modal.classList.add('hidden');
      try {
        await api(`/api/clusters/${selectedCluster}/roles/${roleKey}`, { method: 'DELETE' });
        const c = clusters.find(c => c.name === selectedCluster);
        if (c && c.assignedRoles) {
          c.assignedRoles = c.assignedRoles.filter(r => r !== roleKey);
        }
        addLogEntry({ type: 'role', cluster: selectedCluster, role: roleKey, action: `Role ${roleKey} unassigned — uninstall running in background`, status: 'success' });
        await refreshCapacity();
        renderRoles();
        renderClusters();
        updatePortworxTabVisibility();
        updateBuildTabVisibility();
        updateMtvGuideTabVisibility();
      } catch (e) {
        addLogEntry({ type: 'role', cluster: selectedCluster, role: roleKey, action: `Unassign failed: ${e.message}`, status: 'error' });
      }
      resolve();
    };
    const onCancel = () => { cleanup(); modal.classList.add('hidden'); resolve(); };
    const cleanup = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      document.getElementById('unassign-cancel-btn').removeEventListener('click', onCancel);
    };
    confirmBtn.addEventListener('click', onConfirm);
    document.getElementById('unassign-cancel-btn').addEventListener('click', onCancel);
  });
}

// ── Build LB ──
async function updateBuildLbButton() {
  const btn = document.getElementById('build-lb-btn');
  if (!btn) return;
  const hasBuild = clusters.some(c => (c.assignedRoles || []).includes('build'));
  btn.disabled = !hasBuild;
  btn.title = hasBuild ? '' : 'Assign the Build role to a cluster first';
  updateExternalLinks();
}

async function updateExternalLinks() {
  const lbLink = document.getElementById('link-lb');
  const artLink = document.getElementById('link-artifacts');
  try {
    const [lb, art] = await Promise.all([
      api('/api/lb-route').catch(() => ({ url: '' })),
      api('/api/artifacts-route').catch(() => ({ url: '' }))
    ]);
    if (lb.url && lbLink) {
      lbLink.href = lb.url;
      lbLink.target = '_blank';
      lbLink.rel = 'noopener';
      lbLink.classList.remove('disabled');
      lbLink.classList.add('active');
      lbLink.title = '';
    }
    if (art.url && artLink) {
      artLink.href = art.url;
      artLink.target = '_blank';
      artLink.rel = 'noopener';
      artLink.classList.remove('disabled');
      artLink.classList.add('active');
      artLink.title = '';
    }
  } catch (e) { /* routes not available */ }
}

async function buildLoadbalancer() {
  const btn = document.getElementById('build-lb-btn');
  btn.disabled = true;
  btn.textContent = 'Building...';
  try {
    await api('/api/lb-trigger', { method: 'POST' });
    btn.textContent = 'Build Triggered!';
    if (activeTab === 'build-assets') startPipelineRunPolling([{ status: 'running' }]);
    setTimeout(async () => {
      btn.textContent = 'Build Loadbalancer';
      btn.disabled = false;
      await updateBuildLbButton();
    }, 10000);
  } catch (e) {
    alert(`Build trigger failed: ${e.message}`);
    btn.textContent = 'Build Loadbalancer';
    btn.disabled = false;
  }
}

// ── ACM Onboard ──
function updateOnboardAcmButton() {
  const btn = document.getElementById('onboard-acm-btn');
  if (!btn) return;
  const hasAcm = clusters.some(c => (c.assignedRoles || []).includes('acm'));
  btn.disabled = !hasAcm;
  btn.title = hasAcm ? '' : 'Assign the ACM role to a cluster first';
}

async function onboardToAcm() {
  const btn = document.getElementById('onboard-acm-btn');
  btn.disabled = true;
  btn.textContent = 'Onboarding...';
  acmLastSeen = {};

  try {
    await api('/api/acm-onboard', { method: 'POST' });
    if (activeTab === 'build-assets') startPipelineRunPolling([{ status: 'running' }]);
  } catch (e) {
    alert(`ACM onboard failed: ${e.message}`);
    btn.textContent = 'Onboard to ACM';
    btn.disabled = false;
    return;
  }

  addLogEntry({ type: 'acm', action: 'ACM cluster onboarding triggered', status: 'info' });

  if (acmPollTimer) clearInterval(acmPollTimer);
  acmPollTimer = setInterval(pollAcmStatus, 3000);
}

async function pollAcmStatus() {
  const btn = document.getElementById('onboard-acm-btn');
  try {
    const data = await api('/api/acm-onboard/status');
    if (data.status === 'idle' || data.status === 'unavailable') return;

    if (data.clusters) {
      for (const [name, state] of Object.entries(data.clusters)) {
        if (acmLastSeen[name] !== state) {
          acmLastSeen[name] = state;
          let action = '';
          let status = 'info';
          if (state === 'checking') action = `Checking if ${name} is already in ACM...`;
          else if (state === 'skipped') { action = `${name} already imported, skipping`; status = 'success'; }
          else if (state === 'importing') action = `Onboarding ${name} to ACM...`;
          else if (state === 'imported') { action = `${name} imported to ACM successfully`; status = 'success'; }
          else if (state === 'failed') { action = `${name} failed to import`; status = 'error'; }
          if (action) addLogEntry({ type: 'acm', action, status });
        }
      }
    }

    if (data.status === 'complete' || data.status === 'failed') {
      clearInterval(acmPollTimer);
      acmPollTimer = null;
      const msg = data.status === 'complete' ? 'ACM onboarding complete' : 'ACM onboarding failed';
      const cls = data.status === 'complete' ? 'success' : 'error';
      addLogEntry({ type: 'acm', action: msg, status: cls });
      btn.textContent = 'Onboard to ACM';
      btn.disabled = false;
    }
  } catch (e) {
    // keep polling
  }
}

// ── StorageCluster ──
async function applyStorageCluster() {
  const btn = document.getElementById('op-apply-sc-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner small"></span>Deploying...';

  try {
    await api(`/api/clusters/${selectedCluster}/storagecluster`, { method: 'POST' });
  } catch (e) {
    alert(`Deploy failed: ${e.message}`);
    btn.textContent = 'Apply StorageCluster';
    btn.disabled = false;
  }
}

async function deleteStorageCluster() {
  if (!confirm('Delete the StorageCluster? This will tear down Portworx storage on this cluster.')) return;
  const btn = document.getElementById('op-delete-sc-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner small"></span>Deleting...';

  try {
    await api(`/api/clusters/${selectedCluster}/storagecluster`, { method: 'DELETE' });
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
    btn.textContent = 'Delete StorageCluster';
    btn.disabled = false;
  }
}

async function previewStorageClusterSpec() {
  try {
    const data = await api(`/api/clusters/${selectedCluster}/storagecluster/spec`);
    alert(`Platform: ${data.platformKey}\n\n${data.content}`);
  } catch (e) {
    alert(`Preview failed: ${e.message}`);
  }
}

async function applyPxLicense() {
  const btn = document.getElementById('op-apply-license-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner small"></span>Triggering...';

  try {
    await api('/api/px-license/apply', { method: 'POST' });
    btn.textContent = 'Pipeline Triggered';
    addLogEntry({ type: 'install', action: 'Portworx license activation pipeline triggered', status: 'success' });
    renderPortworxStatus();
    setTimeout(() => { btn.textContent = 'Apply License'; btn.disabled = false; }, 10000);
  } catch (e) {
    alert(`Failed to trigger license pipeline: ${e.message}`);
    btn.textContent = 'Apply License';
    btn.disabled = false;
  }
}

// ── Config Forms ──
function showS3Config() {
  document.getElementById('s3-config-form').classList.toggle('hidden');
  document.getElementById('px-license-form').classList.add('hidden');
  if (!document.getElementById('s3-config-form').classList.contains('hidden')) {
    loadS3Config();
  }
}

async function loadS3Config() {
  try {
    const data = await api('/api/config/s3');
    document.getElementById('s3-bucket').value = data.bucket;
    document.getElementById('s3-region').value = data.region;
    document.getElementById('s3-endpoint').value = data.endpoint;
    document.getElementById('s3-access-key').value = data.accessKey;
    document.getElementById('s3-secret-key').value = '';
    document.getElementById('s3-secret-key').placeholder = data.hasSecretKey ? '(configured)' : '';
  } catch (e) { /* ignore */ }
}

async function saveS3Config() {
  const bucket = document.getElementById('s3-bucket').value.trim();
  const region = document.getElementById('s3-region').value.trim();
  const endpoint = document.getElementById('s3-endpoint').value.trim().replace(/^https?:\/\//, '');
  const accessKey = document.getElementById('s3-access-key').value.trim();
  const secretKey = document.getElementById('s3-secret-key').value;

  if (!bucket || !region || !endpoint || !accessKey) {
    alert('Bucket, region, endpoint and access key are required');
    return;
  }
  const hasExisting = document.getElementById('s3-secret-key').placeholder === '(configured)';
  if (!secretKey && !hasExisting) {
    alert('Secret key is required');
    return;
  }

  try {
    const body = { bucket, region, endpoint, accessKey };
    if (secretKey) body.secretKey = secretKey;
    await api('/api/config/s3', {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    document.getElementById('s3-config-form').classList.add('hidden');
    document.getElementById('s3-config-btn').classList.add('configured');
    addLogEntry({ type: 'config', action: 'S3 bucket configuration saved', status: 'success' });
  } catch (e) {
    alert(`Save failed: ${e.message}`);
  }
}

function showPxLicenseConfig() {
  document.getElementById('px-license-form').classList.toggle('hidden');
  document.getElementById('s3-config-form').classList.add('hidden');
  if (!document.getElementById('px-license-form').classList.contains('hidden')) {
    loadPxLicenseConfig();
  }
}

async function loadPxLicenseConfig() {
  try {
    const data = await api('/api/config/px-license');
    document.getElementById('px-license-key').value = '';
    document.getElementById('px-license-key').placeholder = data.configured ? '(configured)' : '';
  } catch (e) { /* ignore */ }
}

async function savePxLicenseKey() {
  const key = document.getElementById('px-license-key').value.trim();
  const hasExisting = document.getElementById('px-license-key').placeholder === '(configured)';
  if (!key && !hasExisting) {
    alert('License key is required');
    return;
  }
  if (!key) {
    document.getElementById('px-license-form').classList.add('hidden');
    return;
  }

  try {
    await api('/api/config/px-license', {
      method: 'PUT',
      body: JSON.stringify({ key })
    });
    document.getElementById('px-license-form').classList.add('hidden');
    document.getElementById('px-license-btn').classList.add('configured');
    addLogEntry({ type: 'config', action: 'Portworx license key saved', status: 'success' });
  } catch (e) {
    alert(`Save failed: ${e.message}`);
  }
}

async function updateConfigButtons() {
  try {
    const s3 = await api('/api/config/s3');
    if (s3.bucket) document.getElementById('s3-config-btn').classList.add('configured');
  } catch (e) { /* ignore */ }
  try {
    const px = await api('/api/config/px-license');
    if (px.configured) document.getElementById('px-license-btn').classList.add('configured');
  } catch (e) { /* ignore */ }
}

// ── Cluster CRUD ──
async function testCluster(name) {
  testingCluster = name;
  renderClusters();
  try {
    const info = await api(`/api/clusters/${name}/test`, { method: 'POST' });
    const c = clusters.find(c => c.name === name);
    if (c) {
      c.connectionStatus = 'connected';
      c.nodes = info.nodes;
      c.version = info.version;
      c.platform = info.platform;
      if (info.consoleUrl) c.consoleUrl = info.consoleUrl;
    }
    addLogEntry({ type: 'cluster', name, action: `test OK — v${info.version} (${info.platform}), ${info.nodes?.length || 0} nodes` });
    if (name === selectedCluster) {
      refreshCapacity();
      updateTabContent();
    }
  } catch (e) {
    const c = clusters.find(c => c.name === name);
    if (c) c.connectionStatus = 'error';
    addLogEntry({ type: 'cluster', name, action: `test failed: ${e.message}`, status: 'error' });
  } finally {
    testingCluster = null;
    renderClusters();
  }
}

function editCluster(name) {
  const c = clusters.find(c => c.name === name);
  if (!c) return;
  const isLegacy = c.type === 'legacy';
  document.getElementById('edit-ocp-fields').classList.toggle('hidden', isLegacy);
  document.getElementById('edit-legacy-fields').classList.toggle('hidden', !isLegacy);
  if (isLegacy) {
    document.getElementById('edit-cluster-manager').value = c.managementUrl || '';
    document.getElementById('edit-cluster-workload').value = c.workloadUrl || '';
  } else {
    document.getElementById('edit-cluster-api').value = c.api;
  }
  document.getElementById('edit-cluster-user').value = c.user || '';
  document.getElementById('edit-cluster-password').value = '';
  document.getElementById('edit-cluster-modal').classList.remove('hidden');
  document.getElementById('edit-cluster-modal').dataset.name = name;
  document.getElementById('edit-cluster-modal').dataset.type = c.type || 'openshift';
}

async function saveEditCluster() {
  const modal = document.getElementById('edit-cluster-modal');
  const name = modal.dataset.name;
  const type = modal.dataset.type;
  const updates = { user: document.getElementById('edit-cluster-user').value };
  if (type === 'legacy') {
    updates.managementUrl = document.getElementById('edit-cluster-manager').value;
    updates.workloadUrl = document.getElementById('edit-cluster-workload').value;
  } else {
    updates.api = document.getElementById('edit-cluster-api').value;
  }
  const pw = document.getElementById('edit-cluster-password').value;
  if (pw) updates.password = pw;
  try {
    await api(`/api/clusters/${name}`, { method: 'PUT', body: JSON.stringify(updates) });
    modal.classList.add('hidden');
    await refreshClusters();
  } catch (e) {
    alert(`Update failed: ${e.message}`);
  }
}

async function deleteCluster(name) {
  if (!confirm(`Delete cluster "${name}"? This also removes all generated YAML.`)) return;
  try {
    await api(`/api/clusters/${name}`, { method: 'DELETE' });
    if (selectedCluster === name) {
      selectedCluster = null;
      localStorage.removeItem('selectedCluster');
    }
    await refreshClusters();
    showOverview();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
}

function showAddOcpForm() {
  document.getElementById('add-ocp-form').classList.remove('hidden');
  document.getElementById('add-legacy-form').classList.add('hidden');
  document.getElementById('ocp-name').focus();
}

function hideAddOcpForm() {
  document.getElementById('add-ocp-form').classList.add('hidden');
  document.getElementById('ocp-name').value = '';
  document.getElementById('ocp-api').value = '';
  document.getElementById('ocp-user').value = '';
  document.getElementById('ocp-password').value = '';
}

async function addOcpCluster() {
  const name = document.getElementById('ocp-name').value.trim();
  const apiUrl = document.getElementById('ocp-api').value.trim();
  const user = document.getElementById('ocp-user').value.trim();
  const password = document.getElementById('ocp-password').value;

  if (!name || !apiUrl || !user || !password) {
    alert('All fields are required');
    return;
  }

  const btn = document.getElementById('save-ocp-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Connecting...';

  try {
    await api('/api/clusters', {
      method: 'POST',
      body: JSON.stringify({ name, api: apiUrl, user, password })
    });
    hideAddOcpForm();
    await refreshClusters();
    selectCluster(name);
  } catch (e) {
    alert(`Add failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

function showAddLegacyForm() {
  document.getElementById('add-legacy-form').classList.remove('hidden');
  document.getElementById('add-ocp-form').classList.add('hidden');
  document.getElementById('legacy-name').focus();
}

function hideAddLegacyForm() {
  document.getElementById('add-legacy-form').classList.add('hidden');
  document.getElementById('legacy-name').value = '';
  document.getElementById('legacy-manager').value = '';
  document.getElementById('legacy-workload').value = '';
  document.getElementById('legacy-user').value = '';
  document.getElementById('legacy-password').value = '';
}

async function addLegacyCluster() {
  const name = document.getElementById('legacy-name').value.trim();
  const managementUrl = document.getElementById('legacy-manager').value.trim();
  const workloadUrl = document.getElementById('legacy-workload').value.trim();
  const user = document.getElementById('legacy-user').value.trim();
  const password = document.getElementById('legacy-password').value;

  if (!name || !managementUrl || !workloadUrl || !user || !password) {
    alert('All fields are required');
    return;
  }

  const btn = document.getElementById('save-legacy-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Adding...';

  try {
    await api('/api/clusters', {
      method: 'POST',
      body: JSON.stringify({ name, type: 'legacy', managementUrl, workloadUrl, user, password })
    });
    hideAddLegacyForm();
    await refreshClusters();
  } catch (e) {
    alert(`Add failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

// ── Demo Page ──
async function loadDemoPage() {
  clusters = await api('/api/clusters');
  const pxClusters = clusters
    .filter(c => (c.assignedRoles || []).includes('portworx')
             && !(c.assignedRoles || []).includes('acm'))
    .sort((a, b) => (a.lbPosition || 999) - (b.lbPosition || 999));

  const chainEl = document.getElementById('demo-drp-chain');
  if (pxClusters.length < 2) {
    chainEl.innerHTML = '<span style="color:var(--text-muted)">Need at least 2 Portworx-role clusters to form a DR chain.</span>';
    document.getElementById('demo-create-drps-btn').disabled = true;
    document.getElementById('demo-delete-drps-btn').disabled = true;
    document.getElementById('demo-pg-buttons').innerHTML = '';
    return;
  }

  const pairs = [];
  for (let i = 0; i < pxClusters.length; i++) {
    const src = pxClusters[i].name;
    const dst = pxClusters[(i + 1) % pxClusters.length].name;
    const num = String(i + 1).padStart(2, '0');
    pairs.push({ name: `${num}-${src}-${dst}`, src, dst });
  }

  let chainHtml = '';
  for (let i = 0; i < pxClusters.length; i++) {
    chainHtml += `<span class="demo-chain-cluster">${pxClusters[i].name}</span>`;
    chainHtml += '<span class="demo-chain-arrow">&rarr;</span>';
  }
  chainHtml += `<span class="demo-chain-cluster">${pxClusters[0].name}</span>`;
  chainEl.innerHTML = chainHtml;

  document.getElementById('demo-create-drps-btn').disabled = false;
  document.getElementById('demo-delete-drps-btn').disabled = false;

  const pgHtml = pairs.map((p, i) => `
    <div class="demo-pg-btn-row">
      <span class="demo-pg-label">${String(i + 1).padStart(2, '0')} — ${p.src} &rarr; ${p.dst}</span>
      <span id="demo-pg-status-${p.name}" class="status-badge unknown">Unknown</span>
      <button class="btn btn-accent btn-sm" onclick="createProtectionGroup('${p.name}')">Create PG</button>
      <button class="btn btn-danger btn-sm" onclick="deleteProtectionGroup('${p.name}')">Delete</button>
    </div>
  `).join('');
  document.getElementById('demo-pg-buttons').innerHTML = pgHtml;

  const prepareTarget = document.getElementById('demo-prepare-onprem-target');
  if (prepareTarget) {
    const lastCluster = pxClusters[pxClusters.length - 1]?.name || 'unknown';
    prepareTarget.innerHTML = `<p style="color:var(--text-muted)">Target: <strong>${lastCluster}</strong></p>`;
  }

  await refreshDrpStatus();
}

async function refreshDrpStatus() {
  const statusEl = document.getElementById('demo-drp-status');
  try {
    const drpStatus = await api('/api/demo/drp-status');
    if (drpStatus.pairs.length === 0) {
      statusEl.innerHTML = '<div class="demo-drp-status-row"><span style="color:var(--text-muted)">No DRPs created yet.</span></div>';
    } else {
      statusEl.innerHTML = drpStatus.pairs.map(p => {
        const cls = p.ready ? 'installed' : 'installing';
        const label = p.ready ? 'Ready' : (p.status || 'Pending');
        return `<div class="demo-drp-status-row">
          <span>${p.name}</span>
          <span class="status-badge ${cls}">${label}</span>
        </div>`;
      }).join('');
    }

    document.querySelectorAll('[id^="demo-pg-status-"]').forEach(el => {
      el.className = 'status-badge unknown';
      el.textContent = 'No PG';
    });
    for (const pg of drpStatus.protectionGroups || []) {
      const el = document.getElementById(`demo-pg-status-${pg.drpRef}`);
      if (el) {
        const cls = pg.state === 'Active' ? 'installed' : 'installing';
        el.className = `status-badge ${cls}`;
        el.textContent = pg.state || 'Pending';
      }
    }
  } catch (e) {
    statusEl.innerHTML = `<div class="demo-drp-status-row" style="color:var(--red)">${e.message}</div>`;
  }
}

async function createDrps() {
  const btn = document.getElementById('demo-create-drps-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner small"></span>Creating...';
  try {
    await api('/api/demo/create-drps', { method: 'POST' });
    addLogEntry({ type: 'demo', action: 'Disaster Recovery Pairs created', status: 'success' });
    await refreshDrpStatus();
  } catch (e) {
    alert(`Failed to create DRPs: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create DRPs';
  }
}

async function deleteDrps() {
  if (!confirm('Delete ALL Disaster Recovery Pairs and their Protection Groups?')) return;
  const btn = document.getElementById('demo-delete-drps-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    await api('/api/demo/delete-drps', { method: 'DELETE' });
    addLogEntry({ type: 'demo', action: 'Disaster Recovery Pairs deleted', status: 'success' });
    await refreshDrpStatus();
  } catch (e) {
    alert(`Failed to delete DRPs: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete All DRPs';
  }
}

async function createProtectionGroup(pairName) {
  const statusEl = document.getElementById(`demo-pg-status-${pairName}`);
  if (statusEl) { statusEl.className = 'status-badge installing'; statusEl.textContent = 'Creating...'; }
  try {
    await api(`/api/demo/create-pg/${pairName}`, { method: 'POST' });
    addLogEntry({ type: 'demo', action: `Protection Group for ${pairName} created`, status: 'success' });
    await refreshDrpStatus();
  } catch (e) {
    alert(`Failed to create PG: ${e.message}`);
    if (statusEl) { statusEl.className = 'status-badge error'; statusEl.textContent = 'Error'; }
  }
}

async function deleteProtectionGroup(pairName) {
  const statusEl = document.getElementById(`demo-pg-status-${pairName}`);
  if (statusEl) { statusEl.className = 'status-badge installing'; statusEl.textContent = 'Deleting...'; }
  try {
    await api(`/api/demo/delete-pg/${pairName}`, { method: 'DELETE' });
    addLogEntry({ type: 'demo', action: `Protection Group for ${pairName} deleted`, status: 'success' });
    await refreshDrpStatus();
  } catch (e) {
    alert(`Failed to delete PG: ${e.message}`);
    if (statusEl) { statusEl.className = 'status-badge error'; statusEl.textContent = 'Error'; }
  }
}

async function auditDr() {
  const btn = document.getElementById('demo-audit-btn');
  const resultsEl = document.getElementById('demo-audit-results');
  btn.disabled = true;
  btn.textContent = 'Auditing...';
  resultsEl.innerHTML = '';
  try {
    const data = await api('/api/demo/dr-audit');
    let html = `<p style="margin:0.5rem 0"><strong>${data.liveDrpCount}</strong> live DRP(s), <strong>${data.livePgCount || 0}</strong> live PG(s) on hub</p>`;
    const clusterNames = Object.keys(data.orphans);
    if (clusterNames.length === 0) {
      html += '<p style="color:var(--green);margin:0.25rem 0">No orphans found</p>';
    } else {
      for (const name of clusterNames) {
        html += `<p style="margin:0.5rem 0 0.25rem"><strong>${name}</strong> — ${data.orphans[name].length} orphan(s):</p><ul style="margin:0;padding-left:1.5rem">`;
        for (const o of data.orphans[name]) {
          html += `<li><code>${o.kind}/${o.name}</code> <span style="opacity:0.6">(${o.namespace})</span></li>`;
        }
        html += '</ul>';
      }
    }
    resultsEl.innerHTML = html;
  } catch (e) {
    resultsEl.innerHTML = `<p style="color:var(--red)">Audit failed: ${e.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Audit';
  }
}

async function prepareOnPrem() {
  const pxClusters = clusters
    .filter(c => (c.assignedRoles || []).includes('portworx')
             && !(c.assignedRoles || []).includes('acm'))
    .sort((a, b) => (a.lbPosition || 999) - (b.lbPosition || 999));
  const target = pxClusters[pxClusters.length - 1]?.name || 'on-prem';
  if (!confirm(`This will delete the portable-workload namespace on ${target}. Continue?`)) return;
  const btn = document.getElementById('demo-prepare-onprem-btn');
  const statusEl = document.getElementById('demo-prepare-onprem-status');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  statusEl.innerHTML = '<p>Deleting namespace...</p>';
  try {
    const data = await api('/api/demo/prepare-onprem', { method: 'POST' });
    statusEl.innerHTML = `<p style="color:var(--green)">${data.result}</p>`;
    addLogEntry({ type: 'demo', action: data.result, status: 'success' });
  } catch (e) {
    statusEl.innerHTML = `<p style="color:var(--red)">Failed: ${e.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete Namespace';
  }
}

async function deepCleanDr() {
  if (!confirm('This will delete ALL DRPs, PGs, and orphaned DR artifacts from the hub and all spoke clusters. Continue?')) return;
  const btn = document.getElementById('demo-deep-clean-btn');
  const resultsEl = document.getElementById('demo-audit-results');
  btn.disabled = true;
  btn.textContent = 'Cleaning...';
  resultsEl.innerHTML = '<p>Deep clean in progress — check the activity log for details...</p>';
  try {
    const data = await api('/api/demo/dr-deep-clean', { method: 'POST' });
    resultsEl.innerHTML = `<p style="color:var(--green)">Deep clean complete. ${data.drpsDeleted} DRP(s), ${data.pgsDeleted} PG(s) removed from hub. ${data.orphansCleaned} orphan(s) cleaned from spokes.</p>`;
    addLogEntry({ type: 'demo', action: 'Deep clean complete', status: 'success' });
    await loadDemoPage();
  } catch (e) {
    resultsEl.innerHTML = `<p style="color:var(--red)">Deep clean failed: ${e.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Deep Clean All';
  }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('home-btn').onclick = showOverview;
  document.getElementById('demo-btn').onclick = showDemo;
  document.getElementById('demo-create-drps-btn').onclick = createDrps;
  document.getElementById('demo-delete-drps-btn').onclick = deleteDrps;
  document.getElementById('demo-prepare-onprem-btn').onclick = prepareOnPrem;
  document.getElementById('demo-audit-btn').onclick = auditDr;
  document.getElementById('demo-deep-clean-btn').onclick = deepCleanDr;

  document.querySelectorAll('.main-tab').forEach(t => {
    t.onclick = () => switchMainTab(t.dataset.tab);
  });

  document.getElementById('add-ocp-btn').onclick = showAddOcpForm;
  document.getElementById('save-ocp-btn').onclick = addOcpCluster;
  document.getElementById('cancel-ocp-btn').onclick = hideAddOcpForm;
  document.getElementById('add-legacy-btn').onclick = showAddLegacyForm;
  document.getElementById('save-legacy-btn').onclick = addLegacyCluster;
  document.getElementById('cancel-legacy-btn').onclick = hideAddLegacyForm;

  document.getElementById('build-lb-btn').onclick = buildLoadbalancer;
  document.getElementById('onboard-acm-btn').onclick = onboardToAcm;
  document.getElementById('s3-config-btn').onclick = showS3Config;
  document.getElementById('save-s3-btn').onclick = saveS3Config;
  document.getElementById('cancel-s3-btn').onclick = () => document.getElementById('s3-config-form').classList.add('hidden');
  document.getElementById('px-license-btn').onclick = showPxLicenseConfig;
  document.getElementById('save-px-btn').onclick = savePxLicenseKey;
  document.getElementById('cancel-px-btn').onclick = () => document.getElementById('px-license-form').classList.add('hidden');

  document.getElementById('refresh-pipelines-btn').onclick = () => {
    if (activeTab === 'build-assets') updateBuildAssetsTab();
  };

  document.getElementById('scan-btn').onclick = scanCluster;
  document.getElementById('edit-save-btn').onclick = saveEditCluster;
  document.getElementById('edit-cancel-btn').onclick = () =>
    document.getElementById('edit-cluster-modal').classList.add('hidden');

  document.getElementById('op-apply-sc-btn').onclick = applyStorageCluster;
  document.getElementById('op-delete-sc-btn').onclick = deleteStorageCluster;
  document.getElementById('px-refresh-btn').onclick = renderPortworxStatus;
  document.getElementById('op-apply-license-btn').onclick = applyPxLicense;
  document.getElementById('save-px-creds-btn').onclick = savePxCredentials;
  document.getElementById('px-aws-override-btn').onclick = () => {
    document.getElementById('px-aws-static-fields').classList.toggle('hidden');
  };

  connectSSE();
  (async () => {
    availableRoles = await api('/api/roles');
    try {
      lbTrigger = await api('/api/lb-trigger');
    } catch (e) {
      console.error('Failed to fetch lb-trigger:', e.message);
    }
    await refreshClusters();
    updateConfigButtons();
    const saved = localStorage.getItem('selectedCluster');
    if (saved && clusters.find(c => c.name === saved)) {
      selectCluster(saved);
    } else {
      showOverview();
    }
  })();
});
