const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const routes = new Map();
const app = { use() {}, listen(_port, _host, cb) { cb(); } };
for (const method of ['get', 'post', 'delete']) app[method] = (url, fn) => routes.set(`${method} ${url}`, fn);
const express = () => app;
express.json = express.static = () => () => {};
const filename = path.resolve(__dirname, '../02_workload/server.js');
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  require: name => name === 'express' ? express : require(name),
  process: { argv: ['node', filename, '--dev'], env: {} },
  __dirname: path.dirname(filename), console, setTimeout,
}, { filename });
async function request(method, url, body = {}, params = {}) {
  const response = { code: 200, status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; }, send() {} };
  await routes.get(`${method} ${url}`)({ body, params }, response);
  return response;
}
(async () => {
  assert.equal((await request('get', '/health')).body.status, 'ok');
  assert.equal((await request('get', '/api/stops')).body.length, 4);
  assert.equal((await request('post', '/api/stops', { name: '' })).code, 400);
  assert.equal((await request('post', '/api/stops', { name: 'test', x: 'invalid', y: 3 })).code, 400);
  const created = await request('post', '/api/stops', { name: ' Generic cloud ', x: -10, y: 110 });
  assert.equal(created.code, 201);
  assert.equal(created.body.name, 'Generic cloud');
  assert.equal(created.body.x, 2);
  assert.equal(created.body.y, 95);
  assert.equal(created.body.url, (await request('get', '/api/infra')).body.platform);
  assert.equal((await request('delete', '/api/stops/:id', {}, { id: created.body.id })).code, 204);
  assert.equal((await request('delete', '/api/stops/:id', {}, { id: created.body.id })).code, 404);
  assert.equal((await request('get', '/api/stops')).body.length, 4);
  console.log('PASS: dev startup, health, detection, validation, create/clamp, delete and missing stop');
})().catch(error => { console.error(error); process.exitCode = 1; });
