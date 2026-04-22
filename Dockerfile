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
#   docker build -t erina-delvra-foren .
#
# Export for MikroTik:
#   docker save erina-delvra-foren > erina-delvra-foren.tar
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
RUN mkdir -p \
    /opt/erina-delvra-foren/node-app \
    /opt/erina-delvra-foren/python-api \
    /opt/erina-delvra-foren/scripts \
    /data/pgdata /data/models /data/sessions \
    /var/log/supervisor /var/run \
    && chown -R postgres:postgres /data/pgdata

# ── 3. Install Python dependencies ────────────────
COPY python-api/requirements.txt /opt/erina-delvra-foren/python-api/
RUN pip3 install --no-cache-dir --break-system-packages \
    -r /opt/erina-delvra-foren/python-api/requirements.txt

# ── 4. Install Node.js dependencies ───────────────
COPY node-app/package.json node-app/package-lock.json /opt/erina-delvra-foren/node-app/
WORKDIR /opt/erina-delvra-foren/node-app
RUN npm ci --omit=dev && npm cache clean --force

# ── 5. Copy application source code ───────────────
COPY python-api/app/ /opt/erina-delvra-foren/python-api/app/
COPY node-app/src/ /opt/erina-delvra-foren/node-app/src/

# ── 6. Copy config files ──────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY scripts/init-postgres.sh /opt/erina-delvra-foren/scripts/init-postgres.sh
COPY scripts/entrypoint.sh /opt/erina-delvra-foren/scripts/entrypoint.sh

# ── 7. Fix line endings (Windows CRLF → Unix LF) ──
# Critical: shell scripts with \r\n cause "Exec format error"
RUN sed -i 's/\r$//' /opt/erina-delvra-foren/scripts/*.sh \
    && chmod +x /opt/erina-delvra-foren/scripts/*.sh

WORKDIR /opt/erina-delvra-foren

# Ports: Dashboard(3000), PostgreSQL(5432)
EXPOSE 3000 5432

ENTRYPOINT ["/bin/bash", "/opt/erina-delvra-foren/scripts/entrypoint.sh"]
