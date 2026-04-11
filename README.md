# 🖥️ iDRAC9 WhatsApp Bot

> Mini Remote Management Platform — kelola Dell iDRAC 9 via WhatsApp + Web Dashboard

![Architecture](https://img.shields.io/badge/Architecture-Decoupled-blue)
![Node.js](https://img.shields.io/badge/Node.js-20_LTS-green)
![Python](https://img.shields.io/badge/Python-3.12-yellow)
![Docker](https://img.shields.io/badge/Docker-Compose-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## ✨ Highlights

- 🖥️ **Full iDRAC 9 Redfish** — Monitor & kontrol server Dell via REST API
- 📱 **WhatsApp Bot** — via Baileys (multi-device), dengan QR / Pairing Code
- 🌐 **Web Dashboard** — Login, monitoring, kontrol WhatsApp connection
- ⏳ **Task Scheduler** — Otomatisasi multi-mode (Once, Weekly, Specific Dates) untuk eksekusi server
- 🔔 **Auto Alert** — Notifikasi otomatis: power change, health degradation, temp spike, event log
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
│                   │  ┌────▼────────────────────┐    │     ┌────▼────┐  │
│                   │  │ Command Parser          │    │     │Redfish  │  │
│                   │  │ Task Scheduler          │    │     │Client   │  │
│                   │  │ Server Analyzer         │    │     └────┬────┘  │
│                   │  └─────────────────────────┘    │          │       │
│                   └─────────────────────────────────┘     ┌────▼────┐  │
│                                                           │ iDRAC 9 │  │
│                                                           │ Server  │  │
│                                                           └─────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start

### 1. Clone & Setup Environment

```bash
git clone https://github.com/your-repo/iDRAC9-WhatsApp-Bot.git
cd iDRAC9-WhatsApp-Bot

# Copy environment config
cp .env.example .env

# Edit .env — WAJIB ubah:
#   JWT_SECRET, ADMIN_PASSWORD, IDRAC_HOST, IDRAC_USERNAME, IDRAC_PASSWORD
```

### 2. Run with Docker Compose

```bash
# Basic (tanpa Redis & PostgreSQL)
docker compose up -d

# Dengan Redis
docker compose --profile with-redis up -d

# Dengan PostgreSQL
docker compose --profile with-postgres up -d

# Semua service
docker compose --profile with-redis --profile with-postgres up -d
```

### 3. Access

- **Dashboard**: http://localhost:3000
- **Python API Docs**: http://localhost:8000/docs
- **Login**: username/password dari `.env`

### 4. Connect WhatsApp

1. Buka Dashboard → WhatsApp
2. Klik "Connect via QR Code"
3. Scan QR code dengan HP
4. Atau gunakan Pairing Code

## 📱 WhatsApp Commands

| Command | Alias | Deskripsi |
|---------|-------|-----------|
| `status` | `st`, `info` | Status server lengkap |
| `power` | `pwr` | Power state |
| `on` | `poweron`, `start` | Nyalakan server |
| `off` | `poweroff`, `shutdown` | Matikan server |
| `restart` | `reboot`, `reset` | Restart server |
| `temp` | `thermal`, `suhu` | Suhu & fan |
| `disk` | `storage`, `raid` | Info disk/RAID |
| `logs` | `log`, `sel` | Event log |
| `help` | `h`, `?` | Daftar perintah |

> **Prefix opsional**: Jika `WA_COMMAND_PREFIX` kosong, semua teks dianggap command.

## 🔌 API Endpoints

### Node.js (:3000)

| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/login | Login |
| GET | /dashboard | Dashboard page |
| GET | /api/status | Combined status |
| GET | /api/thermal | Temperature data |
| POST | /api/power/:action | Power control |
| GET | /whatsapp/qr | QR SSE stream |
| POST | /whatsapp/connect | Start WA connection |

### Python (:8000)

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health |
| GET | /system | System overview |
| GET | /power | Power state |
| POST | /power/on | Power on |
| POST | /power/off | Shutdown |
| GET | /thermal | Temp + fans |
| GET | /storage | Disk info |
| GET | /logs | Event log |

## 🗄️ Database

Dual database support:
1. **PostgreSQL** — primary (jika dikonfigurasi dan reachable)
2. **SQLite** — fallback (selalu tersedia)

Konfigurasi di `.env`:
- SQLite: `DB_PATH=./data/idrac-bot.db` (default)
- PostgreSQL: isi `PG_HOST`, `PG_USERNAME`, `PG_PASSWORD`

## 🔒 Security

- JWT di httpOnly + Secure cookie
- bcrypt password hashing
- Whitelist nomor WhatsApp
- Rate limit per-nomor (configurable)
- Network isolation via Docker
- `.env` tidak masuk git

## 🔔 Alert System

Monitors secara otomatis:
- ⚡ Power state changes
- 🏥 Health degradation
- 🌡️ Temperature spikes (threshold configurable)
- 📋 New SEL entries

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
├── docker-compose.yml
├── .env.example
├── node-app/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── app.js              # Fastify entry point
│       ├── config.js           # Env validation
│       ├── routes/             # HTTP routes
│       ├── services/           # Business logic
│       ├── middleware/         # Auth, rate limit
│       ├── views/             # Nunjucks templates
│       └── public/            # CSS, JS, images
└── python-api/
    ├── Dockerfile
    ├── requirements.txt
    └── app/
        ├── main.py            # FastAPI entry point
        ├── config.py          # Pydantic Settings
        ├── routes/            # API routes
        ├── services/          # Redfish client
        └── utils/             # Retry, response
```

## 🛠️ Development

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

## 📄 License

MIT
