#!/usr/bin/env node
'use strict';

/*
 * Dummy "cluster frontends" for the demo / test harness.
 * One process, several fake app pages on a single port:
 *
 *   http://localhost:9090/1   ->  Legacy Infra-style page (orange)
 *   http://localhost:9090/2   ->  OpenShift A      (blue)
 *   http://localhost:9090/3   ->  OpenShift B      (purple)
 *   http://localhost:9090/4   ->  Bare metal       (green)
 *
 * This stands in for the real exposed routes so /go redirects land on
 * something real, with zero Legacy Infra/OpenShift needed.
 *
 *   node test/dummy-targets.js        (PORT env, default 9090)
 */
const http = require('http');
const PORT = parseInt(process.env.DUMMY_PORT || '9090', 10);

const TARGETS = {
  '1': { name: 'Legacy Infra',        sub: 'app.legacy-infra.example.com',    c: '#e8861a' },
  '2': { name: 'OpenShift Cluster A',   sub: 'apps.ocp-a.example.com',          c: '#2a7fff' },
  '3': { name: 'OpenShift Cluster B',   sub: 'apps.ocp-b.example.com',          c: '#9a5cff' },
  '4': { name: 'Bare Metal (on-prem)',  sub: 'apps.ocp-bm.example.com',         c: '#27e08a' },
};

function page(id, t) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${t.name}</title><meta http-equiv="refresh" content="5"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;font-family:Segoe UI,Arial,sans-serif;
  background:radial-gradient(circle at 50% 30%, ${t.c}, #05070d 75%);color:#fff;">
  <div style="font-size:14px;letter-spacing:.4em;opacity:.7">NOW SERVING FROM</div>
  <div style="font-size:64px;font-weight:800;margin:.2em 0">${t.name}</div>
  <div style="font-size:20px;opacity:.85;font-family:monospace">${t.sub}</div>
  <div style="margin-top:2em;font-size:13px;opacity:.5">target #${id} · dummy backend · refreshes every 5s</div>
</body></html>`;
}

http.createServer((req, res) => {
  const id = (req.url.match(/\/(\d+)/) || [])[1];
  const t = TARGETS[id];
  if (!t) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end('<body style="background:#05070d;color:#5d6b85;font-family:sans-serif">'
      + 'dummy targets: try /1 /2 /3 /4</body>');
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(page(id, t));
}).listen(PORT, () => {
  console.log(`[dummy-targets] http://localhost:${PORT}/  -> /1 /2 /3 /4`);
});
