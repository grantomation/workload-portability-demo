const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const applied = [];
const moduleStub = { exports: {} };
const templates = {
  OPERATORS: { mtv: { name: 'MTV' } },
  generateAndSave: () => ['current.yaml'],
  listYamlFiles: () => ['current.yaml', 'obsolete-provider.yaml'],
  readYamlFile: (_cluster, _operator, filename) => {
    assert.equal(filename, 'current.yaml', 'Must not read obsolete cached provider');
    return 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: openshift-mtv';
  },
  parseYamlDocuments: text => [text],
};
const filename = path.resolve(__dirname, '../01_installation_dashboard/app/lib/operators.js');
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  require: name => {
    if (name === './templates') return templates;
    if (name === './config') return { get: () => ({ operators: {} }) };
    if (name === './cluster') return { apiRequest: async (_cluster, url, options) => { applied.push({url, ...options}); return {ok: true}; } };
    return require(name);
  }, module: moduleStub, console, setTimeout,
}, {filename});
(async () => {
  const results = await moduleStub.exports.installOperator('test', 'mtv');
  assert.equal(applied.length, 1);
  assert.equal(results[0].status, 'applied');
  assert(!applied[0].body.includes('Provider'));
  console.log('PASS: role installation ignores retired cached templates');
})().catch(error => { console.error(error); process.exitCode = 1; });
