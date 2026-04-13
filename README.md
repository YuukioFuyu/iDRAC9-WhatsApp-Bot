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
- 🔔 **Auto Alert** — Notifikasi otomatis: power change, health degradation, temperature spike, event log baru
- 🗄️ **Dual PostgreSQL** — External PostgreSQL (primary) + Internal PostgreSQL/pgvector (fallback, pengganti SQLite)
- 🔒 **Security** — JWT httpOnly, bcrypt, whitelist, rate limit, Docker network isolation

---

## 📐 Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         iDRAC9 WhatsApp Bot                                  │
│                                                                              │
│  ┌──────────┐     ┌─────────────────────────────────────┐     ┌───────────┐  │
│  │   User   │     │       Node.js (Fastify :3000)       │     │  Python   │  │
│  │ WhatsApp │◄───►│  ┌─────────┐  ┌──────────────────┐  │REST │  FastAPI  │  │
│  │          │     │  │ Baileys │  │  Web Dashboard   │  │────►│  :8000    │  │
│  └──────────┘     │  └────┬────┘  └──────────────────┘  │     └─────┬─────┘  │
│                   │       │                             │           │        │
│  ┌──────────┐     │  ┌────▼─────────────────────────┐   │     ┌─────▼─────┐  │
│  │ Erina AI │◄────│  │ Intent Classifier            │   │     │ Redfish   │  │
│  │ HF Space │     │  │ Command Parser               │   │     │ Client    │  │
│  │ Llama3.2 │     │  │ Task Scheduler               │   │     └─────┬─────┘  │
│  └──────────┘     │  │ Server Analyzer              │   │           │        │
│                   │  └──────────────────────────────┘   │           │        │
│  ┌──────────────┐ │                                     │     ┌─────▼─────┐  │
│  │ memories-db  │◄│  Erina Memory (pgvector RAG)        │     │  iDRAC 9  │  │
│  │ pgvector:pg16│ │  all-MiniLM-L6-v2 (ONNX 384-dim)    │     │  Server   │  │
│  └──────────────┘ └─────────────────────────────────────┘     └───────────┘  │
│         ▲                           │                                        │
│         │            ┌──────────────▼────────────────┐                       │
│         └────────────│ External PostgreSQL (primary) │                       │
│           fallback   │ → app tables + erina_memories │                       │
│                      └───────────────────────────────┘                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Database Strategy

```
┌─────────────────┐     ┌───────────────────────────┐
│                 │────►│ PostgreSQL External       │  ← PRIMARY
│                 │     │ host:5432/idrac_bot       │
│                 │     └───────────────────────────┘
│    node-app     │                   │ GAGAL?
│    (Docker)     │                   ▼
│                 │     ┌─────────────────────────────┐
│                 │────►│ memories-db (Docker)        │  ← FALLBACK
│                 │     │ pgvector/pgvector:pg16      │
└─────────────────┘     │ erina_memories + app tables │
                        └─────────────────────────────┘
```

Kedua database menggunakan PostgreSQL dan fully support **pgvector** — sehingga `erina_memories` (RAG) berfungsi di kedua database tanpa perbedaan fitur.

---

## 🔄 Flowchart — Message Processing

<img width="5929" height="8192" alt="flowchart" src="https://github.com/user-attachments/assets/3566133c-078f-4665-9ef0-b0a1a0edb8aa" />

---

## 📊 Data Flow Diagram

<img width="8192" height="1193" alt="dataflow" src="https://github.com/user-attachments/assets/a0826742-814d-4b5f-8fc0-cf83e0d6971f" />

---

## 🔀 Sequence Diagram — Erina AI RAG Pipeline

<img width="6321" height="8191" alt="sequence" src="https://github.com/user-attachments/assets/3133d85d-12a3-4396-80ab-0122d9152747" />

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
#   MEM_PG_PASSWORD (password untuk Internal PostgreSQL)
```

### 2. Run with Docker Compose

```bash
# Standar (Node.js + Python API + Internal PostgreSQL)
# memories-db selalu berjalan sebagai fallback database
docker compose up -d

# Dengan Redis (optional caching)
docker compose --profile with-redis up -d

# Dengan External PostgreSQL (optional primary DB)
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
- 🔒 **Duplicate detection** — cek pgvector cache 10 menit terakhir sebelum proses ulang

---

## 🧠 RAG Memory System

Erina menggunakan **Retrieval-Augmented Generation (RAG)** berbasis pgvector untuk mengingat konteks percakapan secara efisien.

### Cara Kerja

1. **Embed** — Setiap pesan di-embed secara lokal menggunakan `Xenova/all-MiniLM-L6-v2` (ONNX, 384-dim)
2. **Store** — Embedding disimpan di tabel `erina_memories` dengan pgvector
3. **Retrieve** — Saat pesan baru masuk, sistem melakukan:
   - **Semantic search**: 5 memori paling relevan (cosine similarity via HNSW index)
   - **Recent context**: 3 pesan terbaru (kronologis)
