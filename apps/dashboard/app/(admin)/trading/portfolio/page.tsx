"use client";
import { useEffect, useRef, useState } from "react";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

type Decision     = { id:number; symbol:string; direction:string; outcome:string; price:number|null; risk:number|null; stop:number|null; lots:number|null; confidence:number|null; reason:string|null; broker_order_id:string|null; fill_price:number|null; exit_price:number|null; pnl_usd:number|null; trade_result:string|null; created_at:string };
type OpenPosition  = { symbol:string; direction:string; total_lots:number; avg_entry:number; notional:number; trades:{id:number;direction:string;price:number;stop:number;lots:number;created_at:string}[] };
type EquityPoint   = { ts:string|null; pnl:number; cum_pnl:number; trade_result:string; symbol:string; direction:string };
type WorldPrices   = { gold_price?:number; eur_price?:number; btc_price?:number; dxy_price?:number };

// Map symbol → world price field (only symbols present in world model)
const WORLD_PRICE_KEY: Partial<Record<string, keyof WorldPrices>> = {
  XAUUSD: "gold_price",
  EURUSD: "eur_price",
  BTCUSD: "btc_price",
};

function ยังไม่รับรู้Pnl(pos: OpenPosition, worldPrices: WorldPrices): number | null {
  const key = WORLD_PRICE_KEY[pos.symbol];
  if (!key) return null;
  const curPrice = worldPrices[key];
  if (!curPrice || !pos.avg_entry) return null;
  const units = CONTRACT_UNITS[pos.symbol] ?? 100;
  const diff  = pos.direction === "long"
    ? curPrice - pos.avg_entry
    : pos.avg_entry - curPrice;
  return Math.round(diff * pos.total_lots * units * 100) / 100;
}

