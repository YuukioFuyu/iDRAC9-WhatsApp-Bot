# 🖥️ Erina — AI Maid for Intelligent Server Management

> Mini Remote Management Platform — kelola Dell iDRAC 9 via WhatsApp + AI Companion + Web Dashboard

<p align="center">
  <img width="auto" alt="Erina Delvra Foren" src="https://github.com/user-attachments/assets/5d8c6ad6-3e13-47d4-99ef-e034cf306e57" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Architecture-Decoupled_Microservices-blue" />
  <img src="https://img.shields.io/badge/Node.js-20_LTS-green" />
  <img src="https://img.shields.io/badge/Python-3.12-yellow" />
  <img src="https://img.shields.io/badge/Docker-Compose-blue" />
  <img src="https://img.shields.io/badge/AI-Llama_3.2_3B-purple" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

## ✨ Highlights

- 🤖 **Erina AI** — AI Maid companion berbasis Llama 3.2 3B (LoRA fine-tuned), mengerti bahasa Indonesia natural
- 🖥️ **Full iDRAC 9 Redfish** — Monitor & kontrol server Dell via REST API (status, thermal, storage, power, network, memory, PSU, logs)
- 📱 **WhatsApp Bot** — via Baileys (multi-device), dengan QR / Pairing Code
- 🌐 **Web Dashboard** — Login, monitoring, kontrol WhatsApp connection
- 🔔 **Auto Alert** — Notifikasi otomatis: power change, health degradation, temperature spike, event log baru
- 🗄️ **Dual Database** — PostgreSQL (primary) + SQLite (fallback)
- 🔒 **Security** — JWT httpOnly, bcrypt, whitelist, rate limit, Docker network isolation

---

## 📐 Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                         iDRAC9 WhatsApp Bot                            │
│                                                                        │
│  ┌──────────┐     ┌─────────────────────────────────┐     ┌─────────┐  │
│  │  User    │     │     Node.js (Fastify :3000)     │     │ Python  │  │
│  │ WhatsApp │◄───►│  ┌─────────┐  ┌──────────────┐  │REST │ FastAPI │  │
│  │          │     │  │ Baileys │  │ Web Dashboard│  │────►│ :8000   │  │
│  └──────────┘     │  └────┬────┘  └──────────────┘  │     └────┬────┘  │
│                   │       │                         │          │       │
│  ┌──────────┐     │  ┌────▼────────────────────┐    │     ┌────▼────┐  │
│  │ Erina AI │◄────│  │ Intent Classifier       │    │     │Redfish  │  │
│  │ HF Space │     │  │ Server Analyzer         │    │     │Client   │  │
│  │ Llama3.2 │     │  │ Command Parser          │    │     └────┬────┘  │
│  └──────────┘     │  └─────────────────────────┘    │          │       │
│                   └─────────────────────────────────┘     ┌────▼────┐  │
│                                                           │ iDRAC 9 │  │
│                                                           │ Server  │  │
│                                                           └─────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Flowchart — Message Processing

<img width="6947" height="8191" alt="iDRAC-Erina-WhatsApp Flowchart" src="https://github.com/user-attachments/assets/547c68ad-00cf-4f2d-9dae-b8fcfda2b50c" />

---

## 📊 Data Flow Diagram

<img width="8192" height="1021" alt="iDRAC-Erina-WhatsApp DFD" src="https://github.com/user-attachments/assets/cbc4431e-b655-4210-8c7b-4a1ee4ac707b" />

---

## ⚡ Quick Start

### 1. Clone & Setup Environment

```bash
git clone https://github.com/YuukioFuyu/iDRAC9-WhatsApp-Bot.git
cd iDRAC9-WhatsApp-Bot

# Copy environment config
cp .env.example .env

# Edit .env — WAJIB ubah:
#   JWT_SECRET, ADMIN_PASSWORD, IDRAC_HOST, IDRAC_USERNAME, IDRAC_PASSWORD
#   ERINA_HF_TOKEN (jika ingin mengaktifkan Erina AI)
```

### 2. Run with Docker Compose

```bash
# Basic (Node.js + Python API)
docker compose up -d

# Dengan Redis (optional caching)
docker compose --profile with-redis up -d

# Dengan PostgreSQL (optional primary DB)
docker compose --profile with-postgres up -d

# Semua service
docker compose --profile with-redis --profile with-postgres up -d
```

### 3. Access

| Service | URL | Keterangan |
|---------|-----|------------|
| **Dashboard** | http://localhost:3000 | Web management UI |
| **Python API Docs** | http://localhost:8000/docs | Swagger/OpenAPI |
| **Login** | — | Username/password dari `.env` |

### 4. Connect WhatsApp

1. Buka Dashboard → WhatsApp
2. Klik "Connect via QR Code"
3. Scan QR code dengan HP
4. Atau gunakan Pairing Code

---

## 🤖 Erina AI — Intelligent Maid Assistant

Erina Delvra Foren adalah AI Maid companion yang diintegrasikan ke dalam bot. Dibangun di atas **Llama 3.2 3B Instruct** dengan **LoRA fine-tuning**, di-deploy sebagai HuggingFace Space.

