<div align="center">

# 🜂 POLIS
### AI Trading Enterprise OS

*ระบบเทรด AI อัตโนมัติ — Research → Filter → Policy → Execute → Notify*

`POLIS v2.0` · Docker Compose · Next.js 14 · FastAPI · Python 3.11

</div>

---

## Architecture

```
TradingView Webhook          TwelveData REST API
        │                           │
        └──────────┬────────────────┘
                   ↓ Redis TRADE_SIGNAL
         ┌─────────────────────┐
         │   POLIS Kernel      │
         │  ResearchAgent      │  Gemini → Groq → OpenRouter
         │  SignalFilter       │  confidence / ATR / hours / news
         │  PolicyEngine       │  max_risk %
         │  CircuitBreaker     │  daily loss / streak / step-down
         │  TradeTracker       │  trailing stop (BE → trail)
         │  TradeHandler       │  OANDA SIM
         │  BoardMeeting       │  5 AI executives / 5min
         │  WorldModel         │  macro regime
         └────────┬────────────┘
                  ↓ Events
         ┌────────────────────┐     ┌──────────────────┐
         │  Gateway (FastAPI) │────▶│  Dashboard       │
         │  REST + WebSocket  │     │  Next.js 14      │
         │  Port 19000        │     │  Port 13000      │
         └────────────────────┘     └──────────────────┘
         Telegram + Discord ←──────────────────────────┘
```

---

## Quick Start

### 1. ติดตั้ง

```bash
git clone <repo>
cd polis
cp .env.example .env
# แก้ .env (ดูส่วน Environment Variables)
docker compose up -d
```

เปิด `http://localhost:13000` → Login ด้วย `ADMIN_PASSWORD`

### 2. Remote Access (Tailscale)

```bash
# ติดตั้ง Tailscale บน PC + มือถือ, login account เดียวกัน
# Dashboard: http://100.102.93.11:13000
# Gateway:   http://100.102.93.11:19000
```

---

## Environment Variables

```env
# ── LLM (ต้องมีอย่างน้อย 1 อย่าง) ──────────────
GEMINI_API_KEY=           # Google Gemini — แนะนำ (free)
GROQ_API_KEY=             # fallback
OPENROUTER_API_KEY=       # fallback ลำดับ 3

# ── Infrastructure ───────────────────────────────
POSTGRES_URL=postgresql://polis:polis@postgres:5432/polis
REDIS_URL=redis://redis:6379/0
QDRANT_URL=http://qdrant:6333

# ── Notifications ────────────────────────────────
TELEGRAM_BOT_TOKEN=       # จาก @BotFather
TELEGRAM_CHAT_ID=         # Chat ID สำหรับ admin
DISCORD_WEBHOOK_URL=      # optional

# ── Market Data ──────────────────────────────────
SIGNAL_SOURCE=twelvedata  # mock | twelvedata | tradingview
TWELVE_DATA_API_KEY=      # free tier = 800 credits/day
SIGNAL_SYMBOLS=XAU/USD    # คั่นด้วย comma
TRADINGVIEW_WEBHOOK_SECRET=  # secret สำหรับ verify webhook

# ── Signal Service (Paid Channel) ────────────────
SIGNAL_CHANNEL_ID=        # Telegram channel ID (เช่น -1001234567890)
CHANNEL_INVITE_LINK=      # https://t.me/+xxxxx
PROMPTPAY_NUMBER=         # เบอร์โทรหรือเลขบัตรประชาชน
SIGNAL_MONTHLY_THB=500    # ราคา monthly plan

# ── Dashboard Auth ───────────────────────────────
ADMIN_PASSWORD=           # ตั้งให้แข็งแรง

# ── Trading Parameters ───────────────────────────
MAX_RISK=0.005            # 0.5% per trade
ACCOUNT_BALANCE_USD=10000
REWARD_RATIO=3.0          # TP = stop × 3
TRAIL_ACTIVATE_R=1.0      # trailing stop ที่ 1R gain
DAILY_BUDGET_USD=620      # risk budget / day
MAX_DAILY_LOSS_USD=300    # hard loss limit / day → CB triggers

# ── Signal Filter ────────────────────────────────
MIN_SIGNAL_CONFIDENCE=60
MIN_ATR_SPREAD_RATIO=2.0
TRADING_HOURS_START=7     # UTC (07:00 = 14:00 Bangkok)
TRADING_HOURS_END=20
NEWS_BUFFER_MINUTES=30    # skip ±30min รอบ NFP/CPI/FOMC

# ── THB / Daily Goal ─────────────────────────────
THB_PER_USD=34            # fallback rate (ดึง live จาก er-api.com อัตโนมัติ)
DAILY_TARGET_THB=500      # เป้าหมายกำไรวันละ ฿500
```

---

## TradingView Webhook Setup

### ขั้นตอนการตั้งค่า

1. **สร้าง Alert** ใน TradingView → Notifications tab

2. **Webhook URL:**
   ```
   http://YOUR_IP:19000/webhook/tradingview?secret=YOUR_SECRET
   ```
   - `YOUR_IP` = Tailscale IP (เช่น `100.102.93.11`) หรือ public domain
   - `YOUR_SECRET` = ค่า `TRADINGVIEW_WEBHOOK_SECRET` ใน `.env`

3. **Message (JSON)** — ใส่ใน Alert Message box:
   ```json
   {
     "symbol": "{{ticker}}",
     "direction": "{{strategy.order.action}}",
     "price": {{close}},
     "atr": {{ta.atr(14)}},
     "confidence": 75
   }
   ```

4. **เปลี่ยน signal source:**
   ```env
   SIGNAL_SOURCE=tradingview
   ```
   ```bash
   docker compose up -d --build kernel
   ```

