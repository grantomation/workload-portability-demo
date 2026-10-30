// Exercise browser submission -> API handler -> storage -> reload without a cluster.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-environment-'));
function loadClusterModule() {
  const filename = path.join(root, '01_installation_dashboard/app/lib/cluster.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === './config' ? { get: () => ({namespace: 'test-build'}) } : require(name),
    module: mod, process: {env: {DATA_DIR: dataDir}}, Buffer, URL, console, setTimeout,
  }, {filename});
  return mod.exports;
}
(async () => {
  const cluster = loadClusterModule();
  const server = fs.readFileSync(path.join(root, '01_installation_dashboard/app/server.js'), 'utf8');
  const begin = server.indexOf("app.post('/api/clusters',");
  const end = server.indexOf("app.put('/api/clusters/reorder',", begin);
  let handler;
  vm.runInNewContext(server.slice(begin, end), {
    app: {post: (_route, fn) => {handler = fn;}}, cluster, emitEvent() {},
  });
  async function call(body) {
    const response = {code: 200, status(code) {this.code=code;return this;}, json(body) {this.body=body;return this;}};
    await handler({body}, response);
    return response;
  }
  assert.equal((await call({name: 'missing-fields', type: 'legacy'})).code, 400);
  const values = {
    'legacy-name': 'Legacy Test', 'legacy-manager': 'https://manager.example.com',
    'legacy-workload': 'https://workload.example.com', 'legacy-user': 'test-user',
    'legacy-password': 'test-only-password', 'save-legacy-btn': '',
  };
  const elements = Object.fromEntries(Object.entries(values).map(([id,value])=>[id,{value}]));
  const browser = fs.readFileSync(path.join(root, '01_installation_dashboard/app/public/app.js'), 'utf8');
  const start = browser.indexOf('async function addLegacyCluster()');
  const finish = browser.indexOf('// ── Demo Page', start);
  let posted;
  const sandbox = {
    document: {getElementById: id => elements[id]},
    alert: message => {throw new Error(message);}, hideAddLegacyForm() {}, async refreshClusters() {},
    api: async (url, options) => {
      assert.equal(url, '/api/clusters'); assert.equal(options.method, 'POST');
      posted=JSON.parse(options.body);
      const response=await call(posted);
      assert.equal(response.code, 200);
      return response.body;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(browser.slice(start, finish), sandbox);
  await sandbox.addLegacyCluster();
  assert.equal(posted.type, 'legacy');
  assert.equal(posted.managementUrl, values['legacy-manager']);
  assert.equal(cluster.hasLegacyCluster(), true);
  assert.equal(cluster.isLegacyCluster('Legacy Test'), true);
  assert.equal(cluster.isLegacyCluster('missing'), undefined);
  assert.equal(cluster.listClusters()[0].managementUrl, values['legacy-manager']);
  assert.equal(cluster.listClusters()[0].password, undefined);
  assert.equal((await call({...posted, name: 'Duplicate'})).code, 400);
  await cluster.updateCluster('Legacy Test', {managementUrl:'https://updated.example.com'});
  const reloaded=loadClusterModule();
  await reloaded.loadClusters();
  assert.equal(reloaded.getLegacyCluster().managementUrl, 'https://updated.example.com');
  assert.equal(reloaded.listClusters()[0].type, 'legacy');
  assert.equal(reloaded.listClusters()[0].lbPosition, 0);
  console.log('PASS: legacy browser/API contract, validation, persistence, reload, helpers, duplicate prevention and password masking');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
