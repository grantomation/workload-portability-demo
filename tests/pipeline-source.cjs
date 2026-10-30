const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderSource } = require('../01_installation_dashboard/app/lib/source');
const filename = path.resolve(__dirname, '../01_installation_dashboard/app/lib/pipelines.js');
const source = { SOURCE_REPO_URL: 'https://example.com/team/demo.git', SOURCE_REPO_REVISION: 'abc123' };
const moduleStub = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  require: name => name === './cluster' ? { NAMESPACE: 'workload-portability-build' } :
    name === './source' ? { renderSource: text => renderSource(text, source) } : require(name),
  __dirname: path.dirname(filename), module: moduleStub, console,
});
const manifests = moduleStub.exports.getManifests('workload-portability-build');
assert(manifests.length > 10);
assert(manifests.every(m => !m.content.includes('__SOURCE_REPO_')));
assert(manifests.some(m => m.content.includes(source.SOURCE_REPO_URL)));
assert(manifests.some(m => m.content.includes(source.SOURCE_REPO_REVISION)));
assert.throws(() => renderSource('__SOURCE_REPO_URL__', {}));
assert.throws(() => renderSource('__SOURCE_REPO_URL__', { ...source, SOURCE_REPO_URL: 'https://user:pass@example.com/repo' }));
console.log('PASS: dashboard renders fresh remote templates using deployment configuration');
