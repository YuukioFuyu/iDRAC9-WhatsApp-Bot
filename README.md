# 🖥️ Erina — AI Maid for Intelligent Server Management

> Mini Remote Management Platform — kelola Dell iDRAC 9 via WhatsApp + AI Companion + Web Dashboard

> **⚠️ Branch: `mikrotik-container`** — Single-image edition untuk MikroTik Container deployment

<p align="center">
  <img width="auto" alt="Erina Delvra Foren" src="https://github.com/user-attachments/assets/5d8c6ad6-3e13-47d4-99ef-e034cf306e57" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Architecture-Single_Container-blue" />
  <img src="https://img.shields.io/badge/MikroTik-Container-red" />
  <img src="https://img.shields.io/badge/Node.js-20_LTS-green" />
  <img src="https://img.shields.io/badge/Python-3.12-yellow" />
  <img src="https://img.shields.io/badge/PostgreSQL-16_pgvector-blue" />
  <img src="https://img.shields.io/badge/AI-Llama_3.2_3B-purple" />
  <img src="https://img.shields.io/badge/Memory-pgvector_RAG-orange" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

## ✨ Highlights

- 🤖 **Erina AI** — AI Maid companion berbasis Llama 3.2 3B (LoRA fine-tuned), mengerti bahasa Indonesia natural
- 🧠 **RAG Memory** — Memori semantik berbasis pgvector: embed lokal (all-MiniLM-L6-v2 ONNX) + HNSW cosine similarity
- 🖥️ **Full iDRAC 9 Redfish** — Monitor & kontrol server Dell via REST API (status, thermal, storage, power, network, memory, PSU, logs)
- 📱 **WhatsApp Bot** — via Baileys (multi-device), dengan QR / Pairing Code
- 🌐 **Web Dashboard** — Login, monitoring, kontrol WhatsApp connection
- ⏳ **Task Scheduler** — Otomatisasi multi-mode (Once, Weekly, Specific Dates) untuk eksekusi server
- 🔔 **Auto Alert** — Notifikasi otomatis bernada Erina AI: power change, health degradation, temperature spike, event log baru
- 📦 **Single Container** — Semua service (Node.js + Python + PostgreSQL) dalam satu image untuk MikroTik Container
- 🔒 **Security** — JWT httpOnly, bcrypt, whitelist, rate limit

---

## 📐 Architecture — Single Container

```
┌──────────────────────────────────────────────────────────────────────┐
│                MikroTik Container (Single Image)                      │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                    supervisord (PID 1)                          │  │
│  │  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐   │  │
│  │  │ PostgreSQL  │  │   Python API     │  │    Node.js       │   │  │
│  │  │ 16 pgvector │  │   Uvicorn :8000  │  │    Fastify :3000 │   │  │
│  │  │ :5432       │  │   (internal)     │  │    (public)      │   │  │
│  │  └──────┬──────┘  └────────┬─────────┘  └────────┬─────────┘   │  │
│  │         │                  │                     │             │  │
│  │         └──────┬───────────┘                     │             │  │
│  │                │ localhost                        │             │  │
│  └────────────────┼─────────────────────────────────┼─────────────┘  │
│                   │                                 │                │
│  ┌────────────────▼─────────────────────────────────▼─────────────┐  │
│  │                     /data/ (persistent)                        │  │
│  │  ├── pgdata/     PostgreSQL cluster data                      │  │
│  │  ├── models/     ONNX embedding model cache                   │  │
│  │  └── sessions/   WhatsApp session files                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
        │                    │                        │
   Port 5432            iDRAC Redfish            Port 3000
   (backup/restore)     (via Python API)         (Dashboard + WA)
        │                    │                        │
   pg_dump/psql         iDRAC 9 Server           WhatsApp / Browser
```

### Perbedaan dari Branch `main`

| Aspek | `main` (Docker Compose) | `mikrotik-container` (Single Image) |
|---|---|---|
| **Services** | 3 container terpisah | 1 container (supervisord) |
| **PostgreSQL** | `memories-db` container | Embedded dalam container |
| **Python API** | `python-api` container, exposed :8000 | Internal only (127.0.0.1:8000) |
| **Redis** | Optional (with-redis profile) | External only (optional) |
| **Port PG** | Internal Docker network | Exposed :5432 (backup access) |
| **Data** | Docker volumes per-service | Single `/data/` directory |
| **Target** | Docker/Portainer | MikroTik Container |

---

## ⚡ Quick Start

### 1. Clone & Setup