4. **Merge & Dedup** — Gabungkan hasil, hapus duplikat, map role ke format LLM
5. **Send** — Kirim sebagai `chat_history_json` ke HuggingFace Space (stateless inference)

### Role System

| Role | DB Value | Deskripsi |
|------|----------|-----------|
| Owner (master) | `'master'` | Pengguna terdaftar di `WA_ALLOWED_NUMBERS` |
| Guest | `'guest'` | Pengguna tidak terdaftar |
| Erina (AI) | `'erina'` | Respons dari Erina AI |

### Performa

| Metrik | Sebelum (Firestore) | Sesudah (pgvector RAG) |
|---|---|---|
| Memori yang dimuat | 40 pesan (mentah) | 5-8 pesan (relevan) |
| Token input ke LLM | ~2000-3500 tokens | ~500-1200 tokens |
| Waktu inference (CPU) | ~4-6 menit | ~1-2 menit |
| Latency memory retrieval | ~200-500ms (Firestore) | ~5-20ms (pgvector HNSW) |
| Latency embedding | N/A | ~50-100ms (lokal ONNX) |

### Konfigurasi RAG

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `ERINA_MEMORY_LIMIT` | `5` | Jumlah memori semantik per query (cosine similarity) |
| `ERINA_RECENT_CONTEXT` | `3` | Jumlah pesan terbaru untuk konteks kronologis |

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
| GET | `/api/schedules` | List all schedules |
| POST | `/api/schedules` | Create schedule |
| PUT | `/api/schedules/:id` | Update schedule |
| DELETE | `/api/schedules/:id` | Delete schedule |
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

### Dual PostgreSQL Architecture

Dual database support dengan automatic failover — **SQLite telah sepenuhnya digantikan** oleh Internal PostgreSQL (`memories-db`) berbasis pgvector.

| Database | Role | Container | Keterangan |
|----------|------|-----------|------------|
| **External PostgreSQL** | Primary | `postgres` (optional profile) | Digunakan jika `PG_HOST` + `PG_USERNAME` dikonfigurasi |
| **Internal PostgreSQL** | Fallback | `memories-db` (always running) | `pgvector/pgvector:pg16` — otomatis digunakan jika External gagal/tidak dikonfigurasi |

Kedua database menggunakan **schema identik** dan mendukung **pgvector** untuk Erina RAG memory.

### Boot Sequence (Database)

```
1. Cek External PostgreSQL (PG_HOST + PG_USERNAME)
   ├── ✅ Terhubung → gunakan sebagai primary
   └── ❌ Gagal / tidak dikonfigurasi
       └── 2. Cek Internal PostgreSQL (MEM_PG_HOST + MEM_PG_USERNAME)
           ├── ✅ Terhubung → gunakan sebagai fallback
           └── ❌ Gagal → Fatal error, app tidak bisa start
```

### Konfigurasi Database

**External PostgreSQL (primary):**
```env
PG_HOST=your-pg-host
PG_PORT=5432
PG_DATABASE=idrac_bot
PG_USERNAME=your_user
PG_PASSWORD=your_password
```

**Internal PostgreSQL / memories-db (fallback):**
```env
MEM_PG_HOST=memories-db
MEM_PG_PORT=5432
MEM_PG_DATABASE=erina_memories
MEM_PG_USERNAME=erina
MEM_PG_PASSWORD=your_password_here
```

---

## 🔒 Security

- JWT di httpOnly + Secure cookie
- bcrypt password hashing
- Whitelist nomor WhatsApp (kosong = allow all)
- Rate limit per nomor (configurable)
- Power action confirmation 2 langkah (via Erina NLU)
- Intent classifier safety: exact match only untuk power keywords
- Duplicate message detection via pgvector cache (10 menit)
- Network isolation via Docker bridge
- Internal PostgreSQL tidak expose port ke host (Docker internal only)

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

## ⏳ Schedule Automation

Sistem otomatisasi server tingkat lanjut (cron-like) terintegrasi pada Dashboard.

- **Once Only**: Jalan sekali pada tanggal dan jam tertentu, lalu mati otomatis.
- **Weekly Repeat**: Pilih hari-hari spesifik dalam seminggu (mis: Su, Mo, We, Fr) jalan rutin tanpa batas.
- **Specific Date**: Kalender interaktif untuk memilih banyak tanggal spesifik dalam satu tahun (opsi `Once` atau `Repeat` tahunan).

