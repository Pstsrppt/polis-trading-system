# อุปสรรคและบทเรียน / Challenges & Lessons Learned

> บันทึกปัญหาที่เจอจริงระหว่างพัฒนา POLIS — รวบรวมจากบันทึกการทำงาน 4 sessions (2026-06-14 → 2026-09-12) และประวัติ git

**ขนาดโปรเจค:** Python 11,287 บรรทัด · TypeScript 10,757 บรรทัด · 52 ไฟล์ Python · 7 Docker services · 22 หน้า dashboard

---

## สารบัญปัญหา / Defect Register

| # | รหัส | ปัญหา | สถานะ |
|---|------|-------|-------|
| 1 | `UNIT-SCALE` | หน่วยของแต่ละสินทรัพย์ไม่เท่ากัน | แก้แล้ว |
| 2 | `RISK-ENGINE` | Circuit Breaker ตัดผิดจังหวะ (เจอซ้ำ 3 รอบ) | แก้แล้ว |
| 3 | `API-QUOTA` | ชนเพดาน API ฟรีทุกทาง | บรรเทาแล้ว |
| 4 | `TYPE-BOUNDARY` | Bug ที่ขอบเขตของ type | แก้แล้ว |
| 5 | `EVENT-WIRING` | Event chain ต่อไม่ครบ / ทำงานซ้ำ | แก้แล้ว |
| 6 | `CONFIG-DRIFT` | config บอกอย่าง โค้ดอ่านอีกอย่าง | แก้แล้ว |
| 7 | `SECRET-PLUMBING` | ล็อกอินไม่ได้เพราะลืมต่อท่อ secret | แก้แล้ว |
| 8 | `REAL-WORLD` | ข้อจำกัดที่โค้ดแก้ไม่ได้ | ยอมรับ |
| 9 | `SCALE` | โปรเจคโตเร็วเกินจะนำทางไหว | บรรเทาแล้ว |

---

## 1. `UNIT-SCALE` — หน่วยของแต่ละสินทรัพย์ไม่เท่ากัน

ปัญหาที่หนักที่สุดของโปรเจค เกิดตอนขยายจาก XAU/USD ตัวเดียวเป็นหลาย symbol

**สาเหตุราก:** โค้ดเดิม hardcode สูตรของทองคำไว้ทั่วทั้งระบบ (1 lot = 100 units) แต่ความจริงแต่ละสินทรัพย์ไม่เหมือนกันเลย

| Symbol | Units / Lot |
|--------|------------|
| XAUUSD | 100 oz |
| EURUSD / GBPUSD | 100,000 |
| XAGUSD | 5,000 oz |
| BTCUSD | 1 |

**อาการที่โผล่ออกมา** — ดูไม่เกี่ยวกันเลยทั้งที่มาจากสาเหตุเดียว

- EUR/USD คำนวณ position ได้ 100 lots (ใช้ `stop × 100` แทน `× 100,000`)
- P&L ผิด 1,000 เท่า (`trade_tracker.py` ใช้ `lots × 100` กับทุก symbol)
- Portfolio notional มั่ว (SQL ใน gateway ใช้ `lots × 100 × price`)
- ส่งออเดอร์เป็น `XAU_USD` เสมอ (broker hardcode instrument)
- BTC โดน `POLICY_BLOCKED` ทุกครั้ง (ATR ตั้ง 0.012 = เสี่ยง 1.8% เกินเพดาน)
- ราคา EUR/USD แสดงเป็น `$1` บน dashboard (`toFixed(0)` กับทุกราคา)
- Memory ข้าม symbol — ความทรงจำของ BTCUSD ไปมีผลกับ EURUSD

**วิธีแก้:** ย้ายความรู้เรื่องหน่วยมาไว้ที่เดียวเป็น dict กลาง — `_CONTRACT` (kernel), `_UNITS_PER_LOT` (gateway + tracker), `CONTRACT_UNITS` + `fmtPrice()` (dashboard) และใส่ Qdrant filter แยก memory ตาม symbol

**บทเรียน:** สมมติฐานเงียบๆ ที่ hardcode กระจายอยู่ 6-7 ไฟล์ที่ไม่ได้เกี่ยวข้องกัน อันตรายกว่า bug ที่ crash ทันที เพราะมันไม่ error — มันแค่ให้คำตอบผิด

---

## 2. `RISK-ENGINE` — Circuit Breaker ตัดผิดจังหวะ

ปัญหาเชิงตรรกะที่กลับมาหลอก **3 รอบ** เพราะระบบแยกไม่ออกระหว่าง *"ปฏิเสธตามกฎ"* กับ *"ขาดทุนจริง"*