const pnlFmt  = (v:number) => (v>=0?"+":"")+`$${Math.abs(v).toFixed(0)}`;
const pct     = (n:number,d:number) => d>0?+(n/d*100).toFixed(1):0;
const fmtPrice = (v:number) => v < 10 ? `$${v.toFixed(5)}` : v < 1000 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`;

const CONTRACT_UNITS: Record<string,number> = {
  XAUUSD: 100,
  EURUSD: 100_000,
  GBPUSD: 100_000,
  BTCUSD: 1,
  XAGUSD: 5_000,
};

function Chip({label,color}:{label:string;color:string}){
  return(
    <span style={{
      display:"inline-flex",alignItems:"center",fontSize:9,fontWeight:700,
      padding:"3px 8px",borderRadius:6,background:color+"18",color,
      border:`1px solid ${color}30`,letterSpacing:"0.06em",
      textTransform:"uppercase" as const,whiteSpace:"nowrap" as const,lineHeight:1.4,
    }}>{label}</span>
  );
}

function Card({children,style,accent}:{children:React.ReactNode;style?:React.CSSProperties;accent?:string}){
  return(
    <div style={{
      background:"#ffffff",
      border:`1px solid ${accent?accent+"22":"rgba(0,0,0,0.07)"}`,
      borderRadius:16,padding:"20px 22px",
      boxShadow:"0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.04)",
      ...style,
    }}>{children}</div>
  );
}

function SectionLabel({icon,label,accent="#6366f1",right}:{icon:string;label:string;accent?:string;right?:React.ReactNode}){
  return(
    <div style={{
      display:"flex",alignItems:"center",gap:10,
      margin:"28px 0 14px",padding:"10px 16px",borderRadius:10,
      background:`linear-gradient(90deg,${accent}14,transparent)`,
      borderLeft:`3px solid ${accent}`,
    }}>
      <span style={{fontSize:15}}>{icon}</span>
      <span style={{fontSize:10,fontWeight:800,color:"#1e293b",letterSpacing:"0.12em",textTransform:"uppercase" as const,flex:1}}>{label}</span>
      {right}
    </div>
  );
}

/* ── TradingView Chart ───────────────────────────────────────────────── */
const TV_SYMBOLS: Record<string, string> = {
  XAUUSD: "TVC:GOLD",
  EURUSD: "FX:EURUSD",
  GBPUSD: "FX:GBPUSD",
  BTCUSD: "COINBASE:BTCUSD",
};

function TradingViewChart({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Clear any previous widget (handles React StrictMode double-run)
    el.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "tradingview-widget-container";
    wrap.style.cssText = "height:100%;width:100%";

    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.cssText = "height:100%;width:100%";
    wrap.appendChild(inner);

    const script = document.createElement("script");
    script.src  = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize:         true,
      symbol,
      interval:         "60",
      timezone:         "Asia/Bangkok",
      theme:            "dark",
      style:            "1",
      locale:           "en",
      gridColor:        "rgba(0,0,0,0.03)",
      backgroundColor:  "rgba(13,17,23,0)",
      hide_top_toolbar: false,
      hide_legend:      false,
      save_image:       false,
      calendar:         false,
      support_host:     "https://www.tradingview.com",
    });
    wrap.appendChild(script);
    el.appendChild(wrap);

    return () => { el.innerHTML = ""; };
  }, [symbol]);

  return (
    <div ref={ref}
      style={{ height: 420, width: "100%", borderRadius: 12, overflow: "hidden" }} />
  );
}

/* ── Close Trade Row ─────────────────────────────────────────────────── */
function CloseTradeRow({t,onClosed}:{t:{id:number;price:number;direction:string;stop:number;lots:number;created_at:string};onClosed:()=>void}){
  const[open,setOpen]=useState(false);
  const[exitVal,setExitVal]=useState(t.price.toString());
  const[busy,setBusy]=useState(false);
  const[err,setErr]=useState("");

  const submit=async()=>{
    const ep=parseFloat(exitVal);
    if(!ep||ep<=0){setErr("ราคา > 0");return;}
    setBusy(true);setErr("");
    try{
      const r=await fetch(`${GW}/trades/${t.id}/close`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({exit_price:ep}),
      });
      if(!r.ok){const d=await r.json();setErr(d.detail??"error");return;}
      onClosed();
    }catch(e){setErr("Network error");}
    finally{setBusy(false);}
  };

  return(
    <div style={{borderBottom:"1px solid rgba(0,0,0,0.03)"}}>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:10,alignItems:"center"}}>
        <span style={{color:"#475569"}}>#{t.id} {t.direction.toUpperCase()}</span>
        <span style={{color:"#64748b",fontFamily:"var(--font-mono,monospace)"}}>{fmtPrice(t.price)}</span>
        <button type="button" onClick={()=>setOpen(p=>!p)} style={{
          fontSize:8,padding:"2px 7px",borderRadius:5,cursor:"pointer",fontWeight:700,
          border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)",color:"#ef4444",
        }}>✕ Close</button>
      </div>
      {open&&(
        <div style={{padding:"8px 0 6px",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" as const}}>
          <span style={{fontSize:9,color:"#64748b"}}>ราคาออก:</span>
          <input
            type="number" step="any" value={exitVal}
            placeholder="exit price"
            title="ราคาออก"
            onChange={e=>setExitVal(e.target.value)}
            style={{width:90,padding:"3px 7px",borderRadius:5,border:"1px solid rgba(0,0,0,0.1)",
              background:"#f1f5f9",color:"#0f172a",fontSize:11,fontFamily:"var(--font-mono,monospace)"}}
          />
          <button type="button" onClick={submit} disabled={busy} style={{
            padding:"3px 11px",borderRadius:5,cursor:"pointer",fontWeight:700,fontSize:9,
            border:"1px solid rgba(16,185,129,0.4)",background:"rgba(16,185,129,0.12)",
            color:busy?"#334155":"#10b981",
          }}>{busy?"…":"ยืนยัน"}</button>
          <button type="button" onClick={()=>{setOpen(false);setErr("");}} style={{
            padding:"3px 9px",borderRadius:5,cursor:"pointer",fontSize:9,
            border:"1px solid rgba(0,0,0,0.06)",background:"transparent",color:"#64748b",
          }}>Cancel</button>
          {err&&<span style={{fontSize:9,color:"#ef4444"}}>{err}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Open Position Card ──────────────────────────────────────────────── */
function PositionCard({pos,onRefresh,worldPrices}:{pos:OpenPosition;onRefresh:()=>void;worldPrices:WorldPrices}){
  const col=pos.direction==="long"?"#10b981":"#ef4444";
  const upnl    = ยังไม่รับรู้Pnl(pos, worldPrices);
  const upnlCol = upnl==null?"#475569":upnl>=0?"#10b981":"#ef4444";
  return(
    <Card accent={col}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14}}>
        <div>
          <div style={{fontSize:20,fontWeight:800,color:"#0f172a",letterSpacing:"-0.02em"}}>{pos.symbol}</div>
          <div style={{display:"flex",gap:6,marginTop:5,alignItems:"center"}}>
            <Chip label={pos.direction.toUpperCase()} color={col}/>
            <span style={{fontSize:9,color:"#475569"}}>{pos.trades.length} trade{pos.trades.length>1?"s":""}</span>
          </div>
        </div>
        <div style={{textAlign:"right" as const}}>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:4}}>มูลค่า</div>
          <div style={{fontSize:22,fontWeight:800,color:"#22d3ee",fontFamily:"var(--font-mono,monospace)"}}>${(pos.notional/1000).toFixed(1)}k</div>
          {upnl!=null&&(
            <div style={{fontSize:11,fontWeight:700,color:upnlCol,fontFamily:"var(--font-mono,monospace)",marginTop:2}}>
              {pnlFmt(upnl)} ยังไม่รับรู้
            </div>
          )}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
        {[
          {l:"Avg Entry",v:fmtPrice(pos.avg_entry),c:"#f1f5f9"},
          {l:"ล็อตรวม",v:pos.total_lots.toFixed(2),c:"#94a3b8"},
        ].map(r=>(
          <div key={r.l} style={{padding:"8px 10px",borderRadius:9,background:"#f8fafc"}}>
            <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:3}}>{r.l}</div>
            <div style={{fontSize:16,fontWeight:700,color:r.c,fontFamily:"var(--font-mono,monospace)"}}>{r.v}</div>
          </div>
        ))}
      </div>
      <div style={{borderTop:"1px solid rgba(0,0,0,0.05)",paddingTop:10}}>
        {pos.trades.slice(0,4).map((t)=>(
          <CloseTradeRow key={t.id} t={t} onClosed={onRefresh}/>
        ))}
        <ShareTradeButton pos={pos}/>
      </div>
    </Card>
  );
}

/* ── Share Trade Button ─────────────────────────────────────────────────── */
function ShareTradeButton({pos}:{pos:OpenPosition}){
  const[sharing,  setSharing]  = useState(false);
  const[shared,   setShared]   = useState(false);
  const[shareErr, setShareErr] = useState("");

  const share = async () => {
    setSharing(true); setShareErr(""); setShared(false);
    const dir    = pos.direction==="long"?"LONG 📈":"SHORT 📉";
    const caption = `🔴 LIVE TRADE — AI is in the market!\n\n${dir} ${pos.symbol}\n💰 Entry: ${fmtPrice(pos.avg_entry)}\n📦 ${pos.total_lots.toFixed(2)} lots\n💵 มูลค่า: $${(pos.notional/1000).toFixed(1)}k\n\nPOLIS AI Trading OS — watching 24/7`;
    try{
      const r = await fetch(`${GW}/social/queue`,{
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          source:"trading", type:"text",
          platforms:["twitter","linkedin","instagram","tiktok"],
          title:`${dir} ${pos.symbol} — Live Trade`,
          caption,
          hashtags:["AITrading","POLIS",pos.symbol.toLowerCase(),"LiveTrade"],
          metadata:{symbol:pos.symbol, direction:pos.direction, entry:pos.avg_entry},
        }),
      });
      if(r.ok){setShared(true); setTimeout(()=>setShared(false),3000);}
      else setShareErr("Failed");
    }catch{setShareErr("Network error");}
    finally{setSharing(false);}
  };

  return(
    <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid rgba(0,0,0,0.03)"}}>
      <button type="button" onClick={share} disabled={sharing} style={{
        width:"100%",padding:"5px",borderRadius:7,fontSize:9,fontWeight:700,cursor:"pointer",
        border:"1px solid rgba(236,72,153,0.3)",background:"rgba(236,72,153,0.06)",
        color:sharing?"#334155":shared?"#10b981":"#ec4899",transition:"all 0.2s",
      }}>
        {sharing?"⏳ Adding…":shared?"✅ Added to Social Queue!":"📱 Share this Trade"}
      </button>
      {shareErr&&<div style={{fontSize:8,color:"#ef4444",marginTop:3,textAlign:"center" as const}}>{shareErr}</div>}
    </div>
  );
}

/* ── Equity Curve ────────────────────────────────────────────────────── */
function EquityCurve({points}:{points:EquityPoint[]}){
  if(points.length<2) return(
    <div style={{color:"#475569",textAlign:"center" as const,padding:"40px 0",fontSize:12,fontStyle:"italic"}}>
      {points.length===0?"รอเทรดที่ปิดแล้ว…":"ต้องมี ≥ 2 เทรดที่ปิดเพื่อแสดงกราฟ"}
    </div>
  );
  const W=600,H=110,P=10;
  const cum=points[points.length-1].cum_pnl;
  const mn=Math.min(...points.map(p=>p.cum_pnl),0);
  const mx=Math.max(...points.map(p=>p.cum_pnl),1);
  const range=mx-mn||1;
  const pts=points.map((p,i)=>({
    x:P+(i/(points.length-1))*(W-P*2),
    y:P+(1-(p.cum_pnl-mn)/range)*(H-P*2),
    win:p.trade_result==="WIN",
  }));
  const zy=P+(1-(0-mn)/range)*(H-P*2),col=cum>=0?"#10b981":"#ef4444";
  const poly=pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area=`M ${pts[0].x},${zy} ${pts.map(p=>`L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} L ${pts[pts.length-1].x},${zy} Z`;
  const wins=points.filter(p=>p.trade_result==="WIN").length;
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
        <div>
          <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:4}}>Cumulative P&L</div>
          <div style={{fontSize:38,fontWeight:800,color:col,fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>{pnlFmt(cum)}</div>
        </div>
        <div style={{textAlign:"right" as const}}>
          <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:4}}>Win Rate</div>
          <div style={{fontSize:30,fontWeight:800,color:wins/points.length>=0.5?"#10b981":"#ef4444",fontFamily:"var(--font-mono,monospace)"}}>{(wins/points.length*100).toFixed(0)}%</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:100,display:"block"}}>
        <defs>
          <linearGradient id="ecG2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.3"/>
            <stop offset="100%" stopColor={col} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {mn<0&&mx>0&&<line x1={P} y1={zy} x2={W-P} y2={zy} stroke="rgba(0,0,0,0.05)" strokeWidth={1} strokeDasharray="4,4"/>}
        <path d={area} fill="url(#ecG2)"/>
        <polyline points={poly} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"/>
        {pts.map((p,i)=>(
          <circle key={i} cx={p.x} cy={p.y} r={2.5}
            fill={p.win?"#10b981":"#ef4444"}
            stroke="rgba(6,10,20,0.8)" strokeWidth={1.5}/>
        ))}
      </svg>
      <div style={{display:"flex",gap:14,marginTop:8,fontSize:10,color:"#64748b"}}>
        <span>✅ {wins} wins</span>
        <span>❌ {points.length-wins} losses</span>
        <span style={{marginLeft:"auto"}}>{points.length} closed</span>
      </div>
    </div>
  );
}

