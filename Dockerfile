# ═══════════════════════════════════════════════════════
# iDRAC9 WhatsApp Bot — MikroTik Single-Container Image
# ═══════════════════════════════════════════════════════
#
# Combines Node.js + Python + PostgreSQL (pgvector) into
# one image for MikroTik Container (single image only).
#
# Process management via supervisord:
#   1. PostgreSQL 16 (pgvector) — Erina Memories + App DB
#   2. Python FastAPI (Uvicorn) — Redfish Bridge
#   3. Node.js (Fastify + Baileys) — WhatsApp Bot + Dashboard
#
# Ports:
#   3000 — Web Dashboard + WhatsApp Bot
#   5432 — PostgreSQL (external backup/restore access)
#
# Build:
#   docker build -t erina-mikrotik .
#
# Export for MikroTik:
#   docker save erina-mikrotik > erina-mikrotik.tar
# ═══════════════════════════════════════════════════════

FROM debian:bookworm-slim

# ── Environment defaults ────────────────────────────
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Jakarta \
    # Node.js
    NODE_ENV=production \
    TRANSFORMERS_CACHE=/data/models \
    # PostgreSQL
    PGDATA=/data/pgdata \
    MEM_PG_HOST=127.0.0.1 \
    MEM_PG_PORT=5432 \
    MEM_PG_DATABASE=erina_memories \
    MEM_PG_USERNAME=erina \
    MEM_PG_PASSWORD=dellemcr640 \
    # Python API (internal only)
    PY_API_URL=http://127.0.0.1:8000 \
    PY_API_HOST=127.0.0.1 \
    PY_API_PORT=8000

# ── 1. Install system packages ─────────────────────
# Node.js 20 via NodeSource, Python 3.12, PostgreSQL 16, supervisord
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools
    curl gnupg ca-certificates lsb-release \
    # Build tools (for native Node modules: bcrypt, onnxruntime)
    python3 python3-pip python3-venv python3-dev \
    make g++ \
    # supervisord
    supervisor \
    # PostgreSQL 16
    && echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-16 \
       postgresql-16-pgvector \
    # Node.js 20 via NodeSource
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ── 2. Setup directory structure ───────────────────
RUN mkdir -p /app/node-app /app/python-api /data/pgdata /data/models /data/sessions \
    /var/log/supervisor /var/run \
    && chown -R postgres:postgres /data/pgdata

# ── 3. Install Python dependencies ────────────────
COPY python-api/requirements.txt /app/python-api/
RUN pip3 install --no-cache-dir --break-system-packages -r /app/python-api/requirements.txt

# ── 4. Install Node.js dependencies ───────────────
COPY node-app/package.json node-app/package-lock.json /app/node-app/
WORKDIR /app/node-app
RUN npm ci --omit=dev && npm cache clean --force

# ── 5. Copy application source code ───────────────
COPY python-api/app/ /app/python-api/app/
COPY node-app/src/ /app/node-app/src/

# ── 6. Copy config files ──────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY scripts/init-postgres.sh /app/scripts/init-postgres.sh
RUN chmod +x /app/scripts/init-postgres.sh

# ── 7. Entrypoint ─────────────────────────────────
# init-postgres.sh handles first-run DB setup, then execs supervisord
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh

WORKDIR /app

# Ports: Dashboard(3000), PostgreSQL(5432)
EXPOSE 3000 5432

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