```bash
git clone -b mikrotik-container https://github.com/YuukioFuyu/iDRAC9-WhatsApp-Bot.git
cd iDRAC9-WhatsApp-Bot

# Copy environment config
cp .env.mikrotik.example .env

# Edit .env — WAJIB ubah:
#   JWT_SECRET, ADMIN_PASSWORD
#   IDRAC_HOST, IDRAC_USERNAME, IDRAC_PASSWORD
#   ERINA_HF_TOKEN (jika Erina AI aktif)
```

### 2. Build & Run (Docker — Local Testing)

```bash
# Build image
docker compose up -d

# Cek logs
docker compose logs -f

# Cek semua service berjalan
docker exec erina-mikrotik supervisorctl status
```

### 3. Deploy ke MikroTik Container

```bash
# 1. Build image untuk arsitektur MikroTik (ARM64 atau x86)
docker build --platform linux/arm64 -t erina-mikrotik .

# 2. Push ke Docker Hub
docker tag erina-mikrotik your-dockerhub/erina-mikrotik:latest
docker push your-dockerhub/erina-mikrotik:latest
```

Di MikroTik RouterOS:

```routeros
# 3. Setup container registry
/container/config/set registry-url=https://registry-1.docker.io tmpdir=disk1/tmp

# 4. Create VETH interface
/interface/veth/add name=veth-erina address=172.17.0.2/24 gateway=172.17.0.1

# 5. Create bridge & add VETH
/interface/bridge/add name=bridge-containers
/interface/bridge/port/add bridge=bridge-containers interface=veth-erina
/ip/address/add address=172.17.0.1/24 interface=bridge-containers

# 6. Set environment variables
/container/envs/add name=erina-envs key=IDRAC_HOST value="https://192.168.1.100"
/container/envs/add name=erina-envs key=IDRAC_USERNAME value="root"
/container/envs/add name=erina-envs key=IDRAC_PASSWORD value="your_password"
/container/envs/add name=erina-envs key=JWT_SECRET value="your-secret-64-chars"
/container/envs/add name=erina-envs key=ADMIN_PASSWORD value="your_admin_pass"
/container/envs/add name=erina-envs key=MEM_PG_PASSWORD value="your_pg_pass"
/container/envs/add name=erina-envs key=ERINA_ENABLED value="true"
/container/envs/add name=erina-envs key=ERINA_HF_TOKEN value="hf_your_token"
/container/envs/add name=erina-envs key=WA_ALLOWED_NUMBERS value="628xxxxxxxxxx"

# 7. Add container
/container/add remote-image=your-dockerhub/erina-mikrotik:latest \
  interface=veth-erina \
  root-dir=disk1/erina \
  envlist=erina-envs \
  start-on-boot=yes

# 8. NAT rules (akses dari luar MikroTik)
/ip/firewall/nat/add chain=dstnat dst-port=3000 protocol=tcp \
  action=dst-nat to-addresses=172.17.0.2 to-ports=3000 \
  comment="Erina Dashboard"

/ip/firewall/nat/add chain=dstnat dst-port=5432 protocol=tcp \
  action=dst-nat to-addresses=172.17.0.2 to-ports=5432 \
  comment="Erina PostgreSQL Backup"

# Masquerade untuk container akses internet (WA + HuggingFace)
/ip/firewall/nat/add chain=srcnat src-address=172.17.0.0/24 \
  action=masquerade comment="Container Internet Access"

# 9. Start container
/container/start [find where tag~"erina"]
```

### 4. Access

| Service | URL | Keterangan |
|---------|-----|------------|
| **Dashboard** | http://\<mikrotik-ip\>:3000 | Web management UI |
| **PostgreSQL** | \<mikrotik-ip\>:5432 | Backup/restore via pg_dump |
| **Login** | — | Username/password dari env vars |

### 5. Connect WhatsApp

1. Buka Dashboard → WhatsApp
2. Klik "Connect via QR Code"
3. Scan QR code dengan HP
4. Atau gunakan Pairing Code

---

## 🔧 Backup & Restore PostgreSQL

Karena MikroTik Container tidak memiliki akses console interaktif, PostgreSQL di-expose di port 5432 untuk backup/restore dari external machine.

### Backup

```bash
# Backup seluruh database
pg_dump -h <mikrotik-ip> -p 5432 -U erina erina_memories > erina_backup.sql

# Backup Erina memories saja
pg_dump -h <mikrotik-ip> -p 5432 -U erina -t erina_memories erina_memories > erina_memories_only.sql

# Backup dengan format custom (compressed)
pg_dump -h <mikrotik-ip> -p 5432 -U erina -Fc erina_memories > erina_backup.dump
```

### Restore

```bash
# Restore dari SQL file
psql -h <mikrotik-ip> -p 5432 -U erina erina_memories < erina_backup.sql

# Restore dari custom format
pg_restore -h <mikrotik-ip> -p 5432 -U erina -d erina_memories erina_backup.dump
```