/* ── Approval Bar ────────────────────────────────────────────────────── */
function ApprovalBar({decisions}:{decisions:Decision[]}){
  const total=decisions.length,app=decisions.filter(d=>d.outcome==="APPROVED").length;
  const p=pct(app,total),col=p>=55?"#10b981":p>=40?"#f59e0b":"#ef4444";
  const avgConf=decisions.filter(d=>d.confidence!=null);
  const avg=avgConf.length>0?(avgConf.reduce((s,d)=>s+(d.confidence??0),0)/avgConf.length).toFixed(0):"—";
  return(
    <div>
      <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:8}}>Approval Rate</div>
      <div style={{fontSize:40,fontWeight:800,color:col,fontFamily:"var(--font-mono,monospace)",lineHeight:1,marginBottom:12}}>
        {p.toFixed(0)}<span style={{fontSize:20}}>%</span>
      </div>
      <div style={{height:6,background:"rgba(0,0,0,0.04)",borderRadius:3,overflow:"hidden",marginBottom:14}}>
        <div style={{height:"100%",width:`${p}%`,borderRadius:3,background:`linear-gradient(90deg,${col}88,${col})`,boxShadow:`0 0 8px ${col}44`,transition:"width 1s"}}/>
      </div>
      {[
        {label:"อนุมัติ",value:app.toString(),color:"#10b981"},
        {label:"ถูกบล็อก", value:String(total-app),color:"#f59e0b"},
        {label:"เชื่อมั่นเฉลี่ย",value:`${avg}%`,color:"#64748b"},
      ].map(r=>(
        <div key={r.label} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid rgba(0,0,0,0.03)",fontSize:11}}>
          <span style={{color:"#64748b"}}>{r.label}</span>
          <span style={{color:r.color,fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Confidence Histogram ────────────────────────────────────────────── */
function ConfHist({decisions}:{decisions:Decision[]}){
  const bins=[
    {l:"<40",mn:0, mx:40, c:"#ef4444"},
    {l:"40s",mn:40,mx:60, c:"#f59e0b"},
    {l:"60s",mn:60,mx:70, c:"#eab308"},
    {l:"70s",mn:70,mx:80, c:"#84cc16"},
    {l:"80s",mn:80,mx:90, c:"#10b981"},
    {l:"90+",mn:90,mx:101,c:"#22d3ee"},
  ].map(b=>({...b,n:decisions.filter(d=>d.confidence!=null&&d.confidence>=b.mn&&d.confidence<b.mx).length}));
  const max=Math.max(...bins.map(b=>b.n),1);
  return(
    <div>
      <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:14}}>Confidence Dist.</div>
      <div style={{display:"flex",alignItems:"flex-end",gap:6,height:72,marginBottom:8}}>
        {bins.map(b=>(
          <div key={b.l} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",height:"100%"}}>
            <div style={{fontSize:9,color:"#64748b",fontWeight:700,marginBottom:3}}>{b.n||""}</div>
            <div style={{flex:1,width:"100%",display:"flex",alignItems:"flex-end"}}>
              <div style={{width:"100%",borderRadius:"4px 4px 0 0",height:`${Math.max(b.n/max*100,b.n>0?6:0)}%`,background:`linear-gradient(180deg,${b.c},${b.c}88)`,boxShadow:b.n>0?`0 0 10px ${b.c}44`:undefined,transition:"height 0.6s"}}/>
            </div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:6}}>
        {bins.map(b=><div key={b.l} style={{flex:1,fontSize:8,color:"#475569",textAlign:"center" as const}}>{b.l}</div>)}
      </div>
    </div>
  );
}

/* ── Trade Detail Panel ──────────────────────────────────────────────── */
function TradeDetail({d,onClose}:{d:Decision;onClose:()=>void}){
  const ok=d.outcome==="APPROVED",col=ok?"#10b981":"#f59e0b";
  const pnl=d.pnl_usd!=null?Number(d.pnl_usd):null;
  const pc=pnl==null?"#64748b":pnl>=0?"#10b981":"#ef4444";
  const rc=d.trade_result==="WIN"?"#10b981":d.trade_result==="LOSS"?"#ef4444":"#64748b";
  const dirC=d.direction==="long"?"#10b981":"#ef4444";
  const pips=d.price&&d.exit_price?Math.abs(Number(d.exit_price)-Number(d.price)).toFixed(1):null;
  return(
    <div style={{
      margin:"4px 0 8px",borderRadius:12,overflow:"hidden",
      background:"#ffffff",
      border:`1px solid ${ok?col+"30":"rgba(0,0,0,0.06)"}`,
    }}>
      {/* Top bar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"10px 16px",background:`linear-gradient(90deg,${col}10,transparent)`,
        borderBottom:"1px solid rgba(0,0,0,0.04)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:16,fontWeight:800,color:dirC}}>{d.direction==="long"?"▲":"▼"}</span>
          <div>
            <span style={{fontSize:14,fontWeight:800,color:"#0f172a",letterSpacing:"-0.02em"}}>{d.symbol}</span>
            <span style={{fontSize:10,color:"#475569",marginLeft:8}}>#{d.id}</span>
          </div>
          <Chip label={ok?"อนุมัติ":"ถูกบล็อก"} color={col}/>
          {d.trade_result&&<Chip label={d.trade_result} color={rc}/>}
        </div>
        <button type="button" onClick={onClose} style={{
          width:24,height:24,borderRadius:6,border:"1px solid rgba(255,255,255,0.1)",
          background:"rgba(0,0,0,0.03)",color:"#475569",cursor:"pointer",
          fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
        }}>✕</button>
      </div>

      <div style={{padding:"14px 16px",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>

        {/* Price info */}
        <div>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:10,fontWeight:700}}>Price</div>
          {[
            {l:"ราคาเข้า",  v:d.price     ?fmtPrice(Number(d.price)):"—",      c:"#f1f5f9"},
            {l:"ราคาออก",   v:d.exit_price?fmtPrice(Number(d.exit_price)):"—", c:pnl!=null?pc:"#64748b"},
            {l:"สต็อป",     v:d.stop      ?fmtPrice(Number(d.stop)):"—",       c:"#ef4444"},
            {l:"Pip Δ",     v:pips?`${pips} pip`:"—",                           c:"#94a3b8"},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid rgba(0,0,0,0.03)",fontSize:11}}>
              <span style={{color:"#64748b"}}>{r.l}</span>
              <span style={{color:r.c,fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{r.v}</span>
            </div>
          ))}
        </div>

        {/* Risk & P&L */}
        <div>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:10,fontWeight:700}}>Risk & P&L</div>
          {[
            {l:"ล็อต",         v:d.lots      ?Number(d.lots).toFixed(2):"—",             c:"#94a3b8"},
            {l:"ความเสี่ยง %", v:d.risk      ?`${(Number(d.risk)*100).toFixed(2)}%`:"—",      c:"#f59e0b"},
            {l:"เชื่อมั่น",    v:d.confidence!=null?`${d.confidence}%`:"—",                   c:"#818cf8"},
            {l:"P&L",          v:pnl!=null?pnlFmt(pnl):(ok?"เปิดอยู่":"—"),                  c:pc},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid rgba(0,0,0,0.03)",fontSize:11}}>
              <span style={{color:"#64748b"}}>{r.l}</span>
              <span style={{color:r.c,fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{r.v}</span>
            </div>
          ))}
        </div>

        {/* Execution */}
        <div>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:10,fontWeight:700}}>Execution</div>
          {[
            {l:"ราคาที่เติม",  v:d.fill_price?fmtPrice(Number(d.fill_price)):"—",             c:"#94a3b8"},
            {l:"รหัสโบรกเกอร์",v:d.broker_order_id??(ok?"SIM":"—"),                             c:"#64748b"},
            {l:"เปิดเมื่อ",     v:new Date(d.created_at).toLocaleTimeString(),                  c:"#64748b"},
            {l:"ผลลัพธ์",       v:d.trade_result??(ok?"เปิดอยู่":"—"),                          c:rc},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid rgba(0,0,0,0.03)",fontSize:11}}>
              <span style={{color:"#64748b"}}>{r.l}</span>
              <span style={{color:r.c,fontWeight:700,fontFamily:"var(--font-mono,monospace)",
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const,maxWidth:100}}>{r.v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Reason */}
      {d.reason&&(
        <div style={{margin:"0 16px 14px",padding:"10px 14px",borderRadius:9,
          background:"rgba(99,102,241,0.06)",border:"1px solid rgba(99,102,241,0.18)"}}>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:4}}>เหตุผลจาก AI</div>
          <div style={{fontSize:11,color:"#64748b",lineHeight:1.7,fontStyle:"italic"}}>"{d.reason}"</div>
        </div>
      )}
    </div>
  );
}

