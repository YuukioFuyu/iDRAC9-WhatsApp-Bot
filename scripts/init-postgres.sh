#!/bin/bash
# ═══════════════════════════════════════════════════════
# PostgreSQL First-Run Initialization
# ═══════════════════════════════════════════════════════
#
# Called by entrypoint.sh BEFORE supervisord starts.
# Initializes the PostgreSQL cluster, creates user/database,
# and installs pgvector extension on first boot.
#
# Subsequent boots skip initialization (checks PG_VERSION file).

set -e

PGDATA="${PGDATA:-/data/pgdata}"
PG_BIN="/usr/lib/postgresql/16/bin"
DB_NAME="${MEM_PG_DATABASE:-erina_memories}"
DB_USER="${MEM_PG_USERNAME:-erina}"
DB_PASS="${MEM_PG_PASSWORD:-dellemcr640}"

echo "═══════════════════════════════════════════════"
echo "  PostgreSQL Init Check"
echo "═══════════════════════════════════════════════"

# ── Check if cluster already exists ──────────────────
if [ -f "$PGDATA/PG_VERSION" ]; then
    echo "✅ PostgreSQL cluster exists — skipping init"
    exit 0
fi

echo "🔧 First run detected — initializing PostgreSQL cluster..."

# ── Ensure data directory permissions ────────────────
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

# ── Initialize cluster ──────────────────────────────
echo "📦 Running initdb..."
su postgres -c "$PG_BIN/initdb -D $PGDATA --encoding=UTF8 --locale=C"

# ── Configure networking (external backup access) ───
# Listen on all interfaces so pg_dump/psql can connect from outside
echo "" >> "$PGDATA/postgresql.conf"
echo "# ── MikroTik Container Config ──" >> "$PGDATA/postgresql.conf"
echo "listen_addresses = '0.0.0.0'" >> "$PGDATA/postgresql.conf"
echo "port = 5432" >> "$PGDATA/postgresql.conf"
echo "max_connections = 20" >> "$PGDATA/postgresql.conf"
echo "shared_buffers = 64MB" >> "$PGDATA/postgresql.conf"
echo "work_mem = 4MB" >> "$PGDATA/postgresql.conf"

# ── Configure authentication ────────────────────────
# Allow password-based auth from any IP (for backup/restore)
echo "" >> "$PGDATA/pg_hba.conf"
echo "# ── External backup/restore access ──" >> "$PGDATA/pg_hba.conf"
echo "host    all    all    0.0.0.0/0    md5" >> "$PGDATA/pg_hba.conf"
echo "host    all    all    ::/0         md5" >> "$PGDATA/pg_hba.conf"

# ── Start PostgreSQL temporarily ────────────────────
echo "🚀 Starting PostgreSQL for initial setup..."
su postgres -c "$PG_BIN/pg_ctl start -D $PGDATA -w -o '-c listen_addresses=localhost'"

# ── Create user and database ────────────────────────
echo "👤 Creating user: $DB_USER"
su postgres -c "psql -c \"CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';\""

echo "📁 Creating database: $DB_NAME"
su postgres -c "psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\""

# Grant all privileges
su postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;\""

# ── Install pgvector extension ──────────────────────
echo "🧠 Installing pgvector extension..."
su postgres -c "psql -d $DB_NAME -c 'CREATE EXTENSION IF NOT EXISTS vector;'"

# ── Verify ──────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "✅ PostgreSQL initialization complete!"
echo "   Database: $DB_NAME"
echo "   User:     $DB_USER"
echo "   Port:     5432 (accessible externally)"
echo "   pgvector: installed"
echo "═══════════════════════════════════════════════"

# ── Stop PostgreSQL (supervisord will start it) ─────
su postgres -c "$PG_BIN/pg_ctl stop -D $PGDATA -w"
echo "⏹️  PostgreSQL stopped — supervisord will manage it"
