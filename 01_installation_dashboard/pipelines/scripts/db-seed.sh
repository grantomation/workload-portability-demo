#!/bin/sh
echo "=== Database Seed: $(date) ==="
rc-service postgresql status >/dev/null 2>&1 || {
    echo "[SEED] PostgreSQL not running, starting..."
    if ! rc-service postgresql start; then
        echo "[FAIL] Could not start PostgreSQL service"
        echo "[FAIL] Check: rc-service postgresql status"
        echo "[FAIL] Check: cat /var/lib/postgresql/17/data/log/*.log"
        exit 1
    fi
    echo "[SEED] PostgreSQL service started"
}
echo "[SEED] Waiting for PostgreSQL to accept connections..."
if ! pg_isready -q -t 60; then
    echo "[FAIL] PostgreSQL not accepting connections after 60 seconds"
    echo "[FAIL] pg_isready output:"
    pg_isready -t 1 2>&1 || true
    echo "[FAIL] Service status:"
    rc-service postgresql status 2>&1 || true
    echo "[FAIL] Listening ports:"
    netstat -tln 2>/dev/null | grep 5432 || echo "  not listening on 5432"
    echo "[FAIL] PostgreSQL log tail:"
    tail -20 /var/lib/postgresql/17/data/log/*.log 2>/dev/null || echo "  no log files found"
    exit 1
fi
echo "[SEED] PostgreSQL is ready"
echo "[SEED] Checking role 'todo'..."
ROLE_EXISTS=$(su - postgres -c "psql -d postgres -tAc \"SELECT 1 FROM pg_roles WHERE rolname='todo'\"" 2>&1) || {
    echo "[FAIL] Could not query pg_roles: ${ROLE_EXISTS}"
    exit 1
}
ROLE_EXISTS=$(echo "${ROLE_EXISTS}" | tr -d ' ')
if [ "${ROLE_EXISTS}" = "1" ]; then
    echo "[SEED] Role 'todo' already exists"
else
    echo "[SEED] Creating role 'todo'..."
    ROLE_OUT=$(su - postgres -c "psql -d postgres -c \"CREATE ROLE todo LOGIN PASSWORD 'todo'\"" 2>&1) || {
        echo "[FAIL] Could not create role: ${ROLE_OUT}"
        exit 1
    }
    echo "[SEED] Role 'todo' created"
fi
echo "[SEED] Checking database 'todo'..."
DB_EXISTS=$(su - postgres -c "psql -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='todo'\"" 2>&1) || {
    echo "[FAIL] Could not query pg_database: ${DB_EXISTS}"
    exit 1
}
DB_EXISTS=$(echo "${DB_EXISTS}" | tr -d ' ')
if [ "${DB_EXISTS}" = "1" ]; then
    echo "[SEED] Database 'todo' already exists"
else
    echo "[SEED] Creating database 'todo'..."
    DB_OUT=$(su - postgres -c "psql -d postgres -c \"CREATE DATABASE todo OWNER todo\"" 2>&1) || {
        echo "[FAIL] Could not create database: ${DB_OUT}"
        exit 1
    }
    echo "[SEED] Database 'todo' created"
fi
echo "[SEED] Ensuring 'stops' table..."
TABLE_OUT=$(su - postgres -c "psql -d todo -c \"CREATE TABLE IF NOT EXISTS stops (id SERIAL PRIMARY KEY, name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, color TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()); ALTER TABLE stops ADD COLUMN IF NOT EXISTS url TEXT; ALTER TABLE stops OWNER TO todo;\"" 2>&1) || {
    echo "[FAIL] Could not create/alter table: ${TABLE_OUT}"
    exit 1
}
echo "[SEED] Table 'stops' ready"
echo "[SEED] Verifying connectivity as 'todo' user via TCP..."
VERIFY=$(psql -h localhost -U todo -d todo -tAc "SELECT count(*) FROM stops" 2>&1) || {
    echo "[FAIL] Cannot connect as 'todo' via TCP: ${VERIFY}"
    echo "[FAIL] Check pg_hba.conf:"
    grep todo /var/lib/postgresql/17/data/pg_hba.conf 2>/dev/null || echo "  no todo entry in pg_hba.conf"
    echo "[FAIL] Check listen_addresses:"
    grep listen_addresses /var/lib/postgresql/17/data/postgresql.conf 2>/dev/null || echo "  not found"
    exit 1
}
VERIFY=$(echo "${VERIFY}" | tr -d ' ')
echo "[SEED] TCP connection verified: ${VERIFY} row(s) in stops"
echo "=== Seed complete: $(date) ==="
