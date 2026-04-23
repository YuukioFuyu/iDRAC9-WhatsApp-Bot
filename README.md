# iDRAC9 WhatsApp Bot — MikroTik Container Edition

> **Branch:** `mikrotik-container`
> Single-image deployment for MikroTik Container — no Docker Compose, no stack.

[![MikroTik](https://img.shields.io/badge/MikroTik-Container-293239?logo=mikrotik&logoColor=white)](https://help.mikrotik.com/docs/display/ROS/Container)
[![ARM64](https://img.shields.io/badge/Architecture-ARM64-blue)](https://hub.docker.com/)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+pgvector-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)

## Deskripsi

Bot WhatsApp untuk manajemen remote server **Dell iDRAC 9** dengan AI assistant **Erina Delvra Foren** 💜, yang menjalankan **seluruh service** dalam satu container untuk kompatibilitas MikroTik Container.

Edisi ini merupakan konversi dari arsitektur multi-container (Docker Compose) menjadi **single-image** dengan `supervisord` sebagai process manager.

## Arsitektur

```
┌──────────────────────────────────────────────┐
│          MikroTik Container (ARM64)          │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │          supervisord (PID 1)           │  │
│  ├────────────────────────────────────────┤  │
│  │                                        │  │
│  │  [10] PostgreSQL 16 + pgvector         │  │
│  │       └─ erina_memories (RAG)          │  │
│  │                                        │  │
│  │  [20] Python FastAPI (Uvicorn)         │  │
│  │       └─ Redfish Bridge → iDRAC 9     │  │
│  │                                        │  │
│  │  [30] Node.js Fastify                  │  │
│  │       ├─ WhatsApp Bot (Baileys)        │  │
│  │       ├─ Web Dashboard                 │  │
│  │       └─ Erina AI + RAG Memory        │  │
│  │           └─ @xenova/transformers      │  │
│  │              (WASM, no native binary)  │  │
│  │                                        │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Ports: 3000 (Dashboard)  5432 (PostgreSQL)  │
│  Volume: /data/ (pgdata, models, sessions)   │
│                                              │
│  External: Redis (optional)                  │
└──────────────────────────────────────────────┘
```

## Fitur

| Fitur | Deskripsi |
|---|---|
| **iDRAC Remote** | Power On/Off, Status, Thermal, Storage, Event Logs via WhatsApp |
| **Erina AI** | AI Assistant berbasis HuggingFace Spaces (Gradio) |
| **RAG Memory** | Memori percakapan persisten via pgvector (384-dim embeddings) |
| **Web Dashboard** | Monitoring server, manage WhatsApp session, task scheduler |
| **Alert System** | Notifikasi otomatis untuk suhu, PSU, power state |
| **Task Scheduler** | Jadwal power on/off otomatis via cron |

## Perbedaan dengan Branch Utama (`main`)

| Aspek | `main` (Docker Compose) | `mikrotik-container` |
|---|---|---|
| Images | 2 (node-api + python-api) | 1 (all-in-one) |
| PostgreSQL | External server | Internal (dalam container) |
| Process Manager | Docker Compose | supervisord |
| ONNX Runtime | Native (`onnxruntime-node`) | WASM (`onnxruntime-web`) |
| Target | x86 Server / Docker | ARM64 MikroTik Container |

---

## Deployment ke MikroTik

### Prerequisites

- MikroTik RouterOS v7.x dengan fitur **Container** aktif
- Disk/USB terpasang untuk storage
- Koneksi internet untuk pull image

### 1. Build & Push Image

```bash
# Build image (di PC/Server x86 dengan buildx untuk ARM64)
docker buildx build --platform linux/arm64 -t yourdockerhub/erina-delvra-foren:latest --push .

# Atau build langsung di ARM64 host
docker build -t yourdockerhub/erina-delvra-foren:latest .
docker push yourdockerhub/erina-delvra-foren:latest
```

### 2. Konfigurasi MikroTik Container

```routeros
# ── Enable Container Feature ──
/system/device-mode/update container=yes

# ── Reboot (wajib setelah enable container) ──
/system/reboot

# ── Setelah reboot: Konfigurasi Registry ──
/container/config
set registry-url=https://registry-1.docker.io
set tmpdir=disk1/pull

# ── Buat VETH Interface ──
/interface/veth
add name=veth-erina address=10.10.10.2/24 gateway=10.10.10.1

# ── Buat Bridge untuk Container ──
/interface/bridge
add name=bridge-containers

/interface/bridge/port
add bridge=bridge-containers interface=veth-erina

# ── Assign IP ke Bridge ──
/ip/address
add address=10.10.10.1/24 interface=bridge-containers

# ── NAT untuk akses internet dari container ──
/ip/firewall/nat
add chain=srcnat action=masquerade src-address=10.10.10.0/24

# ── Buat Mount untuk persistent data ──
/container/mounts
add name=erina-data src=disk1/erina-data dst=/data
```

### 3. Buat Environment File

Buat file `erina.env` di disk MikroTik (`disk1/erina.env`) dengan isi yang sesuai.
Referensi lengkap ada di `.env.example` pada repository ini.

**Environment Penting:**

| Variable | Deskripsi | Contoh |
|---|---|---|
| `APP_PORT` | Port Web Dashboard | `3000` |
| `JWT_SECRET` | Secret key untuk JWT auth | *(random 64 char)* |
| `ADMIN_USERNAME` | Login Dashboard | `admin` |
| `ADMIN_PASSWORD` | Password Dashboard | *(password kuat)* |
| `IDRAC_HOST` | URL iDRAC 9 | `https://192.168.1.100` |
| `IDRAC_USERNAME` | Username iDRAC | `root` |
| `IDRAC_PASSWORD` | Password iDRAC | *(password iDRAC)* |
| `WA_ALLOWED_NUMBERS` | Nomor WA yang diizinkan | `628xxxxxxxxxx` |
| `ERINA_HF_TOKEN` | HuggingFace API Token | `hf_xxxxxxx` |
| `ERINA_HF_SPACE` | HuggingFace Space ID | `Yuuki0/Erina-Delvra-Foren` |
| `REDIS_ENABLED` | Aktifkan Redis (optional) | `false` |

### 4. Tambah Container

```routeros
/container
add remote-image=yourdockerhub/erina-delvra-foren:latest \
    interface=veth-erina \
    root-dir=disk1/erina-root \
    mounts=erina-data \
    envlist=erina-env \
    hostname=YUKIKAZE \
    logging=yes \
    cmd="/usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf"
```

> **⚠️ CMD PENTING:** MikroTik Container tidak menggunakan `ENTRYPOINT` dari Dockerfile.
> Anda **WAJIB** memasukkan CMD secara manual:
> ```
> /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
> ```

### 5. Environment List di MikroTik

```routeros
/container/envs
add name=erina-env key=APP_PORT value="3000"
add name=erina-env key=APP_HOST value="0.0.0.0"
add name=erina-env key=JWT_SECRET value="your-64-char-random-string-here"
add name=erina-env key=JWT_EXPIRES_IN value="24h"
add name=erina-env key=LOG_LEVEL value="info"
add name=erina-env key=TZ value="Asia/Jakarta"
add name=erina-env key=ADMIN_USERNAME value="admin"
add name=erina-env key=ADMIN_PASSWORD value="your-password"
add name=erina-env key=IDRAC_HOST value="https://192.168.1.100"
add name=erina-env key=IDRAC_USERNAME value="root"
add name=erina-env key=IDRAC_PASSWORD value="calvin"
add name=erina-env key=IDRAC_VERIFY_SSL value="false"
add name=erina-env key=IDRAC_TIMEOUT value="30"
add name=erina-env key=IDRAC_SESSION_TTL value="1800"
add name=erina-env key=PY_API_URL value="http://127.0.0.1:8000"
add name=erina-env key=PY_API_HOST value="127.0.0.1"
add name=erina-env key=PY_API_PORT value="8000"
add name=erina-env key=REDIS_ENABLED value="false"
add name=erina-env key=WA_SESSION_PATH value="/data/sessions"
add name=erina-env key=WA_ALLOWED_NUMBERS value="628xxxxxxxxxx"
add name=erina-env key=ERINA_ENABLED value="true"
add name=erina-env key=ERINA_HF_TOKEN value="hf_your_token"
add name=erina-env key=ERINA_HF_SPACE value="Yuuki0/Erina-Delvra-Foren"
add name=erina-env key=ERINA_TIMEOUT value="180000"
add name=erina-env key=ERINA_MAX_TOKENS value="512"
add name=erina-env key=ERINA_TEMPERATURE value="0.7"
add name=erina-env key=ERINA_MEMORY_LIMIT value="5"
add name=erina-env key=ERINA_RECENT_CONTEXT value="3"
add name=erina-env key=ALERT_POLL_INTERVAL value="60"
add name=erina-env key=ALERT_TEMP_THRESHOLD value="75"
add name=erina-env key=ALERT_ENABLED value="true"
```

### 6. Start Container

```routeros
/container/start 0
```

Ganti `0` dengan nomor container Anda. Cek status:

```routeros
/container/print
```

---

## Testing Lokal (Docker)

Untuk development atau testing di PC sebelum deploy ke MikroTik:

```bash
# Clone repository
git clone -b mikrotik-container https://github.com/YourRepo/iDRAC9-WhatsApp-Bot.git
cd iDRAC9-WhatsApp-Bot

# Copy dan edit konfigurasi
cp .env.example .env
# Edit .env dengan kredensial Anda

# Build dan jalankan
docker compose up -d

# Lihat logs
docker compose logs -f
```

Akses Dashboard: `http://localhost:3000`

---

## Struktur Direktori

```
iDRAC9-WhatsApp-Bot/
├── Dockerfile                 # Single-image build (supervisord)
├── docker-compose.yml         # Local testing only
├── supervisord.conf           # Process manager config
├── .env.example               # Environment variable reference
│
├── node-app/                  # Node.js WhatsApp Bot + Dashboard
│   ├── package.json
│   └── src/
│       ├── app.js             # Entry point
│       ├── config.js          # Environment validation
│       ├── services/
│       │   ├── baileys.js     # WhatsApp connection (Baileys)
│       │   ├── erina-ai.js    # Erina AI integration
│       │   ├── erina-memory.js # RAG memory (pgvector)
│       │   ├── db.js          # PostgreSQL connection
│       │   ├── redis.js       # Redis cache (optional)
│       │   └── ...
│       ├── routes/            # API & dashboard routes
│       ├── views/             # HTML templates
│       └── public/            # Static assets (CSS/JS)
│
├── python-api/                # Python Redfish Bridge
│   ├── requirements.txt
│   └── app/
│       ├── main.py            # FastAPI entry point
│       └── routes/            # iDRAC API endpoints
│
└── scripts/
    └── start-postgres.sh      # PostgreSQL init + startup wrapper
```

---

## Catatan Teknis

### ONNX Runtime & ARM64

MikroTik menggunakan CPU ARM64 yang **tidak mendukung instruksi AVX/SSE4**. Library `onnxruntime-node` menggunakan native binary yang membutuhkan instruksi tersebut, menyebabkan crash `SIGILL`.

**Solusi:** Menggunakan `@xenova/transformers` v2 dengan patch untuk memaksa penggunaan `onnxruntime-web` (WebAssembly) yang berjalan di semua arsitektur CPU.

```dockerfile
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf node_modules/onnxruntime-node \
    && sed -i 's/onnxruntime-node/onnxruntime-web/g' node_modules/@xenova/transformers/src/backends/onnx.js \
    && sed -i 's/onnxruntime-node/onnxruntime-web/g' node_modules/@xenova/transformers/dist/transformers.js \
    && sed -i 's/onnxruntime-node/onnxruntime-web/g' node_modules/@xenova/transformers/dist/transformers.min.js
```

### Persistent Storage

Volume `/data/` harus di-mount ke penyimpanan persisten di MikroTik:

| Path | Isi | Keterangan |
|---|---|---|
| `/data/pgdata` | PostgreSQL data | Database erina_memories |
| `/data/models` | AI Models | Xenova/all-MiniLM-L6-v2 (~90MB, auto-download) |
| `/data/sessions` | WhatsApp Auth | Sesi login WhatsApp (Baileys) |

### First Boot

Pada saat pertama kali container dijalankan:
1. PostgreSQL akan melakukan `initdb` (~10 detik)
2. Database `erina_memories` dan user `erina` akan dibuat otomatis
3. Extension `pgvector` akan di-install
4. Model embedding AI akan diunduh (~90MB, bisa 60-120 detik di MikroTik)
5. Setelah itu, WhatsApp QR code akan muncul di Dashboard

> **⏱️ Boot pertama bisa memakan waktu 2-3 menit.** Boot selanjutnya akan jauh lebih cepat (~15 detik) karena data sudah persisten.

---

## License

MIT License — lihat branch `main` untuk detail lengkap.