Mendukung eksekusi perintah Power Cycle maupun command Redfish (RACADM CLI) secara otomatis.

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
│       ├── app.js              # Fastify entry point + boot sequence
│       ├── config.js           # Joi env validation + config export
│       ├── routes/
│       │   ├── api.js          # REST API routes (status, power, schedules)
│       │   ├── auth.js         # Login/JWT routes
│       │   ├── dashboard.js    # Dashboard page route
│       │   └── whatsapp.js     # WA connection management routes
│       ├── services/
│       │   ├── baileys.js      # WhatsApp engine (Baileys multi-device)
│       │   ├── erina-ai.js     # Erina AI — HuggingFace Gradio client
│       │   ├── erina-memory.js # RAG memory — pgvector embed + retrieve
│       │   ├── intent-classifier.js  # Fuzzy keyword intent classifier
│       │   ├── server-analyzer.js    # Redfish data → status/mood analysis
│       │   ├── command-parser.js     # Command registry & Redfish handlers
│       │   ├── redfish-client.js     # HTTP client → Python API bridge
│       │   ├── scheduler.js    # Alert polling scheduler (cron)
│       │   ├── task-scheduler.js     # User-defined task automation
│       │   ├── db.js           # Dual PostgreSQL (External + Internal fallback)
│       │   ├── redis.js        # Optional Redis cache
│       │   └── logger.js       # Pino logger
│       ├── middleware/
│       │   ├── auth.js         # JWT authentication middleware
│       │   └── rate-limit.js   # Per-number rate limiter
│       ├── views/              # Nunjucks HTML templates
│       │   ├── layout.html
│       │   ├── login.html
│       │   ├── dashboard.html
│       │   ├── schedule.html
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
└── ...                         # (stateless — chat_history via JSON param)

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

### Docker Services

| Service | Container | Image | Keterangan |
|---------|-----------|-------|------------|
| `node-app` | `idrac-bot-node` | Custom (Dockerfile) | WhatsApp Bot + Dashboard |
| `python-api` | `idrac-bot-python` | Custom (Dockerfile) | Redfish API Bridge |
| `memories-db` | `erina-memories-db` | `pgvector/pgvector:pg16` | Internal PostgreSQL (always running) |
| `redis` | `idrac-bot-redis` | `redis:7-alpine` | Optional (profile: `with-redis`) |
| `postgres` | `idrac-bot-postgres` | `postgres:16-alpine` | Optional External PG (profile: `with-postgres`) |

### Boot Sequence

```
1. initDatabase()          ← External PG → fallback Internal PG (memories-db)
2. seedAdminUser()         ← Create admin user jika belum ada
3. seedBootstrapServer()   ← Register iDRAC server dari .env
4. Fastify listen (:3000)  ← Web server ready
5. erinaMemory.init()      ← initTable() + load embedding model (ONNX)
6. WhatsApp connect        ← Auto-reconnect jika session exists
7. Alert Scheduler         ← Start polling iDRAC
8. Task Scheduler          ← Start user-defined automation
```

> **Note**: Startup pertama akan ~30 detik lebih lama karena download model ONNX `all-MiniLM-L6-v2` (~80MB). Model di-cache di `./data/models/` sehingga startup berikutnya cepat.

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
| `MEM_PG_PASSWORD` | ✅ | Password Internal PostgreSQL (memories-db) |
| `ERINA_ENABLED` | — | Enable Erina AI (`true`/`false`) |
| `ERINA_HF_TOKEN` | — | HuggingFace API token |
| `ERINA_HF_SPACE` | — | HuggingFace Space ID |
| `WA_ALLOWED_NUMBERS` | — | Whitelist nomor WA (comma-separated) |
| `ERINA_MEMORY_LIMIT` | — | Jumlah memori semantik per query (default: 5) |
| `ERINA_RECENT_CONTEXT` | — | Jumlah pesan terbaru untuk konteks (default: 3) |
| `PG_HOST` | — | Host External PostgreSQL (jika ingin primary DB eksternal) |
| `PG_USERNAME` | — | Username External PostgreSQL |

---

## 📝 Changelog

### v1.2.0 — SQLite → Internal PostgreSQL Migration

- **🗄️ Hapus SQLite** — `better-sqlite3` dihapus dari dependencies, semua kode SQLite di-remove
- **🐘 Internal PostgreSQL** — Container `memories-db` (`pgvector/pgvector:pg16`) menggantikan SQLite sebagai fallback database
- **♻️ Unified driver** — Kedua database (External + Internal) menggunakan PostgreSQL, sehingga kode `query()`/`execute()` menjadi pure PostgreSQL tanpa konversi SQL
- **🏷️ Role rename** — Role di `erina_memories` diubah dari `user`/`assistant` menjadi `master`/`guest`/`erina` untuk membedakan owner vs guest

### v1.1.0 — Firestore → pgvector RAG Memory

- **🧠 RAG system** — Ganti Firestore 40 pesan mentah dengan pgvector semantic retrieval (5-8 memori relevan)
- **📦 Local embedding** — `Xenova/all-MiniLM-L6-v2` (ONNX) berjalan lokal di Node.js, tanpa API call external
- **🔄 chat_history_json** — HuggingFace Space menerima history via JSON parameter, bukan lagi Firestore
- **⚡ Performa** — Token input ke LLM turun ~60%, waktu inference ~50% lebih cepat

### v1.0.0 — Initial Release

- WhatsApp Bot + Web Dashboard
- Full iDRAC 9 Redfish integration
- Erina AI (Llama 3.2 3B + LoRA)
- Alert system + Task scheduler
- Dual database (PostgreSQL + SQLite)

---

## 📄 License

MIT