5. **ทดสอบ** — กด "Test" ใน TradingView แล้วดู trade ใน dashboard

---

## Dashboard Pages

| Page | URL | Description |
|------|-----|-------------|
| Home | `/` | System overview + Event feed |
| Trading | `/trading` | Live trades + World model |
| Portfolio | `/trading/portfolio` | Open positions + Unrealized P&L |
| Performance | `/trading/performance` | Equity curve + By-symbol breakdown |
| Backtest | `/trading/backtest` | What-If Analyzer (confidence/ratio/symbol) |
| Calendar | `/trading/calendar` | P&L รายวัน (บาท) + เป้าหมาย 🎯 |
| Best Hours | `/trading/hours` | Heatmap 24h + เวลาทองที่สุด |
| Trade Log | `/trading/log` | ทุกไม้ พร้อม THB + filter + export |
| Board | `/trading/board` | AI Executive Board meeting |
| SOC | `/trading/soc` | Circuit Breaker + Risk control |
| Settings | `/trading/settings` | Live settings + TradingView webhook |
| Notifications | `/trading/notifications` | Alert history |
| Signal Service | `/signals` | Subscriber management + Pending requests |
| Subscribe | `/subscribe` | หน้าสมัคร PromptPay (สาธารณะ) |
| Social | `/social` | Content Queue |
| Media Studio | `/media` | AI Video/Content |

---

## Telegram Bot Commands

| Command | Action |
|---------|--------|
| `/status` | ภาพรวม + P&L วันนี้ + CB state |
| `/pause` | หยุดเทรด |
| `/resume` | เปิดเทรด + reset circuit breaker |
| `/risk 0.5` | เปลี่ยน max_risk เป็น 0.5% |
| `/cb` | สถานะ circuit breaker |
| `/report` | All-time performance |
| `/board` | Board meeting ล่าสุด |
| `/world` | World model + market regime |
| `/decisions` | 10 decisions ล่าสุด |
| `/subs` | Active subscribers + MRR |
| `/approve <id>` | อนุมัติ PromptPay request |
| `/rejectsub <id>` | ปฏิเสธ request |
| `/addsub <tg_id> <username>` | เพิ่ม subscriber |
| `/delsub <tg_id>` | ยกเลิก subscriber |

---

## Circuit Breaker

| Trigger | Default | Env Var |
|---------|---------|---------|
| Consecutive rejects | 5 | `CB_MAX_CONSECUTIVE_REJECTS` |
| Daily risk budget | $620 | `DAILY_BUDGET_USD` |
| Daily P&L -50% | Warning + step-down | `MAX_DAILY_LOSS_USD` |
| Daily P&L -100% | Hard stop | `MAX_DAILY_LOSS_USD` |

**Win Streak:** ชนะ 3 ครั้งติด → max_risk ×1.2 (cap 1.5×)  
**Step-down:** ขาดทุนถึง 50% → max_risk ลดเหลือครึ่ง  
**Auto-reset:** เที่ยงคืน UTC (07:00 Bangkok)

---

## Trailing Stop

```
Phase 1 (normal):      SL = entry ∓ stop
Phase 2 (1R gained):   SL → entry (Breakeven) ← no loss possible
Phase 3 (>1R gained):  SL trails price by 1 stop_dist
Hard TP at 3R (REWARD_RATIO) always active
```

---

## News Filter

ข้าม signal ±30 นาที รอบ high-impact events:
- NFP, CPI, Core CPI, PCE, PPI
- FOMC, Fed Interest Rate
- ECB, BoE, BOJ, RBA, SNB
- GDP, Unemployment, PMI Flash

ดึงจาก ForexFactory API อัตโนมัติ (cache 1 ชั่วโมง)  
เพิ่ม event เองได้ผ่าน Redis key `polis:news_events`

---

## Signal Service (Paid Channel)

```
Customer → /subscribe → เลือกแผน → สแกน PromptPay → กรอก Telegram
                ↓
Admin ← Telegram notification: /approve <id>
                ↓
System → เพิ่ม subscriber + ส่ง invite link
                ↓
ทุก POLIS trade → signal ส่งไป Telegram channel ทันที
```

**Plans:** monthly / quarterly / annual (ตั้งราคาใน .env)

---

## THB Display

- อัตรา USD/THB ดึงจาก [open.er-api.com](https://open.er-api.com) refresh ทุกชั่วโมง
- Fallback: ค่า `THB_PER_USD` ใน `.env`
- เป้าหมายวันละ `DAILY_TARGET_THB` บาท — แสดงใน Calendar 🎯

---

## Troubleshooting

**ไม่มี signal**
```bash
docker compose logs kernel | grep -E "SIGNAL|ERROR"
# ตรวจสอบว่า GEMINI_API_KEY หรือ GROQ_API_KEY ถูกต้อง
```

**Circuit Breaker triggered**
```
/resume  ← ส่งทาง Telegram
```

**Build timeout**
```bash
# Kernel Dockerfile มี ENV PIP_DEFAULT_TIMEOUT=120 แล้ว
# ถ้ายัง timeout ลอง retry
docker compose build kernel
docker compose up -d kernel
```

**Dashboard ไม่ขึ้น**
```bash
docker compose logs dashboard --tail 20
```

---

## Rebuild Commands

```bash
# rebuild ทั้งหมด
docker compose up -d --build

# rebuild เฉพาะ service
docker compose build kernel && docker compose up -d kernel
docker compose build gateway && docker compose up -d gateway
docker compose build dashboard && docker compose up -d dashboard
```

---

*POLIS AI Trading OS — © 2026*