| รอบ | อาการ | สาเหตุ | วิธีแก้ |
|-----|-------|--------|---------|
| 1 | CB ตัดตั้งแต่เทรดแรก | นับ notional (~$12,600) เทียบงบ $620 | `trade_handler` คำนวณ `risk_usd` ส่งไปกับ event |
| 2 | ตอนกลางคืน CB ตัดเอง | signal ที่ถูกปฏิเสธเพราะ "นอกเวลาเทรด" ถูกนับเป็น reject สะสม | log เป็น `SIGNAL_SKIPPED` แล้ว return ไม่ publish |
| 3 | CB ยังตัดจาก policy block | `POLICY_BLOCKED` ยังนับรวมอยู่ | แยกออกจากตัวนับ (commit 2026-09-10) |

**บทเรียน:** ต้องออกแบบตั้งแต่ระดับ event ให้แยก "ระบบบอกว่าไม่" ออกจาก "เสียเงินจริง" ไม่ใช่ไปแก้ทีหลังที่ตัวนับ

---

## 3. `API-QUOTA` — ชนเพดาน API ฟรีทุกทาง

- **TwelveData** ฟรี 800 credits/วัน (reset เที่ยงคืน UTC = 07:00 กรุงเทพ) ต้องจูน poll interval เป็น 1,800 วินาที → signal publisher ใช้ ~288 credits/วัน + world model ~192 credits/วัน
- โดน HTTP 429 เมื่อไหร่ `world_model.py` ต้อง fallback ไป **yfinance** อัตโนมัติ
- **DXY** TwelveData ไม่รองรับเลย ต้องดึงจาก yfinance แยกตั้งแต่แรก
- **LLM** แต่ละเจ้ามีโควต้ารายวัน ต้องทำ fallback chain 3 ชั้น เริ่มจาก Gemini → Groq → OpenRouter ภายหลังสลับให้ **Groq เป็นตัวหลัก** เพราะเร็วกว่าและไม่มีโควต้ารายวัน

**บทเรียน:** ทุก external API ต้องมีทางหนีตั้งแต่วันแรก ไม่ใช่รอให้ล่มก่อน

---

## 4. `TYPE-BOUNDARY` — Bug ที่ขอบเขตของ type

- `decimal.Decimal × float` crash — asyncpg คืนค่า `NUMERIC` เป็น `Decimal` ไม่ใช่ `float` ต้อง cast ที่ขอบของ DB
- `win_r = wins / closed * 100` → TypeError เพราะ `wins` เป็น list ไม่ใช่ตัวเลข
- TypeScript build พังจาก `as const` และ optional field จนต้องมี commit แยกมาแก้โดยเฉพาะ

**บทเรียน:** ขอบเขตระหว่างระบบ (DB → Python, API → TypeScript) คือจุดที่ type หลุดเสมอ ต้อง cast ให้ชัดตรงนั้น

---

## 5. `EVENT-WIRING` — Event chain ต่อไม่ครบ / ทำงานซ้ำ

- **listener ไม่ถูกสตาร์ท** — TradingView ยิง webhook เข้ามาแต่ kernel ไม่รับ เพราะ `ext_signals` ถูก start เฉพาะบางค่า `SIGNAL_SOURCE` แก้โดยให้ start เสมอ
- **ปิดออเดอร์ซ้ำซ้อน** — กดปิดจาก dashboard แล้ว kernel ปิดซ้ำอีกรอบ ต้องเพิ่ม `_on_closed_external()`
- **วิเคราะห์ซ้ำ** — signal เดิมเข้ามาระหว่างยังวิเคราะห์ไม่เสร็จ ต้องทำ `_in_flight` dedup
- ต้องเข้าใจความต่างของ `bus.dispatch` (in-process เท่านั้น) กับ `bus.publish` (in-process + Redis) ไม่งั้น event หายเงียบ

---

## 6. `CONFIG-DRIFT` — config บอกอย่าง โค้ดอ่านอีกอย่าง

`.env.example` เขียนว่า `MAX_RISK_PER_TRADE` แต่ kernel อ่าน `MAX_RISK` — และ `PolicyEngine` ยัง hardcode 0.5% ทิ้งค่าจาก env ทั้งหมด ผลคือปรับ `.env` เท่าไหร่ก็ไม่มีผล

เป็น bug ประเภท **"ไม่ error แต่ไม่ทำงาน"** ซึ่งหายากที่สุด สุดท้ายต้องเพิ่ม `_validate_env()` ตอน boot เพื่อดักตั้งแต่ต้น