### Two-Layer Processing System

| Layer | Trigger | Latency | Contoh |
|-------|---------|---------|--------|
| **1. Fast Path** | Exact command (`status`, `temp`) | ~1-3s | `status` → langsung execute via Redfish |
| **2. AI Layer** | Natural language / chat | ~30-120s | "cek suhu servernya dong" → Erina + Redfish |

### Contoh Interaksi

| User Message | Intent | Response |
|---|---|---|
| `status` | exact_command ✅ | 🖥️ Server Status... (direct execute, wrapped by Erina) |
| `temp` | exact_command ✅ | 🌡️ Thermal Report... (direct execute) |
| `Tolong cek suhu servernya dong` | server_hint 🔍 | Erina pre-fetch thermal data → natural response |
| `Matikan server` | power_action ⚠️ | Erina asks confirmation → execute on "ya" |
| `Selamat pagi Erina~` | chat 💬 | Ohayou Goshujin-sama! (≧◡≦) ♡ |
| `Lagi ngapain?` | chat 💬 | Aku lagi standby jagain server kamu nih~ |

### Safety Features

- 🔒 **Power actions (off/restart)** selalu minta konfirmasi 2 langkah via Erina NLU
- 🔒 **Power ON** langsung execute tanpa konfirmasi (non-destructive)
- 🔒 **Intent classifier** menggunakan **exact match only** untuk power keywords — mencegah "masih" salah dibaca sebagai "mati"
- 🔒 **Pending action auto-expire** setelah 5 menit
- 🔒 **Fallback** ke static response jika Erina offline/timeout

---

## 📱 WhatsApp Commands

| Command | Alias | Deskripsi |
|---------|-------|-----------| 
| `status` | `st`, `info` | Status server lengkap |
| `power` | `pwr` | Power state |
| `psu` | `power-supply` | Power supply details |
| `on` | `poweron`, `start` | Nyalakan server |
| `off` | `poweroff`, `shutdown`, `stop` | Matikan server (graceful) |
| `restart` | `reboot`, `reset` | Restart server |
| `temp` | `thermal`, `suhu`, `fan` | Suhu & fan speeds |
| `disk` | `storage`, `raid` | Info disk/RAID |
| `network` | `net`, `nic`, `ip` | Network interfaces |
| `memory` | `ram`, `mem` | Info RAM/DIMM |
| `logs` | `log`, `sel`, `events` | Event log terbaru |
| `idrac_reset` | `bmc-reset`, `idrac-restart` | Restart iDRAC controller |
| `help` | `h`, `bantuan`, `menu`, `?` | Daftar perintah |

> **Note**: Jika `WA_COMMAND_PREFIX` kosong, semua teks dianggap command atau diteruskan ke Erina AI.

---

## 🔌 API Endpoints

### Node.js (:3000)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login (JWT) |
| GET | `/dashboard` | Dashboard page |
| GET | `/api/status` | Combined server status |
| GET | `/api/thermal` | Temperature data |
| POST | `/api/power/:action` | Power control |
| GET | `/whatsapp/qr` | QR SSE stream |
| POST | `/whatsapp/connect` | Start WA connection |
| POST | `/whatsapp/disconnect` | Disconnect WA |
| POST | `/whatsapp/logout` | Logout & wipe session |
| POST | `/whatsapp/pair` | Request pairing code |

### Python API (:8000)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| GET | `/system` | System overview |
| GET | `/power` | Power state |
| POST | `/power/on` | Power on |
| POST | `/power/off` | Graceful shutdown |
| POST | `/power/reset` | Restart |
| GET | `/thermal` | Temperature + fans |
| GET | `/storage` | Disk/RAID info |
| GET | `/logs` | Event log (SEL) |
| GET | `/network` | Network interfaces |
| GET | `/memory` | Memory/DIMM info |
| GET | `/power/details` | PSU details |
| POST | `/actions/idrac-reset` | Reset iDRAC BMC |

---

## 🗄️ Database

Dual database support dengan automatic fallback:

| Database | Role | Keterangan |
|----------|------|------------|
| **PostgreSQL** | Primary | Digunakan jika dikonfigurasi dan reachable |
| **SQLite** | Fallback | Selalu tersedia, zero-config |

Konfigurasi di `.env`:
- SQLite: `DB_PATH=./data/idrac-bot.db` (default, selalu aktif)
- PostgreSQL: isi `PG_HOST`, `PG_USERNAME`, `PG_PASSWORD`

---

## 🔒 Security

- JWT di httpOnly + Secure cookie
- bcrypt password hashing
- Whitelist nomor WhatsApp (kosong = allow all)
- Rate limit per nomor (configurable)
- Power action confirmation 2 langkah (via Erina NLU)
- Intent classifier safety: exact match only untuk power keywords
- Network isolation via Docker bridge

---

## 🔔 Alert System

Monitoring otomatis via polling scheduler:

