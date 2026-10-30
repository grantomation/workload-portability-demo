const { getCluster } = require('./cluster');
const config = require('./config');

const cfg = config.get();

const ROLES = {};
for (const [key, role] of Object.entries(cfg.roles)) {
  ROLES[key] = {
    name: role.name,
    description: role.description,
    operators: role.operators,
    ...(role.extras ? { extras: role.extras } : {}),
    ...(role.hubManaged ? { hubManaged: role.hubManaged } : {})
  };
}

const OPERATOR_RESOURCES = {};
for (const [key, op] of Object.entries(cfg.operators)) {
  OPERATOR_RESOURCES[key] = {
    cpuCores: op.resources?.cpu || 0,
    memoryGi: op.resources?.memory || 0
  };
}

function getRoleOperators(roleKeys) {
  const ops = new Set();
  for (const key of roleKeys) {
    const role = ROLES[key];
    if (role) role.operators.forEach(op => ops.add(op));
  }
  return [...ops];
}

function estimateResources(operatorKeys) {
  let cpuCores = 0;
  let memoryGi = 0;
  for (const key of operatorKeys) {
    const r = OPERATOR_RESOURCES[key];
    if (r) {
      cpuCores += r.cpuCores;
      memoryGi += r.memoryGi;
    }
  }
  return { cpuCores, memoryGi };
}

function parseCpu(cpuStr) {
  if (!cpuStr) return 0;
  if (cpuStr.endsWith('m')) return parseInt(cpuStr, 10) / 1000;
  return parseFloat(cpuStr) || 0;
}

function parseMemoryGi(memStr) {
  if (!memStr) return 0;
  const match = memStr.match(/^(\d+)(\w+)?$/);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'ki') return val / (1024 * 1024);
  if (unit === 'mi') return val / 1024;
  if (unit === 'gi') return val;
  return val / (1024 * 1024 * 1024);
}

function getClusterCapacity(clusterName) {
  const c = getCluster(clusterName);
  if (!c || !c.nodes) return null;

  const workers = c.nodes.filter(n =>
    n.roles && n.roles.includes('worker')
  );

  let totalCpu = 0;
  let totalMemGi = 0;
  for (const node of workers) {
    totalCpu += parseCpu(node.allocatableCpu || '0');
    totalMemGi += parseMemoryGi(node.allocatableMemory || '0');
  }

  const assignedRoles = c.assignedRoles || [];
  const assignedOps = getRoleOperators(assignedRoles);
  const used = estimateResources(assignedOps);

  return {
    workerCount: workers.length,
    totalCpu: Math.round(totalCpu * 10) / 10,
    totalMemGi: Math.round(totalMemGi * 10) / 10,
    usedCpu: used.cpuCores,
    usedMemGi: used.memoryGi,
    availableCpu: Math.round((totalCpu - used.cpuCores) * 10) / 10,
    availableMemGi: Math.round((totalMemGi - used.memoryGi) * 10) / 10,
    assignedRoles
  };
}

function canAssignRole(clusterName, roleKey) {
  const role = ROLES[roleKey];
  if (!role) return { ok: false, message: `Unknown role: ${roleKey}` };

  const c = getCluster(clusterName);
  if (!c) return { ok: false, message: `Unknown cluster: ${clusterName}` };

  const capacity = getClusterCapacity(clusterName);
  if (!capacity) return { ok: false, message: 'No node data available. Run Test first.' };

  if ((c.assignedRoles || []).includes(roleKey)) {
    return { ok: true, message: 'Role already assigned', alreadyAssigned: true };
  }

  if (roleKey === 'mtv') {
    const allClusters = Object.values(require('./cluster').listClusters());
    const hasBuild = allClusters.some(cl => (cl.assignedRoles || []).includes('build'));
    if (!hasBuild) {
      return { ok: false, message: 'MTV requires a Build cluster. Assign the Build role to a cluster first.' };
    }
  }

  const currentOps = getRoleOperators(c.assignedRoles || []);
  const newOps = role.operators.filter(op => !currentOps.includes(op));
  const additionalCost = estimateResources(newOps);

  if (additionalCost.cpuCores > capacity.availableCpu ||
      additionalCost.memoryGi > capacity.availableMemGi) {
    return {
      ok: false,
      message: `Insufficient capacity. Needs ${additionalCost.cpuCores} CPU / ${additionalCost.memoryGi}Gi RAM but only ${capacity.availableCpu} CPU / ${capacity.availableMemGi}Gi available.`,
      additionalCost,
      capacity
    };
  }

  return {
    ok: true,
    message: `${newOps.length} new operator(s) to install: ${newOps.join(', ')}`,
    newOperators: newOps,
    additionalCost
  };
}

module.exports = {
  ROLES,
  OPERATOR_RESOURCES,
  getRoleOperators,
  estimateResources,
  getClusterCapacity,
  canAssignRole
};
