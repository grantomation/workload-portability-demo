#!/usr/bin/env node
'use strict';

/*
 * Smoke test harness — boots server.js (with the demo config) on a
 * throwaway port and asserts the real behaviour end to end:
 *   - config loads, nodes parsed & sorted
 *   - /api/state shape
 *   - /api/activate switches the active target
 *   - /go issues a 302 to the active node's url (http + https both fine)
 *   - SSE pushes an "activate" event to connected screens
 *   - bad input is rejected
 *
 * Zero dependencies.   node test/harness.js
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8731;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, e) => { failed++; console.log(`  \x1b[31m✗ ${m}\x1b[0m${e ? '  — ' + e : ''}`); };
function assert(cond, m, extra) { cond ? ok(m) : bad(m, extra); }

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, {
      method, headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const json = (r) => JSON.parse(r.body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// collect SSE events in the background
function sseCollector() {
  const events = [];
  const r = http.get(BASE + '/api/events', (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = (chunk.match(/event: (.*)/) || [])[1];
        const dl = (chunk.match(/data: (.*)/) || [])[1];
        if (ev) events.push({ event: ev, data: dl ? JSON.parse(dl) : null });
      }
    });
  });
  return { events, close: () => r.destroy() };
}

async function waitUp(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { await req('GET', '/api/state'); return true; } catch { await sleep(100); }
  }
  return false;
}

(async () => {
  console.log('\n  FAUX APPLICATION LB — smoke test\n  ---------------------------------');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CONFIG: 'test/config.test.yaml' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let code = 1;
  try {
    if (!(await waitUp())) throw new Error('server did not start');

    // state shape
    const s = json(await req('GET', '/api/state'));
    assert(Array.isArray(s.nodes) && s.nodes.length === 4, 'state returns 4 nodes',
      `got ${s.nodes && s.nodes.length}`);
    assert(s.nodes[0].position === 1 && s.nodes[3].position === 4, 'nodes sorted by position');
    assert(s.active === 1, 'initial active is position 1', `got ${s.active}`);
    assert(s.nodes[0].icon === 'vm' && s.nodes[3].icon === 'baremetal', 'icons parsed');

    // SSE should receive switches
    const sse = sseCollector();
    await sleep(150);

    // switch via webhook (POST)
    const a = json(await req('POST', '/api/activate', { position: 3 }));
    assert(a.ok && a.active === 3, 'POST /api/activate switches to 3', JSON.stringify(a));
    assert(json(await req('GET', '/api/state')).active === 3, 'state reflects active=3');

    // switch via GET (manual/browser)
    const b = json(await req('GET', '/api/activate?position=2'));
    assert(b.ok && b.active === 2, 'GET /api/activate?position=2 switches to 2');

    // switch by name
    const c = json(await req('POST', '/api/activate', { name: 'OpenShift Cluster B' }));
    assert(c.ok && c.active === 3, 'activate by name works');

    // /go serves an iframe page pointing at the active backend
    const g = await req('GET', '/go');
    assert(g.status === 200, '/go returns 200 with iframe page', `status ${g.status}`);
    assert(g.body.includes('localhost:9090/3'), '/go iframe points at active target',
      g.body.slice(0, 200));

    const g2 = await req('GET', '/go?position=1');
    assert(g2.status === 200 && g2.body.includes('localhost:9090/1'),
      '/go?position=1 targets a specific node');

    // bad input
    const e = await req('GET', '/api/activate?position=99');
    assert(e.status === 400, 'unknown node rejected with 400', `status ${e.status}`);

    // SSE delivery
    await sleep(200);
    sse.close();
    const acts = sse.events.filter((x) => x.event === 'activate');
    assert(acts.length >= 3, 'SSE pushed activate events to screens', `got ${acts.length}`);
    assert(sse.events.some((x) => x.event === 'config'), 'SSE sends initial config snapshot');

    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    code = failed === 0 ? 0 : 1;
  } catch (err) {
    console.log(`\n  \x1b[31mHARNESS ERROR: ${err.message}\x1b[0m\n`);
    code = 1;
  } finally {
    srv.kill('SIGTERM');
    setTimeout(() => process.exit(code), 150);
  }
})();
