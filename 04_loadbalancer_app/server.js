#!/usr/bin/env node
'use strict';

/*
 * FAUX APPLICATION LOAD BALANCER
 * ------------------------------------------------------------------
 * Zero dependencies. Node 18+.
 *
 *   node server.js
 *
 * Control plane (dashboard hostname or localhost):
 *   GET  /                     the big-screen dashboard
 *   GET  /go                   iframe pointing at active node's url
 *   GET  /api/state            JSON: { title, nodes, active }
 *   GET  /api/events           Server-Sent Events stream (live updates)
 *   POST /api/activate         body {position} or {name}  -> switch live
 *   GET  /api/activate?position=2   same, convenient for curl/browser
 *   GET  /api/reload           re-read config.yaml on demand
 *
 * Data plane (when Host matches config.domain):
 *   All requests reverse-proxied to the active backend.
 *
 * On OpenShift two Routes serve the same pod:
 *   dashboard.<domain>  ->  control plane
 *   <domain>            ->  data plane
 *
 * Config is config.yaml; the file is watched, so saving it pushes a
 * live update to every connected screen (add a node => new icon).
 *
 * Env: PORT (default 8080), HOST (default 0.0.0.0)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const CONFIG_PATH = path.isAbsolute(process.env.CONFIG || '')
  ? process.env.CONFIG
  : path.join(ROOT, process.env.CONFIG || 'config.yaml');
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ── tiny YAML parser (handles the constrained schema in config.yaml) ──
// Supports: top-level "key: value" scalars, and "key:" followed by a
// list of "- " items whose indented "key: value" lines become an object.
function parseYaml(text) {
  const root = {};
  let listKey = null;
  let item = null;

  const stripComment = (line) => {
    if (line.trimStart().startsWith('#')) return '';
    // strip " #..." but leave URL fragments (which have no leading space)
    return line.replace(/\s+#.*$/, '');
  };
  const unquote = (v) => {
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  };
  const coerce = (v) => {
    if (v === '') return '';
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  };
  const splitKV = (s) => {
    const i = s.indexOf(':');
    if (i === -1) return { k: s.trim(), v: '' };
    return { k: s.slice(0, i).trim(), v: coerce(unquote(s.slice(i + 1))) };
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (content.startsWith('- ')) {
      item = {};
      if (!root[listKey]) root[listKey] = [];
      root[listKey].push(item);
      const rest = content.slice(2).trim();
      if (rest) {
        const { k, v } = splitKV(rest);
        item[k] = v;
      }
    } else if (indent === 0) {
      const { k, v } = splitKV(content);
      if (v === '') { listKey = k; item = null; }
      else { root[k] = v; listKey = null; item = null; }
    } else if (item) {
      const { k, v } = splitKV(content);
      item[k] = v;
    }
  }
  return root;
}

// ── config state ──
let config = { title: 'Application LB', domain: '', nodes: [], initialActive: 1 };
let active = 1;

function loadConfig(setActive) {
  try {
    const parsed = parseYaml(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const nodes = (parsed.nodes || [])
      .filter((n) => n && n.name)
      .map((n) => ({
        name: String(n.name),
        position: parseInt(n.position, 10) || 0,
        icon: (n.icon || 'cloud').toLowerCase(),
        url: String(n.url || ''),
      }))
      .sort((a, b) => a.position - b.position);
    config = {
      title: parsed.title || 'Application LB',
      domain: parsed.domain || '',
      initialActive: parseInt(parsed.initialActive, 10) || (nodes[0] && nodes[0].position) || 1,
      nodes,
    };
    if (setActive) active = config.initialActive;
    // keep active valid if a node was removed
    if (!config.nodes.some((n) => n.position === active)) {
      active = config.nodes[0] ? config.nodes[0].position : 1;
    }
    console.log(`[config] loaded ${config.nodes.length} node(s); active=${active}`);
    return true;
  } catch (err) {
    console.error('[config] failed to load:', err.message);
    return false;
  }
}
loadConfig(true);

let healthStatuses = {}; // position -> 'healthy' | 'offline'

async function checkHealth() {
  for (const node of config.nodes) {
    if (!node.url) {
      if (healthStatuses[node.position]) {
        delete healthStatuses[node.position];
        broadcast('health', { position: node.position, status: 'unknown' });
      }
      continue;
    }
    try {
      const statusCode = await new Promise((resolve, reject) => {
        const mod = node.url.startsWith('https') ? https : http;
        const req = mod.get(node.url, { rejectUnauthorized: false, timeout: 3500 }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });

      const isOffline = statusCode >= 500;
      const newStatus = isOffline ? 'offline' : 'healthy';
      
      if (healthStatuses[node.position] !== newStatus) {
        healthStatuses[node.position] = newStatus;
        broadcast('health', { position: node.position, status: newStatus });
      }
    } catch (err) {
      console.log(`[health] Node ${node.position} offline: ${err.message}`);
      if (healthStatuses[node.position] !== 'offline') {
        healthStatuses[node.position] = 'offline';
        broadcast('health', { position: node.position, status: 'offline' });
      }
    }
  }
}

// Start the health loop
setInterval(checkHealth, 5000);
// Check immediately after startup
setTimeout(checkHealth, 1000);

const initialNode = nodeByPosition(active);
if (initialNode) {
  console.log(`[proxy] initial backend: ${initialNode.url}`);
}

function nodeByPosition(pos) {
  return config.nodes.find((n) => n.position === pos);
}
function state() {
  return { title: config.title, domain: config.domain, nodes: config.nodes, active, health: healthStatuses };
}

// ── SSE plumbing ──
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function setActive(target, source) {
  let node = null;
  if (typeof target === 'number') node = nodeByPosition(target);
  else if (target != null) {
    node = config.nodes.find(
      (n) => n.name.toLowerCase() === String(target).toLowerCase()
    );
  }
  if (!node) return null;
  active = node.position;
  console.log(`[switch] -> #${node.position} ${node.name} (${source})`);
  broadcast('activate', { active, source });
  return node;
}

// live-reload on config save (debounced)
let reloadTimer = null;
try {
  fs.watch(CONFIG_PATH, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (loadConfig(false)) broadcast('config', state());
    }, 200);
  });
} catch (e) {
  console.warn('[config] watch unavailable:', e.message);
}

// ── http helpers ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(buf));
  });
}

// ── reverse proxy (data plane) ──
function proxyRequest(clientReq, clientRes, targetUrl) {
  const target = new URL(targetUrl);
  const mod = target.protocol === 'https:' ? https : http;
  const proxyReq = mod.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: target.hostname,
      'x-real-ip': clientReq.socket.remoteAddress,
      'x-forwarded-for': clientReq.headers['x-forwarded-for'] || clientReq.socket.remoteAddress,
      'x-forwarded-proto': clientReq.headers['x-forwarded-proto'] || 'https',
    },
    rejectUnauthorized: false,
  }, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });
  proxyReq.on('error', (err) => {
    console.error(`[proxy] ${err.message}`);
    if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end('Bad Gateway'); }
  });
  clientReq.pipe(proxyReq);
}

// ── server ──
const dashboardHandler = async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  // CORS preflight (so a cluster hook can POST cross-origin if needed)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (p === '/' || p === '/index.html' || p === '/dashboard.html') {
    return serveFile(res, path.join(ROOT, 'dashboard.html'));
  }

  if (p === '/api/state') {
    return sendJson(res, 200, state());
  }

  if (p === '/api/reload') {
    loadConfig(false);
    broadcast('config', state());
    return sendJson(res, 200, { ok: true, ...state() });
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });
    res.write(`retry: 2000\n`);
    res.write(`event: config\ndata: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  if (p === '/api/activate') {
    let target = null;
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const j = JSON.parse(body || '{}');
        target = j.position != null ? parseInt(j.position, 10) : j.name;
      } catch { /* fall through to query */ }
    }
    if (target == null) {
      const qp = u.searchParams.get('position');
      const qn = u.searchParams.get('name');
      target = qp != null ? parseInt(qp, 10) : qn;
    }
    const node = setActive(target, req.method === 'POST' ? 'webhook' : 'manual');
    if (!node) return sendJson(res, 400, { ok: false, error: 'unknown node', target });
    return sendJson(res, 200, { ok: true, active, node });
  }

  if (p === '/go') {
    const qp = u.searchParams.get('position');
    const node = qp != null ? nodeByPosition(parseInt(qp, 10)) : nodeByPosition(active);
    if (!node || !node.url) { res.writeHead(503); return res.end('no active target'); }
    const domain = config.domain || req.headers.host || 'localhost';
    const page = '<!doctype html><html><head><meta charset="utf-8">'
      + '<title>' + domain + '</title>'
      + '<style>*{margin:0;padding:0}iframe{position:fixed;inset:0;width:100%;height:100%;border:none}</style>'
      + '</head><body><iframe src="' + node.url + '"></iframe></body></html>';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(page);
  }

  res.writeHead(404);
  res.end('not found');
};

const handler = (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (config.domain && host === config.domain && !host.startsWith('dashboard.')) {
    const node = nodeByPosition(active);
    if (!node || !node.url) { res.writeHead(503); return res.end('No active backend'); }
    return proxyRequest(req, res, node.url);
  }
  return dashboardHandler(req, res);
};

const server = http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`\n  Application LB dashboard`);
  console.log(`  ─────────────────────────────`);
  console.log(`  dashboard : http://localhost:${PORT}/`);
  console.log(`  redirect  : http://localhost:${PORT}/go`);
  console.log(`  webhook   : POST http://<laptop-ip>:${PORT}/api/activate  {"position":2}`);
  console.log(`  listening : ${HOST}:${PORT}\n`);
});
