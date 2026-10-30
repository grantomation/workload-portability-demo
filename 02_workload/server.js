const express = require('express');
const path = require('path');
const fs = require('fs');

const DEV = process.argv.includes('--dev');
const { Pool } = DEV ? {} : require('pg');

const app = express();
const port = process.env.PORT || 8080;

// Pin colors, cycled by creation order. The SERIAL id is a stable, never-reused
// counter, so PALETTE[(id - 1) % 8] keeps each stop's color fixed across deletes.
const PALETTE = [
  '#e5484d', '#f2820c', '#2fa45a', '#0aa2b0',
  '#3b6ef0', '#8b5cf6', '#d6409f', '#b45309',
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// DB_HOST is a single hostname (e.g. 'pw-backend-svc') resolved by:
//   Legacy Infra:    /etc/hosts (managed by portable-env-detect.service)
//   OpenShift: K8s Service + CoreDNS
//   Combined:  127.0.0.1 (loopback, both tiers on one VM)
const DB_HOSTS = process.env.DB_HOST
  ? [process.env.DB_HOST]
  : ['pw-backend-svc', 'pw-backend-svc.local'];

function infraPlatform() {
  if (!cachedInfra || cachedInfra.source === 'pending') cachedInfra = detectInfra();
  return cachedInfra?.platform || null;
}

const poolConfig = DEV ? {} : {
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'todo',
  password: process.env.DB_PASSWORD || 'todo',
  database: process.env.DB_NAME || 'todo',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

// Set once a connection succeeds, then reused for every query.
let pool;

// In-memory store for --dev mode
const devStops = [
  { id: 1, name: 'Legacy Infra', x: 22, y: 30, color: PALETTE[0], url: 'Legacy Infra', created_at: new Date(Date.now() - 86400000 * 3).toISOString() },
  { id: 2, name: 'Azure OpenShift', x: 45, y: 55, color: PALETTE[1], url: 'Azure Red Hat OpenShift', created_at: new Date(Date.now() - 86400000 * 2).toISOString() },
  { id: 3, name: 'AWS OpenShift', x: 68, y: 35, color: PALETTE[2], url: 'Red Hat OpenShift Service on AWS', created_at: new Date(Date.now() - 86400000).toISOString() },
  { id: 4, name: 'On-Prem AWS', x: 80, y: 70, color: PALETTE[3], url: 'Baremetal', created_at: new Date(Date.now() - 3600000).toISOString() },
];
let devNextId = 5;

function devPool() {
  return {
    query: async (sql, params) => {
      if (sql.startsWith('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM stops ORDER BY')) return { rows: devStops, rowCount: devStops.length };
      if (sql.includes('nextval')) return { rows: [{ id: devNextId++ }] };
      if (sql.includes('INSERT INTO stops')) {
        const [id, name, x, y, color, url] = params;
        const row = { id, name, x, y, color, url, created_at: new Date().toISOString() };
        devStops.push(row);
        return { rows: [row] };
      }
      if (sql.includes('DELETE FROM stops')) {
        const id = params[0];
        const idx = devStops.findIndex(s => s.id === id);
        if (idx === -1) return { rowCount: 0 };
        devStops.splice(idx, 1);
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

async function connectToDatabase(delayMs = 2000) {
  if (DEV) {
    pool = devPool();
    console.log('DEV MODE: using in-memory store with dummy data');
    return;
  }
  for (let attempt = 1; ; attempt += 1) {
    for (const host of DB_HOSTS) {
      const candidate = new Pool({ ...poolConfig, host, connectionTimeoutMillis: 2000 });
      try {
        await candidate.query('SELECT 1');
        pool = candidate;
        console.log(`Connected to PostgreSQL at ${host}`);
        return;
      } catch (error) {
        await candidate.end().catch(() => {});
      }
    }
    console.log(`Waiting for PostgreSQL (attempt ${attempt}, hosts: ${DB_HOSTS.join(', ')})`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

const INFRA_FILE = '/run/portable-infra';
let cachedInfra = null;

function detectInfra() {
  if (DEV) return { platform: 'Red Hat OpenShift Service on AWS', source: 'dev' };
  try {
    return JSON.parse(fs.readFileSync(INFRA_FILE, 'utf8'));
  } catch (_) {
    return { platform: 'Detecting...', source: 'pending' };
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/infra', (_req, res) => {
  if (!cachedInfra || cachedInfra.source === 'pending') cachedInfra = detectInfra();
  res.json(cachedInfra);
});

app.get('/health', async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ status: 'starting', database: 'connecting' });
  }
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'disconnected', message: error.message });
  }
});

app.get('/db', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, x, y, color, url, created_at FROM stops ORDER BY id ASC'
    );
    res.json({ status: 'ok', count: result.rowCount, rows: result.rows });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});

app.get('/api/stops', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, x, y, color, url, created_at FROM stops ORDER BY id ASC'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stops', async (req, res) => {
  const name = req.body.name?.trim();
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const x = Number(req.body.x);
  const y = Number(req.body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: 'x and y must be numbers' });
  }

  // Match the prototype's placement bounds so pins/labels never clip the edges.
  const clampedX = clamp(x, 2, 98);
  const clampedY = clamp(y, 4, 95);

  try {
    // Reserve the id up front so we can derive a stable color before inserting.
    const seq = await pool.query(
      "SELECT nextval(pg_get_serial_sequence('stops', 'id')) AS id"
    );
    const id = Number(seq.rows[0].id);
    const color = PALETTE[(id - 1) % PALETTE.length];

    const result = await pool.query(
      'INSERT INTO stops (id, name, x, y, color, url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, x, y, color, url, created_at',
      [id, name, clampedX, clampedY, color, infraPlatform()]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/stops/:id', async (req, res) => {
  const id = Number(req.params.id);

  try {
    const result = await pool.query('DELETE FROM stops WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Stop not found' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function start() {
  // Listen immediately so the port is always open; /health reports DB status.
  // Connect in the background and retry forever, so the app tolerates the DB or
  // its Service not being ready yet (e.g. right after a migration) and self-heals
  // without ever exiting — startup order stops being a correctness requirement.
  app.listen(port, '0.0.0.0', () => {
    console.log(`Portable Workload listening on port ${port}`);
  });
  connectToDatabase();
}

start();
