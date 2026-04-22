#!/bin/bash
# ═══════════════════════════════════════════════════════
# PostgreSQL Wrapper — Init + Start (called by supervisord)
# ═══════════════════════════════════════════════════════
#
# This script is called by supervisord instead of directly
# running the postgres binary. It handles:
#   1. First-run: initdb + create user/db + pgvector
#   2. Every run: start postgres in foreground
#
# This approach works on MikroTik Container where ENTRYPOINT
# may be bypassed — supervisord calls this directly.

set -e

PGDATA="${PGDATA:-/data/pgdata}"
PG_BIN="/usr/lib/postgresql/16/bin"
DB_NAME="${MEM_PG_DATABASE:-erina_memories}"
DB_USER="${MEM_PG_USERNAME:-erina}"
DB_PASS="${MEM_PG_PASSWORD:-dellemcr640}"

# ── Ensure data directory exists and has correct permissions ──
mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

# ── First run: Initialize cluster ──────────────────────
if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "═══════════════════════════════════════════════"
    echo "  PostgreSQL First-Run Initialization"
    echo "═══════════════════════════════════════════════"

    echo "📦 Running initdb..."
    su postgres -c "$PG_BIN/initdb -D $PGDATA --encoding=UTF8 --locale=C"

    # Configure networking (external backup access)
    echo "" >> "$PGDATA/postgresql.conf"
    echo "# ── MikroTik Container Config ──" >> "$PGDATA/postgresql.conf"
    echo "listen_addresses = '0.0.0.0'" >> "$PGDATA/postgresql.conf"
    echo "port = 5432" >> "$PGDATA/postgresql.conf"
    echo "max_connections = 20" >> "$PGDATA/postgresql.conf"
    echo "shared_buffers = 64MB" >> "$PGDATA/postgresql.conf"
    echo "work_mem = 4MB" >> "$PGDATA/postgresql.conf"

    # Configure authentication
    echo "" >> "$PGDATA/pg_hba.conf"
    echo "# ── External backup/restore access ──" >> "$PGDATA/pg_hba.conf"
    echo "host    all    all    0.0.0.0/0    md5" >> "$PGDATA/pg_hba.conf"
    echo "host    all    all    ::/0         md5" >> "$PGDATA/pg_hba.conf"

    # Start temporarily to create user/db
    echo "🚀 Starting PostgreSQL for initial setup..."
    su postgres -c "$PG_BIN/pg_ctl start -D $PGDATA -w -o '-c listen_addresses=localhost'"

    echo "👤 Creating user: $DB_USER"
    su postgres -c "psql -c \"CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';\""

    echo "📁 Creating database: $DB_NAME"
    su postgres -c "psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\""
    su postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;\""

    echo "🧠 Installing pgvector extension..."
    su postgres -c "psql -d $DB_NAME -c 'CREATE EXTENSION IF NOT EXISTS vector;'"

    echo "✅ PostgreSQL initialization complete!"
    echo "   Database: $DB_NAME | User: $DB_USER | pgvector: installed"

    # Stop (will restart in foreground below)
    su postgres -c "$PG_BIN/pg_ctl stop -D $PGDATA -w"
fi

# ── Symlink sessions directory ──────────────────────
# Node.js expects sessions at node-app/sessions
SESSIONS_LINK="/opt/erina-delvra-foren/node-app/sessions"
if [ ! -L "$SESSIONS_LINK" ]; then
    mkdir -p /data/sessions
    rm -rf "$SESSIONS_LINK"
    ln -sf /data/sessions "$SESSIONS_LINK"
fi

# ── Start PostgreSQL in foreground (supervisord manages lifecycle) ──
echo "🐘 Starting PostgreSQL..."
exec su postgres -c "$PG_BIN/postgres -D $PGDATA"