---

## 7. `SECRET-PLUMBING` — ล็อกอินไม่ได้เพราะลืมต่อท่อ secret

commit `fix: security hardening` (2026-09-09) ทำถูกหลักการทุกข้อ:

- ลบรหัสผ่าน default ออกจากโค้ด
- ถอด `apps/dashboard/.env.local` ออกจาก git
- ขยาย `.gitignore` ให้ครอบคลุม `.env*`

**แต่ไม่มีใครต่อ `ADMIN_PASSWORD` เข้า container ของ dashboard** ใน `docker-compose.yml` ผลคือ `/api/login` ตอบ `500 Server misconfigured` ทุกครั้ง — ล็อกอินไม่ได้เลยตั้งแต่วันนั้น และไม่มีใครรู้จนถึง 2026-09-12

**วิธีแก้:**

```yaml
  dashboard:
    ports: ["13000:3000"]
    environment:
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
```

ส่งเฉพาะตัวแปรที่จำเป็น ไม่ใช้ `env_file: .env` ทั้งไฟล์ เพื่อไม่ให้ API key และข้อมูล MT5 หลุดเข้าไปใน container ของหน้าเว็บ

**บทเรียน:** เปลี่ยนให้ปลอดภัยขึ้น + ลืมต่อ config = ระบบล่มแบบเงียบๆ ทุกครั้งที่ถอด default ออก ต้องตามไปดูทุกที่ที่ใช้ค่านั้น

---

## 8. `REAL-WORLD` — ข้อจำกัดที่โค้ดแก้ไม่ได้

- **MT5 รันใน Docker ไม่ได้** ต้องแยก bridge ออกมารันบน Windows host แล้วสื่อสารผ่าน Redis
- **รันสองบอทพร้อมกันบนบัญชีเดียวไม่ได้** ต้องแยก demo account คนละตัว
- **บอทซ้อนออเดอร์เองและ hedge ตัวเอง** ต้องเขียน duplicate check + anti-hedge เพิ่มใน bridge
- **BTCUSD win rate 27% ขาดทุน -$26,000** สุดท้ายตัดสินใจปิดการเทรด symbol นี้ผ่าน Redis

**บทเรียน:** ปัญหาบางอย่างแก้ด้วยโค้ดไม่ได้ ต้องแก้ด้วยการยอมรับว่ากลยุทธ์ใช้กับสินทรัพย์นั้นไม่ได้

---

## 9. `SCALE` — โปรเจคโตเร็วเกินจะนำทางไหว

- dashboard เคยมี 11 หน้าย่อยจนหาอะไรไม่เจอ ต้องยุบเหลือ **4 กลุ่มหน้า** (commit 2026-09-10)
- ตอนแก้ `UNIT-SCALE` ต้องไล่แก้ kernel + gateway + dashboard + tools พร้อมกันทั้ง 4 ชั้นในครั้งเดียว เพราะทุกอย่างผูกกันหมด

---

## บทเรียนสรุป / Key Takeaways

1. **สมมติฐานที่ hardcode กระจายหลายไฟล์ อันตรายกว่า bug ที่ crash** — เพราะมันไม่ error มันแค่ให้คำตอบผิด
2. **แยก "ปฏิเสธตามกฎ" ออกจาก "ขาดทุนจริง" ตั้งแต่ออกแบบ event** ไม่ใช่ไปแก้ทีหลังที่ตัวนับ
3. **ทุก external API ต้องมี fallback ตั้งแต่วันแรก** โควต้าฟรีหมดเร็วกว่าที่คิดเสมอ
4. **เปลี่ยนให้ปลอดภัยขึ้นต้องตามไปต่อ config ทุกที่ที่ใช้** ไม่งั้นได้ระบบที่ปลอดภัยแต่ใช้ไม่ได้
5. **bug ที่เงียบหายากที่สุด** ต้องมี validation ตอน boot ไม่ใช่รอให้ผู้ใช้มาเจอ

---

## ที่ยังค้างอยู่ / Open Items

- [ ] Deploy ขึ้น production — ต้องมี VPS, SSL, เปลี่ยน `NEXT_PUBLIC_GATEWAY_URL` เป็น domain จริง, ตั้ง `PROMPTPAY_NUMBER` จริง
- [ ] ติดตั้ง Tailscale บนมือถือ (ติดตั้งบน PC แล้ว)
- [ ] MT5 Bridge ยังไม่ได้รัน — ต้องรัน `python tools/polis_mt5_bridge.py` บน Windows host