/* ── History Table ───────────────────────────────────────────────────── */
const TCOLS="68px 46px 68px 44px 66px 50px 62px 54px 1fr 62px";
function HistRow({d,selected,onSelect}:{d:Decision;selected:boolean;onSelect:()=>void}){
  const ok=d.outcome==="APPROVED",col=ok?"#10b981":"#f59e0b";
  const pnl=d.pnl_usd!=null?Number(d.pnl_usd):null;
  const pc=pnl==null?"#475569":pnl>=0?"#10b981":"#ef4444";
  const ps=pnl==null?(ok?"OPEN":"—"):pnlFmt(pnl);
  const rc=d.trade_result==="WIN"?"#10b981":d.trade_result==="LOSS"?"#ef4444":"#475569";
  return(
    <div onClick={onSelect} style={{cursor:"pointer"}}>
      <div style={{
        display:"grid",gridTemplateColumns:TCOLS,gap:5,padding:"7px 10px",borderRadius:7,
        background:selected?"rgba(99,102,241,0.08)":"rgba(0,0,0,0.15)",
        borderLeft:`2px solid ${selected?"#6366f1":col+"44"}`,
        marginBottom:selected?0:2,fontSize:10,alignItems:"center",
        transition:"background 0.15s",
      }}>
        <Chip label={ok?"อนุมัติ":"ถูกบล็อก"} color={col}/>
        <span style={{fontWeight:700,color:"#0f172a"}}>{d.direction.toUpperCase()}</span>
        <span style={{color:"#64748b"}}>{d.symbol}</span>
        <span style={{color:col,fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{d.confidence!=null?`${d.confidence}%`:"—"}</span>
        <span style={{color:"#64748b",fontFamily:"var(--font-mono,monospace)"}}>{d.price?fmtPrice(Number(d.price)):"—"}</span>
        <span style={{color:"#64748b",fontFamily:"var(--font-mono,monospace)"}}>{d.exit_price?fmtPrice(Number(d.exit_price)):"—"}</span>
        <span style={{color:pc,fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{ps}</span>
        <span style={{color:rc,fontWeight:700,fontSize:9}}>{d.trade_result??(ok?"OPEN":"—")}</span>
        <span style={{color:"#475569",overflow:"hidden",whiteSpace:"nowrap" as const,textOverflow:"ellipsis",fontStyle:"italic",fontSize:9}}>{d.reason??""}</span>
        <span style={{color:"#94a3b8",fontSize:9,fontFamily:"var(--font-mono,monospace)"}}>{new Date(d.created_at).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
function HistTable({decisions}:{decisions:Decision[]}){
  const[f,setF]=useState<"ALL"|"APPROVED"|"BLOCKED"|"CLOSED">("ALL");
  const[sel,setSel]=useState<number|null>(null);
  const counts={
    ALL:decisions.length,
    APPROVED:decisions.filter(d=>d.outcome==="APPROVED"&&d.trade_result==null).length,
    BLOCKED:decisions.filter(d=>d.outcome==="BLOCKED").length,
    CLOSED:decisions.filter(d=>d.trade_result!=null).length,
  };
  const filtered=
    f==="ALL"     ?decisions:
    f==="APPROVED"?decisions.filter(d=>d.outcome==="APPROVED"&&d.trade_result==null):
    f==="CLOSED"  ?decisions.filter(d=>d.trade_result!=null):
    decisions.filter(d=>d.outcome===f);
  const selDec=sel!=null?decisions.find(d=>d.id===sel):undefined;
  return(
    <>
      <div style={{display:"flex",gap:6,marginBottom:12,alignItems:"center",flexWrap:"wrap" as const}}>
        {([
          {k:"ALL",    label:"ทั้งหมด"},
          {k:"APPROVED",label:"📂 เปิดอยู่"},
          {k:"CLOSED",  label:"✅ ปิดแล้ว"},
          {k:"BLOCKED", label:"⚠️ ถูกบล็อก"},
        ] as const).map(({k,label})=>{
          const on=f===k;
          return(
            <button key={k} type="button" onClick={()=>{setF(k);setSel(null);}} style={{
              padding:"5px 12px",borderRadius:7,fontSize:10,fontWeight:on?700:400,cursor:"pointer",
              border:`1px solid ${on?"rgba(99,102,241,0.5)":"rgba(0,0,0,0.05)"}`,
              background:on?"rgba(99,102,241,0.15)":"transparent",
              color:on?"#818cf8":"#64748b",transition:"all 0.15s",
            }}>
              {label}<span style={{color:"#94a3b8",marginLeft:4}}>({counts[k]})</span>
            </button>
          );
        })}
        <span style={{marginLeft:"auto",fontSize:9,color:"#475569"}}>{filtered.length} รายการ · คลิกเพื่อดูรายละเอียด</span>
      </div>
      {filtered.length===0?(
        <div style={{color:"#475569",textAlign:"center" as const,padding:"32px 0",fontStyle:"italic"}}>No records yet…</div>
      ):(
        <>
          <div style={{display:"grid",gridTemplateColumns:TCOLS,gap:5,padding:"4px 10px",marginBottom:4}}>
            {["ผล","ทิศทาง","สินทรัพย์","เชื่อมั่น","เข้า","ออก","P&L","ผลลัพธ์","เหตุผล","เวลา"].map(h=>(
              <span key={h} style={{fontSize:8,fontWeight:700,color:"#94a3b8",textTransform:"uppercase" as const,letterSpacing:"0.08em"}}>{h}</span>
            ))}
          </div>
          <div style={{maxHeight:480,overflowY:"auto"}}>
            {filtered.map(d=>(
              <div key={d.id}>
                <HistRow d={d} selected={sel===d.id} onSelect={()=>setSel(p=>p===d.id?null:d.id)}/>
                {sel===d.id&&selDec&&<TradeDetail d={selDec} onClose={()=>setSel(null)}/>}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ══ PORTFOLIO PAGE ══════════════════════════════════════════════════════ */
export default function PortfolioPage(){
  const[decisions,     setDecisions]     = useState<Decision[]>([]);
  const[equityPts,     setEquityPts]     = useState<EquityPoint[]>([]);
  const[openPositions, setOpenPositions] = useState<OpenPosition[]>([]);
  const[brokerLive]                      = useState(false);
  const[maxRisk,       setMaxRisk]       = useState(0.005);
  const[loading,       setLoading]       = useState(true);
  const[worldPrices,   setWorldPrices]   = useState<WorldPrices>({});
  const[chartSymbol,   setChartSymbol]   = useState(TV_SYMBOLS.XAUUSD);

  const loadAll=()=>{
    Promise.all([
      fetch(`${GW}/trades?limit=200`).then(r=>r.json()).then((d:Decision[])=>setDecisions(Array.isArray(d)?d:[])).catch(()=>{}),
      fetch(`${GW}/equity`).then(r=>r.json()).then((d:EquityPoint[])=>setEquityPts(Array.isArray(d)?d:[])).catch(()=>{}),
      fetch(`${GW}/portfolio`).then(r=>r.json()).then((d:unknown)=>{if(Array.isArray(d))setOpenPositions(d as OpenPosition[]);}).catch(()=>{}),
      fetch(`${GW}/control/status`).then(r=>r.json()).then((d:{paused:boolean;max_risk:number})=>setMaxRisk(d.max_risk)).catch(()=>{}),
      fetch(`${GW}/world`).then(r=>r.json()).then((d:WorldPrices)=>setWorldPrices(d)).catch(()=>{}),
    ]).finally(()=>setLoading(false));
  };

  useEffect(()=>{
    loadAll();
    const t=setInterval(loadAll,30_000);
    return()=>clearInterval(t);
  },[]);

  const totalPnl=equityPts.length>0?equityPts[equityPts.length-1].cum_pnl:0;
  const wins=equityPts.filter(p=>p.trade_result==="WIN");
  const wr=pct(wins.length,equityPts.length);
  const today=new Date().toDateString();
  const todayPts=equityPts.filter(p=>p.ts&&new Date(p.ts).toDateString()===today);
  const todayPnl=todayPts.reduce((s,p)=>s+p.pnl,0);
  const app=decisions.filter(d=>d.outcome==="APPROVED");
  const totalLots=app.reduce((s,d)=>s+Number(d.lots??0),0);
  const totalมูลค่า=app.reduce((s,d)=>s+Number(d.lots??0)*(CONTRACT_UNITS[d.symbol]??100)*Number(d.price??0),0);
  const liveFills=app.filter(d=>d.broker_order_id&&d.broker_order_id!=="SIM").length;

  return(
    <div className="dot-bg" style={{minHeight:"100vh",background:"var(--bg)",padding:"24px 28px 48px"}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
        <div>
          <div style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",textTransform:"uppercase" as const,marginBottom:6}}>
            POLIS HQ › เทรด › พอร์ตโฟลิโอ
          </div>
          <div style={{fontSize:24,fontWeight:800,letterSpacing:"-0.03em",color:"#0f172a",lineHeight:1}}>พอร์ตโฟลิโอ & การวิเคราะห์</div>
          <div style={{fontSize:11,color:"#64748b",marginTop:4}}>โพซิชันเปิดอยู่ · ประวัติการเทรด · ผลการดำเนินงาน</div>
        </div>
        <button type="button" onClick={loadAll} style={{padding:"7px 16px",borderRadius:9,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(0,0,0,0.03)",color:"#64748b",fontSize:11,cursor:"pointer",fontWeight:600}}>
          {loading?"กำลังโหลด…":"↻ รีเฟรช"}
        </button>
      </div>

      {/* Summary KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:0}}>
        {[
          {icon:"📊",label:"สินทรัพย์เปิดอยู่",value:openPositions.length.toString(),       color:"#22d3ee"},
          {icon:"💰",label:"P&L รวม",   value:equityPts.length===0?"$0":pnlFmt(totalPnl),color:totalPnl>=0?"#10b981":"#ef4444"},
          {icon:"🗓",label:"P&L วันนี้",   value:todayPts.length===0?"$0":pnlFmt(todayPnl),color:todayPnl>=0?"#10b981":"#ef4444"},
          {icon:"🎯",label:"อัตราชนะ",    value:equityPts.length>0?`${wr.toFixed(0)}%`:"—",color:wr>=50?"#10b981":"#ef4444"},
          {icon:"📋",label:"การตัดสินใจ",   value:decisions.length.toString(),             color:"#818cf8"},
        ].map(k=>(
          <div key={k.label} style={{background:`linear-gradient(135deg,${k.color}14,${k.color}06,transparent)`,border:`1px solid ${k.color}28`,borderRadius:14,padding:"16px 18px",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:12,right:14,fontSize:18,opacity:0.14}}>{k.icon}</div>
            <div style={{fontSize:8,fontWeight:700,color:k.color+"99",letterSpacing:"0.1em",textTransform:"uppercase" as const,marginBottom:5}}>{k.label}</div>
            <div style={{fontSize:30,fontWeight:800,color:k.color,lineHeight:1,fontFamily:"var(--font-mono,monospace)"}}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Live Chart */}
      <SectionLabel icon="📈" label="กราฟแบบเรียลไทม์" accent="#22d3ee"
        right={
          <div style={{display:"flex",gap:6}}>
            {Object.entries(TV_SYMBOLS).map(([label,sym])=>{
              const active=chartSymbol===sym;
              return(
                <button key={sym} type="button" onClick={()=>setChartSymbol(sym)} style={{
                  padding:"3px 10px",borderRadius:7,fontSize:10,fontWeight:active?700:400,
                  cursor:"pointer",border:`1px solid ${active?"rgba(34,211,238,0.5)":"rgba(0,0,0,0.06)"}`,
                  background:active?"rgba(34,211,238,0.12)":"transparent",
                  color:active?"#22d3ee":"#64748b",transition:"all 0.15s",
                }}>{label}</button>
              );
            })}
          </div>
        }/>
      <Card style={{padding:"0",overflow:"hidden"}}>
        <TradingViewChart symbol={chartSymbol}/>
      </Card>

      {/* Open positions */}
      <SectionLabel icon="💼" label="โพซิชันเปิดอยู่" accent="#22d3ee"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>{openPositions.length} symbols · {app.filter(d=>d.trade_result==null).length} open trades</span>}/>
      {openPositions.length===0?(
        <Card>
          <div style={{textAlign:"center" as const,padding:"32px 0",color:"#475569",fontSize:12,fontStyle:"italic"}}>
            ไม่มีโพซิชันเปิดอยู่ — ทุนทั้งหมดรออยู่
          </div>
        </Card>
      ):(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
          {openPositions.map(pos=><PositionCard key={pos.symbol} pos={pos} onRefresh={loadAll} worldPrices={worldPrices}/>)}
        </div>
      )}

      {/* Charts row */}
      <SectionLabel icon="📈" label="ผลการดำเนินงาน" accent="#6366f1"/>
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:12,marginBottom:0}}>
        <Card><EquityCurve points={equityPts}/></Card>
        <Card><ApprovalBar decisions={decisions}/></Card>
        <Card><ConfHist decisions={decisions}/></Card>
      </div>

      {/* Trade history */}
      <SectionLabel icon="📋" label="ประวัติการเทรด" accent="#f59e0b"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>{decisions.length} records</span>}/>
      <Card>
        <HistTable decisions={decisions}/>
      </Card>

      {/* Broker + Policy */}
      <SectionLabel icon="🔌" label="โบรกเกอร์ & นโยบาย" accent="#34d399"/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Card>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:14}}>🔌 โบรกเกอร์</div>
          <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:14,padding:"10px 12px",borderRadius:10,
            background:brokerLive?"rgba(16,185,129,0.08)":"rgba(245,158,11,0.06)",
            border:`1px solid ${brokerLive?"rgba(16,185,129,0.25)":"rgba(245,158,11,0.2)"}`}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:brokerLive?"#10b981":"#f59e0b",boxShadow:`0 0 6px ${brokerLive?"#10b981":"#f59e0b"}`}}/>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:brokerLive?"#10b981":"#f59e0b"}}>{brokerLive?"ซื้อขายจริง":"โหมดจำลอง"}</div>
              <div style={{fontSize:9,color:"#475569"}}>{brokerLive?"เชื่อมต่อ Oanda แล้ว":"ตั้ง OANDA_ENABLED=true"}</div>
            </div>
          </div>
          {[
            {label:"ออเดอร์ทั้งหมด",value:app.length.toString(),color:"#64748b"},
            {label:"เติมจริง",  value:liveFills.toString(), color:liveFills>0?"#10b981":"#475569"},
            {label:"ล็อตรวม",  value:totalLots.toFixed(2),  color:"#64748b"},
            {label:"มูลค่า",    value:`$${(totalมูลค่า/1000).toFixed(1)}k`,color:"#22d3ee"},
          ].map(r=>(
            <div key={r.label} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid rgba(0,0,0,0.03)",fontSize:11}}>
              <span style={{color:"#64748b"}}>{r.label}</span>
              <span style={{color:r.color,fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{r.value}</span>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:14}}>⚙️ นโยบายการเทรด</div>
          <div style={{marginBottom:14,padding:"14px",borderRadius:10,background:"rgba(99,102,241,0.06)",border:"1px solid rgba(99,102,241,0.18)"}}>
            <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:5}}>ความเสี่ยงสูงสุด/ออเดอร์</div>
            <div style={{fontSize:38,fontWeight:800,fontFamily:"var(--font-mono,monospace)",lineHeight:1,
              color:maxRisk<=0.003?"#ef4444":maxRisk>=0.008?"#10b981":"#f59e0b"}}>
              {(maxRisk*100).toFixed(1)}<span style={{fontSize:16}}>%</span>
            </div>
          </div>
          {[
            {l:"งบรายวัน",         value:"$620",      c:"#10b981"},
            {l:"ช่วงความเสี่ยง", value:"0.2–1.0%",  c:"#64748b"},
            {l:"เชื่อมั่นขั้นต่ำ",value:"60%",        c:"#64748b"},
            {l:"ATR/Spread",      value:"≥ 2.0×",    c:"#64748b"},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid rgba(0,0,0,0.03)",fontSize:11}}>
              <span style={{color:"#64748b"}}>{r.l}</span>
              <span style={{color:r.c,fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{r.value}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