### Inspect

```bash
# Connect langsung ke PostgreSQL
psql -h <mikrotik-ip> -p 5432 -U erina erina_memories

# Cek jumlah memori Erina
psql -h <mikrotik-ip> -p 5432 -U erina erina_memories -c "SELECT COUNT(*) FROM erina_memories;"

# Lihat memori terbaru
psql -h <mikrotik-ip> -p 5432 -U erina erina_memories -c "SELECT role, LEFT(content, 80), created_at FROM erina_memories ORDER BY created_at DESC LIMIT 10;"
```

---

## 🔔 Alert System

Monitoring otomatis via polling scheduler. Semua notifikasi dibungkus dalam bahasa Erina AI (Maid-style).

| Alert | Emoji | Trigger | Metode |
|-------|-------|---------|--------|
| Power State Change | ⚡ | Server on → off atau sebaliknya | **Erina AI (HuggingFace)** → fallback template statis |
| Health Degradation | 🚨 | Health OK → Warning/Critical | Template statis Erina-style (3 variasi) |
| Temperature Spike | 🌡️ | Suhu sensor melebihi threshold | Template statis Erina-style (3 variasi) |
| New Event Log | 📋 | Entry baru di iDRAC SEL | Template statis Erina-style (3 variasi) |

Konfigurasi: `ALERT_ENABLED`, `ALERT_POLL_INTERVAL`, `ALERT_TEMP_THRESHOLD`

---

## 📁 Project Structure (MikroTik Edition)

```
iDRAC9-WhatsApp-Bot/
├── Dockerfile                    # Unified multi-service image
├── supervisord.conf              # Process manager config
├── docker-compose.yml            # Simplified for local testing
├── .env.example                  # Environment template
├── .env.mikrotik.example         # MikroTik-specific template
├── scripts/
│   ├── entrypoint.sh             # Container entrypoint
│   └── init-postgres.sh          # PostgreSQL first-run init
│
├── node-app/                     # Node.js — WhatsApp Bot + Dashboard
│   ├── package.json
│   └── src/
│       ├── app.js                # Fastify entry point
│       ├── config.js             # Config (defaults: localhost)
│       ├── routes/               # API & page routes
│       ├── services/             # Core services
│       ├── middleware/            # Auth & rate limit
│       ├── views/                # Nunjucks templates
│       └── public/               # Static assets
│
└── python-api/                   # Python — Redfish Bridge (internal)
    ├── requirements.txt
    └── app/
        ├── main.py               # FastAPI entry point
        ├── config.py             # Pydantic Settings
        ├── routes/               # Redfish endpoints
        ├── services/             # Redfish client + cache
        └── utils/                # Retry + response helpers
```

---

## 🔒 Security

- JWT di httpOnly + Secure cookie
- bcrypt password hashing
- Whitelist nomor WhatsApp
- Rate limit per nomor
- Power action confirmation 2 langkah (via Erina NLU)
- Python API hanya accessible dari dalam container (127.0.0.1)
- PostgreSQL exposed untuk backup saja — gunakan firewall MikroTik untuk restrict access

> **⚠️ Penting**: Pastikan untuk membatasi akses port 5432 hanya dari IP yang trusted. Gunakan firewall MikroTik:
> ```routeros
> /ip/firewall/filter/add chain=forward dst-port=5432 protocol=tcp \
>   src-address=!192.168.1.0/24 action=drop comment="Block PG from untrusted"
> ```

---

## 📝 Environment Variables

Lihat [`.env.mikrotik.example`](.env.mikrotik.example) untuk daftar lengkap.

| Variable | Required | Deskripsi |
|----------|----------|-----------|
| `JWT_SECRET` | ✅ | Secret untuk JWT (min 16 char) |
| `ADMIN_USERNAME` | ✅ | Username dashboard |
| `ADMIN_PASSWORD` | ✅ | Password dashboard |
| `IDRAC_HOST` | ✅ | URL iDRAC (e.g., `https://192.168.1.100`) |
| `IDRAC_USERNAME` | ✅ | iDRAC username |
| `IDRAC_PASSWORD` | ✅ | iDRAC password |
| `MEM_PG_PASSWORD` | ✅ | Password PostgreSQL internal |
| `ERINA_ENABLED` | — | Enable Erina AI (`true`/`false`) |
| `ERINA_HF_TOKEN` | — | HuggingFace API token |
| `WA_ALLOWED_NUMBERS` | — | Whitelist nomor WA |
| `REDIS_ENABLED` | — | Enable Redis external (`false`) |
| `REDIS_HOST` | — | IP Redis server eksternal |

---

## 📄 License

MIT
