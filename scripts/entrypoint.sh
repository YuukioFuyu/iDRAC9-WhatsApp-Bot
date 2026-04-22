#!/bin/bash
# ═══════════════════════════════════════════════════════
# Entrypoint — Runs init scripts then starts supervisord
# ═══════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════"
echo "  iDRAC9 WhatsApp Bot — MikroTik Container"
echo "  Erina Delvra Foren 💜"
echo "═══════════════════════════════════════════════"

# ── Ensure data directories exist ───────────────────
mkdir -p /data/pgdata /data/models /data/sessions
chown -R postgres:postgres /data/pgdata

# ── Symlink sessions directory ──────────────────────
# Node.js expects sessions at /opt/erina-delvra-foren/node-app/sessions
# but we want persistent data in /data/sessions
if [ ! -L /opt/erina-delvra-foren/node-app/sessions ]; then
    rm -rf /opt/erina-delvra-foren/node-app/sessions
    ln -sf /data/sessions /opt/erina-delvra-foren/node-app/sessions
fi

# ── Initialize PostgreSQL (first run only) ──────────
/opt/erina-delvra-foren/scripts/init-postgres.sh

# ── Start supervisord ───────────────────────────────
echo ""
echo "🚀 Starting all services via supervisord..."
echo ""
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