| Alert | Emoji | Trigger |
|-------|-------|---------|
| Power State Change | ⚡ | Server on → off atau sebaliknya |
| Health Degradation | 🚨 | Health OK → Warning/Critical |
| Temperature Spike | 🌡️ | Suhu sensor melebihi threshold |
| New Event Log | 📋 | Entry baru di iDRAC SEL |

Konfigurasi: `ALERT_ENABLED`, `ALERT_POLL_INTERVAL`, `ALERT_TEMP_THRESHOLD`

---

## 📁 Project Structure

```
iDRAC9-WhatsApp-Bot/
├── docker-compose.yml          # Multi-service orchestration
├── .env.example                # Environment template
├── .gitignore
│
├── node-app/                   # Node.js — WhatsApp Bot + Web Dashboard
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── app.js              # Fastify entry point
│       ├── config.js           # Joi env validation + config export
│       ├── routes/
│       │   ├── api.js          # REST API routes
│       │   ├── auth.js         # Login/JWT routes
│       │   ├── dashboard.js    # Dashboard page route
│       │   └── whatsapp.js     # WA connection management routes
│       ├── services/
│       │   ├── baileys.js      # WhatsApp engine (Baileys multi-device)
│       │   ├── erina-ai.js     # Erina AI — HuggingFace Gradio client
│       │   ├── intent-classifier.js  # Fuzzy keyword intent classifier
│       │   ├── server-analyzer.js    # Redfish data → status/mood analysis
│       │   ├── command-parser.js     # Command registry & Redfish handlers
│       │   ├── redfish-client.js     # HTTP client → Python API bridge
│       │   ├── scheduler.js    # Alert polling scheduler (cron)
│       │   ├── db.js           # Dual DB (PostgreSQL + SQLite fallback)
│       │   ├── redis.js        # Optional Redis cache
│       │   └── logger.js       # Pino logger
│       ├── middleware/
│       │   ├── auth.js         # JWT authentication middleware
│       │   └── rate-limit.js   # Per-number rate limiter
│       ├── views/              # Nunjucks HTML templates
│       │   ├── layout.html
│       │   ├── login.html
│       │   ├── dashboard.html
│       │   └── whatsapp.html
│       └── public/             # Static assets (CSS, JS)
│
└── python-api/                 # Python — iDRAC Redfish Bridge
   ├── Dockerfile
   ├── requirements.txt
   └── app/
       ├── main.py              # FastAPI entry point
       ├── config.py            # Pydantic Settings validation
       ├── routes/
       │   ├── system.py        # /system endpoint
       │   ├── thermal.py       # /thermal endpoint
       │   ├── power.py         # /power endpoints
       │   ├── storage.py       # /storage endpoint
       │   ├── logs.py          # /logs endpoint
       │   ├── health.py        # /health endpoint
       │   └── actions.py       # /actions endpoint (iDRAC reset)
       ├── services/
       │   ├── redfish.py       # Redfish REST client (session + cache + retry)
       │   ├── session.py       # iDRAC session lifecycle management
       │   └── cache.py         # In-memory response cache
       └── utils/

Erina-Delvra-Foren/             # Erina AI HuggingFace Space (reference)
├── app.py                      # Gradio + Llama 3.2 3B + LoRA inference
└── ...

Redfish/                        # Redfish API reference data
├── redfish_resources.json
├── redfish_actions.json
└── redfish_metadata.xml
```

---

## 🛠️ Development

### Prerequisites

- Node.js 20 LTS
- Python 3.12+
- Docker & Docker Compose (untuk deployment)
- HuggingFace account + token (untuk Erina AI)

### Local Development

```bash
# Install Node dependencies
cd node-app && npm install

# Install Python dependencies
cd python-api && pip install -r requirements.txt

# Run Node.js (dev mode with auto-reload)
cd node-app && npm run dev

# Run Python (dev mode)
cd python-api && uvicorn app.main:app --reload

# Build Tailwind CSS
cd node-app && npm run css:build

# Watch Tailwind CSS (dev)
cd node-app && npm run css:watch
```

### Environment Variables

Lihat [`.env.example`](.env.example) untuk daftar lengkap. Variabel kunci:

| Variable | Required | Deskripsi |
|----------|----------|-----------|
| `JWT_SECRET` | ✅ | Secret untuk JWT (min 16 char) |
| `ADMIN_USERNAME` | ✅ | Username dashboard |
| `ADMIN_PASSWORD` | ✅ | Password dashboard |
| `IDRAC_HOST` | ✅ | URL iDRAC (e.g., `https://192.168.1.100`) |
| `IDRAC_USERNAME` | ✅ | iDRAC username |
| `IDRAC_PASSWORD` | ✅ | iDRAC password |
| `ERINA_ENABLED` | — | Enable Erina AI (`true`/`false`) |
| `ERINA_HF_TOKEN` | — | HuggingFace API token |
| `ERINA_HF_SPACE` | — | HuggingFace Space ID |
| `WA_ALLOWED_NUMBERS` | — | Whitelist nomor WA (comma-separated) |

---

## 📄 License

MIT
