const fs = require('fs');
const path = require('path');
const { YAML_DIR, getConfig: getDashboardConfig, getLegacyCluster } = require('./cluster');
const config = require('./config');

const OPERATORS_DIR = path.resolve(__dirname, '../../operators');

function resolveTemplateVars(content, vars) {
  let hasUnresolved = false;
  const resolved = content.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, varPath) => {
    const keys = varPath.split('.');
    let val = vars;
    for (const k of keys) {
      if (val == null) { hasUnresolved = true; return match; }
      val = val[k];
    }
    if (val == null || val === '') { hasUnresolved = true; return match; }
    return String(val);
  });
  return { resolved, hasUnresolved };
}

function loadOperatorFiles(operatorKey) {
  const dir = path.join(OPERATORS_DIR, operatorKey);
  if (!fs.existsSync(dir)) return [];
  const legacyCluster = getLegacyCluster();
  const vars = { config: { ...config.get(), ...getDashboardConfig() }, legacy: legacyCluster || {} };
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map(f => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      const { resolved, hasUnresolved } = resolveTemplateVars(raw, vars);
      return { filename: f, content: resolved, skipped: hasUnresolved };
    })
    .filter(f => !f.skipped);
}

const cfg = config.get();
const OPERATORS = {};
for (const [key, op] of Object.entries(cfg.operators)) {
  OPERATORS[key] = {
    name: op.name,
    namespace: op.namespace,
    manifests: () => loadOperatorFiles(key)
  };
}

function generateAndSave(clusterName, operatorKey) {
  const op = OPERATORS[operatorKey];
  if (!op) throw new Error(`Unknown operator: ${operatorKey}`);
  if (!op.manifests) throw new Error(`${op.name} is not yet available for automated install`);

  const manifests = op.manifests();
  const dir = path.join(YAML_DIR, clusterName, operatorKey);
  fs.mkdirSync(dir, { recursive: true });

  for (const m of manifests) {
    fs.writeFileSync(path.join(dir, m.filename), m.content + '\n');
  }

  return manifests.map(m => m.filename);
}

function listYamlFiles(clusterName, operatorKey) {
  const dir = path.join(YAML_DIR, clusterName, operatorKey);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort();
}

function readYamlFile(clusterName, operatorKey, filename) {
  const file = path.join(YAML_DIR, clusterName, operatorKey, filename);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${filename}`);
  return fs.readFileSync(file, 'utf8');
}

function writeYamlFile(clusterName, operatorKey, filename, content) {
  const dir = path.join(YAML_DIR, clusterName, operatorKey);
  const file = path.join(dir, filename);
  if (!fs.existsSync(dir)) throw new Error(`No YAML generated yet for ${operatorKey} on ${clusterName}`);
  fs.writeFileSync(file, content);
}

function parseYamlDocuments(content) {
  return content.split(/^---\s*$/m).map(s => s.trim()).filter(Boolean);
}

function deleteYamlFiles(clusterName, operatorKey) {
  const dir = path.join(YAML_DIR, clusterName, operatorKey);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loadDrTemplate(filename, extraVars) {
  const file = path.join(OPERATORS_DIR, 'dr', filename);
  if (!fs.existsSync(file)) throw new Error(`DR template not found: ${filename}`);
  const raw = fs.readFileSync(file, 'utf8').trim();
  const vars = { config: { ...config.get(), ...getDashboardConfig() }, ...extraVars };
  const { resolved, hasUnresolved } = resolveTemplateVars(raw, vars);
  if (hasUnresolved) throw new Error(`Unresolved placeholders in ${filename}`);
  return resolved;
}

module.exports = {
  OPERATORS,
  OPERATORS_DIR,
  resolveTemplateVars,
  loadDrTemplate,
  generateAndSave,
  listYamlFiles,
  readYamlFile,
  writeYamlFile,
  deleteYamlFiles,
  parseYamlDocuments
};
