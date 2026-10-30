#!/bin/sh
echo "=== Database Seed Check ==="
echo ""

# PostgreSQL service
PG_STATUS=$(rc-service postgresql status 2>&1)
echo "PostgreSQL: ${PG_STATUS}"
if ! echo "${PG_STATUS}" | grep -q started; then
    echo "[FAIL] PostgreSQL is not running"
    exit 1
fi
echo ""

# TCP listener
LISTEN=$(netstat -tln 2>/dev/null | grep 5432)
if [ -n "${LISTEN}" ]; then
    echo "[OK] Listening on port 5432"
else
    echo "[FAIL] Not listening on TCP 5432"
    echo "  Check: grep listen_addresses /var/lib/postgresql/17/data/postgresql.conf"
fi
echo ""

# Readiness
if pg_isready -q; then
    echo "[OK] PostgreSQL accepting connections"
else
    echo "[FAIL] PostgreSQL not accepting connections"
    exit 1
fi

# Role
ROLE=$(su - postgres -c "psql -d postgres -tAc \"SELECT rolname FROM pg_roles WHERE rolname='todo'\"" 2>/dev/null)
if [ "${ROLE}" = "todo" ]; then
    echo "[OK] Role 'todo' exists"
else
    echo "[FAIL] Role 'todo' does not exist — run /root/02_pw_db_seed.sh"
fi

# Database
DB=$(su - postgres -c "psql -d postgres -tAc \"SELECT datname FROM pg_database WHERE datname='todo'\"" 2>/dev/null)
if [ "${DB}" = "todo" ]; then
    echo "[OK] Database 'todo' exists"
else
    echo "[FAIL] Database 'todo' does not exist — run /root/02_pw_db_seed.sh"
fi

# Table
if [ "${DB}" = "todo" ]; then
    TABLE=$(su - postgres -c "psql -d todo -tAc \"SELECT tablename FROM pg_tables WHERE tablename='stops'\"" 2>/dev/null)
    if [ "${TABLE}" = "stops" ]; then
        COUNT=$(su - postgres -c "psql -d todo -tAc 'SELECT count(*) FROM stops'" 2>/dev/null | tr -d ' ')
        echo "[OK] Table 'stops' exists (${COUNT} rows)"
    else
        echo "[FAIL] Table 'stops' does not exist — run /root/02_pw_db_seed.sh"
    fi
fi

# pg_hba for remote access
HBA=$(grep todo /var/lib/postgresql/17/data/pg_hba.conf 2>/dev/null)
if [ -n "${HBA}" ]; then
    echo "[OK] pg_hba allows todo connections"
else
    echo "[FAIL] pg_hba has no entry for todo — frontend VM won't be able to connect"
fi

# listen_addresses
LISTEN_CONF=$(grep '^listen_addresses' /var/lib/postgresql/17/data/postgresql.conf 2>/dev/null)
if echo "${LISTEN_CONF}" | grep -q "'\\*'"; then
    echo "[OK] listen_addresses = '*'"
else
    echo "[FAIL] listen_addresses not set to '*': ${LISTEN_CONF:-not found}"
fi

# Seed service status
SEED_ENABLED=$(rc-update show default 2>/dev/null | grep pw-db-seed)
if [ -n "${SEED_ENABLED}" ]; then
    echo ""
    echo "[INFO] Seed service still enabled (hasn't run yet or failed)"
else
    echo ""
    echo "[INFO] Seed service disabled (already ran)"
fi

# End-to-end TCP verification as the app user
echo ""
echo "--- Verification: psql -h localhost -U todo -d todo ---"
psql -h localhost -U todo -d todo -c "\dt stops" 2>&1
psql -h localhost -U todo -d todo -c "SELECT count(*) AS row_count FROM stops" 2>&1
echo ""
echo "=== Done ==="
