# POLIS — AI Trading System

> ระบบเทรด Forex อัตโนมัติด้วย AI | AI-powered Forex Trading System with MT5 Integration

![Tech Stack](https://img.shields.io/badge/Python-3.11-blue?logo=python) ![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js) ![FastAPI](https://img.shields.io/badge/FastAPI-0.110-green?logo=fastapi) ![Docker](https://img.shields.io/badge/Docker-Compose-blue?logo=docker) ![Redis](https://img.shields.io/badge/Redis-7-red?logo=redis)

---

## ภาพรวม / Overview

**POLIS** คือระบบ AI Trading ที่วิเคราะห์สัญญาณตลาด Forex ด้วย Large Language Model (LLM) แล้วส่งคำสั่งซื้อขายจริงผ่าน MetaTrader 5 โดยอัตโนมัติ พร้อม Dashboard แบบ Real-time สำหรับติดตามผล

**POLIS** is a full-stack AI trading platform that analyzes Forex market signals using Large Language Models (LLM) and automatically executes real trades through MetaTrader 5, with a real-time monitoring dashboard.

---

## สถาปัตยกรรม / Architecture

```
TwelveData API
      │ market signals
      ▼
┌─────────────┐    Redis Pub/Sub    ┌─────────────────┐
│   Kernel    │◄───────────────────►│   MT5 Bridge    │
│  (Python)   │  TRADE_APPROVED     │   (Python)      │
│             │  TRADE_CLOSED       │                 │
│ • LLM Agent │                     │ • MetaTrader 5  │
│ • Policy    │                     │ • Trailing Stop │
│ • Risk Mgmt │                     │ • Anti-hedge    │
└─────────────┘                     └─────────────────┘
      │                                      │
      │ Redis                                │ Redis
      ▼                                      ▼
┌─────────────┐    REST + WebSocket   ┌──────────────┐
│   Gateway   │◄─────────────────────►│  Dashboard   │
│  (FastAPI)  │                       │  (Next.js)   │
└─────────────┘                       └──────────────┘
      │
      ▼
┌──────────────────────────────────┐
│  PostgreSQL │ Redis │ Qdrant     │
│  (trades)   │(cache)│(memory)    │
└──────────────────────────────────┘
```

---

## ฟีเจอร์หลัก / Key Features

### AI & Trading Engine
- **LLM Signal Analysis** — ใช้ AI วิเคราะห์สัญญาณ (OpenRouter / Gemini / Groq)
- **Policy Governor** — ระบบกฎควบคุมความเสี่ยงแบบ multi-layer
- **Circuit Breaker** — หยุดเทรดอัตโนมัติเมื่อขาดทุนถึง limit รายวัน
- **Trailing Stop** — ปรับ Stop Loss อัตโนมัติตาม price movement
- **Board Meeting** — AI รีวิว trade decisions ย้อนหลังเพื่อปรับกลยุทธ์
- **Recovery Mode** — ลด lot size อัตโนมัติหลังขาดทุนติดต่อกัน

### Real-time Dashboard (9 หน้า)
- **ภาพรวมตลาด** — Live prices จาก MT5, Fear & Greed Index, Market Sessions
- **Open Positions** — ดูและปิด position แบบ real-time ผ่าน web
- **Trading Log** — ประวัติการเทรดพร้อม Profit Factor, Win Streak, Duration
- **Performance** — Equity curve, Drawdown chart, Session P&L (Asian/London/NY)
- **Manual Trade** — ส่งออเดอร์ผ่าน dashboard พร้อม Risk Calculator
- **Price Alerts** — แจ้งเตือนเมื่อราคาถึงเป้าหมาย (Browser Notification)
- **Backtest** — ทดสอบกลยุทธ์กับข้อมูลย้อนหลัง

### Infrastructure
- **Docker Compose** — 7 services พร้อม run ด้วยคำสั่งเดียว
- **WebSocket Feed** — Real-time events streaming ทุก trade decision
- **Telegram Bot** — แจ้งเตือนและควบคุมระบบผ่าน Telegram
- **Signal Service** — Paid Telegram channel สำหรับส่ง signals ให้ subscribers

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **AI / LLM** | OpenRouter, Gemini, Groq, Anthropic Claude |
| **Backend** | Python 3.11, FastAPI, asyncio, Redis Pub/Sub |
| **Frontend** | Next.js 14, TypeScript, React, WebSocket |
| **Database** | PostgreSQL, Redis, Qdrant (vector DB) |
| **Broker** | MetaTrader 5 Python API |
| **Data** | TwelveData API, TradingView Webhooks |
| **Infra** | Docker, Docker Compose |
| **Notifications** | Telegram Bot API, Discord Webhooks, Browser Notifications |

---

## การติดตั้ง / Quick Start

### 1. Clone & Setup

```bash
git clone https://github.com/Pstsrppt/Polis.git
cd Polis
cp .env.example .env
# แก้ไข .env ใส่ API keys ของคุณ
```

### 2. รัน Stack

```bash
docker compose up -d
```

### 3. รัน MT5 Bridge (ต้องติดตั้ง MetaTrader 5 บน Windows)

```bash
pip install MetaTrader5 redis python-dotenv
python tools/polis_mt5_bridge.py
```

### 4. เปิด Dashboard

```
http://localhost:13000
```

---

## Services

| Service | Port | Description |
|---------|------|-------------|
| Dashboard | 13000 | Next.js trading dashboard |
| Gateway | 19000 | FastAPI REST + WebSocket |
| Kernel | — | AI trading engine |
| Redis | 6379 | Event bus + cache |
| PostgreSQL | 5432 | Trade history |
| Qdrant | 6333 | Vector memory |

---

## Environment Variables

ดูตัวอย่างที่ [`.env.example`](.env.example)

| Variable | Description |
|----------|-------------|
| `MT5_LOGIN` | MetaTrader 5 account login |
| `MT5_SERVER` | MT5 broker server |
| `OPENROUTER_API_KEY` | LLM API key |
| `TWELVE_DATA_API_KEY` | Market data API |
| `TELEGRAM_BOT_TOKEN` | Telegram notifications |
| `MAX_DAILY_LOSS_USD` | Daily loss circuit breaker limit |

---

## ผู้พัฒนา / Developer

**Pongsathorn** — นักศึกษาสาขาวิทยาการคอมพิวเตอร์

- GitHub: [@Pstsrppt](https://github.com/Pstsrppt)
- Email: pongsathorn.sir@spumail.net

---

## License

MIT License — ดูรายละเอียดที่ [LICENSE](LICENSE)
