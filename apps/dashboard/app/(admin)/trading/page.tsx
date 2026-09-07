"use client";
import { useEffect, useRef, useState } from "react";

const GW   = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";
const GWWS = process.env.NEXT_PUBLIC_GATEWAY_WS  ?? "ws://localhost:19000/ws/feed";

/* ── types ───────────────────────────────────────────────────────────── */
type Ev           = { topic: string; data: Record<string, unknown>; ts: string };
type Decision     = { id: number; symbol: string; direction: string; outcome: string; price: number|null; risk: number|null; stop: number|null; lots: number|null; confidence: number|null; reason: string|null; broker_order_id: string|null; fill_price: number|null; exit_price: number|null; pnl_usd: number|null; trade_result: string|null; created_at: string };
type WorldData     = { gold_price?:number; gold_prev?:number; gold_chg_pct?:number; dxy_price?:number; dxy_prev?:number; dxy_chg_pct?:number; eur_price?:number; eur_prev?:number; eur_chg_pct?:number; btc_price?:number; btc_prev?:number; btc_chg_pct?:number; fg_value?:number; fg_classification?:string; regime?:string; gold_dxy_divergence?:number; _price_source?:string; ts?:string };
type SvcStatus     = Record<string, string>;
type EquityPoint   = { ts:string|null; pnl:number; cum_pnl:number; trade_result:string };
type OpenPosition  = { ticket:number; symbol:string; direction:string; lots:number; entry:number; current:number; sl:number; tp:number; pnl:number; swap:number; open_time:number };

/* ── constants ───────────────────────────────────────────────────────── */
const EV_COLOR: Record<string,string> = {
  AGENT_HIRED:"#10b981", AGENT_FIRED:"#ef4444", TASK_COMPLETED:"#6366f1",
  POLICY_BLOCKED:"#f59e0b", TRADE_SIGNAL:"#06b6d4", RESEARCH_COMPLETE:"#8b5cf6",
  TRADE_APPROVED:"#10b981", BOARD_RESOLUTION:"#ec4899", POLICY_ADJUSTED:"#ef4444",
  SIGNAL_APPROVED:"#06b6d4", SIGNAL_REJECTED:"#f59e0b", WORLD_UPDATE:"#34d399",
};

/* ── helpers ─────────────────────────────────────────────────────────── */
const pnlFmt  = (v:number) => (v>=0?"+":"")+`$${Math.abs(v).toFixed(0)}`;
const pct     = (n:number,d:number) => d>0?+(n/d*100).toFixed(1):0;
const fmtPrice = (v:number) => v < 10 ? v.toFixed(5) : v < 1000 ? v.toFixed(2) : v.toFixed(0);

function evSummary(ev:Ev):string {
  const d=ev.data;
  switch(ev.topic){
    case "RESEARCH_COMPLETE":{const r=(d.research??{}) as Record<string,unknown>;return`${d.symbol??""} · ${r.sentiment??""} · ${r.confidence??"?"}% conf`;}
    case "TRADE_APPROVED":   return `${String(d.direction??"").toUpperCase()} ${d.symbol} @ $${fmtPrice(Number(d.price??0))}`;
    case "POLICY_BLOCKED":   return `${String(d.direction??"").toUpperCase()} ${d.symbol} — ${d.reason??"blocked"}`;
    case "SIGNAL_REJECTED":  return ((d.rejected_reasons as string[]|undefined)??[]).join(" | ")||"rejected";
    case "BOARD_RESOLUTION": return `${String(d.resolution??"").toUpperCase()} · ${d.directive}`;
    case "POLICY_ADJUSTED":  return `max_risk → ${(Number(d.new_risk??0)*100).toFixed(2)}%`;
    case "AGENT_HIRED":      return `${d.role} joined ${d.division}`;
    case "TRADE_SIGNAL":     return `${String(d.direction??"").toUpperCase()} ${d.symbol} @ $${fmtPrice(Number(d.price??0))}`;
    default: return JSON.stringify(d).slice(0,80);
  }
}

/* ════ UI PRIMITIVES ════════════════════════════════════════════════════ */

function Chip({label,color}:{label:string;color:string}){
  return(
    <span style={{
      display:"inline-flex",alignItems:"center",
      fontSize:9,fontWeight:700,padding:"3px 8px",borderRadius:6,
      background:color+"18",color,border:`1px solid ${color}30`,
      letterSpacing:"0.06em",textTransform:"uppercase" as const,
      whiteSpace:"nowrap" as const,lineHeight:1.4,
    }}>
      {label}
    </span>
  );
}

function Dot({color,pulse}:{color:string;pulse?:boolean}){
  return(
    <div style={{
      width:7,height:7,borderRadius:"50%",flexShrink:0,
      background:color,boxShadow:`0 0 7px ${color}`,
      animation:pulse?"pulse 2s ease-in-out infinite":undefined,
    }}/>
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
    }}>
      {children}
    </div>
  );
}

function SectionLabel({icon,label,accent="#6366f1",right}:{icon:string;label:string;accent?:string;right?:React.ReactNode}){
  return(
    <div style={{
      display:"flex",alignItems:"center",gap:10,
      margin:"30px 0 14px",padding:"10px 16px",borderRadius:10,
      background:`linear-gradient(90deg,${accent}14 0%,transparent 100%)`,
      borderLeft:`3px solid ${accent}`,
    }}>
      <span style={{fontSize:15,lineHeight:1}}>{icon}</span>
      <span style={{fontSize:10,fontWeight:800,color:"#1e293b",letterSpacing:"0.12em",textTransform:"uppercase" as const,flex:1}}>{label}</span>
      {right}
    </div>
  );
}

/* ── Health strip ────────────────────────────────────────────────────── */
function HealthStrip({status}:{status:SvcStatus}){
  const REGIME_VALS = ["RISK-ON","RISK-OFF","NEUTRAL","UNKNOWN"];
  const normalize = (key:string, val:string) =>
    key==="world_model" ? (REGIME_VALS.includes(val) ? "ok" : val) : val;

  const svcs=[
    {key:"gateway",   label:"Gateway"},
    {key:"kernel",    label:"Kernel"},
    {key:"redis",     label:"Redis"},
    {key:"postgres",  label:"DB"},
    {key:"qdrant",    label:"Qdrant"},
    {key:"circuit_breaker", label:"CB"},
  ];
  const sc=(s:string)=>s==="ok"?"#10b981":s==="warn"?"#f59e0b":s==="error"?"#ef4444":"#334155";
  const allOk=svcs.every(sv=>normalize(sv.key,status[sv.key]??"loading")==="ok");
  const col=allOk?"#10b981":"#f59e0b";

  // World model regime display
  const regime = status["world_model"];
  const regimeColor = regime==="RISK-ON"?"#10b981":regime==="RISK-OFF"?"#ef4444":regime==="NEUTRAL"?"#f59e0b":"#334155";

  return(
    <div style={{
      display:"flex",alignItems:"center",gap:14,flexWrap:"wrap" as const,
      padding:"9px 18px",borderRadius:10,marginBottom:20,
      background:`linear-gradient(90deg,${col}0d,rgba(0,0,0,0.1))`,
      border:`1px solid ${col}22`,
    }}>
      <Dot color={col} pulse/>
      <span style={{fontSize:10,fontWeight:800,color:col,letterSpacing:"0.08em"}}>
        {allOk?"ระบบปกติ":"ตรวจสอบด่วน"}
      </span>
      <div style={{width:1,height:12,background:"rgba(0,0,0,0.06)"}}/>
      {svcs.map(sv=>{
        const raw=status[sv.key]??"loading";
        const st=normalize(sv.key,raw);
        const c=sc(st);
        const label=sv.key==="circuit_breaker"&&st==="warn"?"CB ⚠️":sv.label;
        return(
          <div key={sv.key} style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:c,boxShadow:st==="ok"?`0 0 5px ${c}`:"none"}}/>
            <span style={{fontSize:10,color:st==="ok"?"#64748b":"#94a3b8"}}>{label}</span>
          </div>
        );
      })}
      {regime&&REGIME_VALS.includes(regime)&&(
        <>
          <div style={{width:1,height:12,background:"rgba(0,0,0,0.06)"}}/>
          <span style={{fontSize:9,fontWeight:700,color:regimeColor,letterSpacing:"0.06em"}}>{regime}</span>
        </>
      )}
      <span style={{marginLeft:"auto",fontSize:9,color:"#94a3b8",letterSpacing:"0.05em"}}>สุขภาพระบบ · 10s</span>
    </div>
  );
}

/* ── KPI strip ───────────────────────────────────────────────────────── */
function KpiStrip({decisions,events,uptimeMs}:{decisions:Decision[];events:Ev[];uptimeMs:number}){
  const today=new Date().toDateString();
  const todayDec=decisions.filter(d=>new Date(d.created_at).toDateString()===today);
  const sigs=events.filter(e=>e.topic==="TRADE_SIGNAL"&&new Date(e.ts).toDateString()===today).length;
  const app=todayDec.filter(d=>d.outcome==="APPROVED").length;
  const closed=todayDec.filter(d=>d.pnl_usd!=null);
  const dayPnl=closed.reduce((s,d)=>s+Number(d.pnl_usd??0),0);
  const ss=uptimeMs/1000|0;
  const uptime=`${String(ss/3600|0).padStart(2,"0")}:${String(ss%3600/60|0).padStart(2,"0")}:${String(ss%60).padStart(2,"0")}`;
  const kpis=[
    {icon:"📡",label:"สัญญาณ",   sub:"วันนี้",    value:sigs.toString(),                              color:"#22d3ee"},
    {icon:"✅",label:"อนุมัติ",  sub:"วันนี้",    value:app.toString(),                               color:"#10b981"},
    {icon:"💰",label:"P&L",      sub:"วันนี้",    value:closed.length===0?"—":pnlFmt(dayPnl),         color:dayPnl>=0?"#10b981":"#ef4444"},
    {icon:"⏱",label:"เวลาทำงาน", sub:"hh:mm:ss", value:uptime,                                    color:"#818cf8"},
  ];
  return(
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
      {kpis.map(k=>(
        <div key={k.label} style={{
          background:`linear-gradient(135deg,${k.color}14,${k.color}06 60%,transparent)`,
          border:`1px solid ${k.color}28`,borderRadius:16,padding:"20px 22px",
          position:"relative",overflow:"hidden",
        }}>
          <div style={{position:"absolute",top:14,right:16,fontSize:20,opacity:0.15}}>{k.icon}</div>
          <div style={{fontSize:9,fontWeight:700,color:k.color+"99",letterSpacing:"0.1em",textTransform:"uppercase" as const,marginBottom:5}}>
            {k.label} <span style={{opacity:0.6}}>/ {k.sub}</span>
          </div>
          <div style={{fontSize:40,fontWeight:800,color:k.color,lineHeight:1,fontFamily:"var(--font-mono,monospace)",letterSpacing:"-0.02em"}}>
            {k.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Mini Equity Sparkline ───────────────────────────────────────────── */
function MiniEquity({pts}:{pts:EquityPoint[]}){
  const cum=pts.length>0?pts[pts.length-1].cum_pnl:0;
  const col=cum>=0?"#10b981":"#ef4444";
  const wins=pts.filter(p=>p.trade_result==="WIN").length;
  const wr=pts.length>0?Math.round(wins/pts.length*100):0;
  if(pts.length<2)return(
    <div style={{textAlign:"right" as const}}>
      <div style={{fontSize:8,color:"#94a3b8",letterSpacing:"0.08em",textTransform:"uppercase" as const,marginBottom:2}}>Equity</div>
      <div style={{fontSize:12,fontWeight:700,color:"#94a3b8"}}>Awaiting trades…</div>
    </div>
  );
  const W=120,H=32,P=3;
  const mn=Math.min(...pts.map(p=>p.cum_pnl),0),mx=Math.max(...pts.map(p=>p.cum_pnl),0.01),range=mx-mn||1;
  const svgPts=pts.map((p,i)=>({
    x:P+(i/(pts.length-1))*(W-P*2),
    y:P+(1-(p.cum_pnl-mn)/range)*(H-P*2),
  }));
  const poly=svgPts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const zy=P+(1-(0-mn)/range)*(H-P*2);
  const area=`M ${svgPts[0].x},${zy} ${svgPts.map(p=>`L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} L ${svgPts[svgPts.length-1].x},${zy} Z`;
  return(
    <div style={{display:"flex",alignItems:"center",gap:12}}>
      <div style={{textAlign:"right" as const}}>
        <div style={{fontSize:8,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase" as const,marginBottom:2}}>Equity · {pts.length} trades</div>
        <div style={{fontSize:18,fontWeight:800,color:col,fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>
          {cum>=0?"+":""}{`$${Math.abs(cum).toFixed(0)}`}
        </div>
        <div style={{fontSize:9,color:wr>=50?"#10b981":"#ef4444",fontWeight:600,marginTop:2}}>WR {wr}%</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:80,height:26}}>
        <defs>
          <linearGradient id="ovG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.25"/>
            <stop offset="100%" stopColor={col} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path d={area} fill="url(#ovG)"/>
        <polyline points={poly} fill="none" stroke={col} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"/>
      </svg>
    </div>
  );
}

/* ── World Model Panel ───────────────────────────────────────────────── */
function WorldModelPanel({data}:{data:WorldData}){
  const fgVal  = data.fg_value??null;
  const fgColor= fgVal==null?"#475569":fgVal>=75?"#10b981":fgVal>=60?"#84cc16":fgVal>=40?"#f59e0b":fgVal>=25?"#f97316":"#ef4444";
  const chgFmt = (v:number|undefined)=>v!=null?(v>=0?`+${v.toFixed(2)}%`:`${v.toFixed(2)}%`):null;
  const chgCol = (v:number|undefined,invert=false)=>{
    if(v==null)return"#64748b";
    const pos=v>=0;
    return(invert?!pos:pos)?"#10b981":"#ef4444";
  };

  const SESSIONS=[
    {label:"Tokyo",  tz:"Asia/Tokyo",   open:9,  close:18, col:"#f472b6"},
    {label:"London", tz:"Europe/London",open:8,  close:17, col:"#818cf8"},
    {label:"NY",     tz:"America/New_York",open:9,close:17,col:"#22d3ee"},
  ];
  const nowUtc=new Date();
  const sesStatus=SESSIONS.map(s=>{
    const localH  =parseInt(nowUtc.toLocaleString("en-US",{timeZone:s.tz,hour:"2-digit",hour12:false}));
    const dayName =nowUtc.toLocaleString("en-US",{timeZone:s.tz,weekday:"long"});
    const isWeekend=dayName==="Saturday"||dayName==="Sunday";
    const isOpen  =!isWeekend&&localH>=s.open&&localH<s.close;
    return{...s,isOpen,localH};
  });

  const regimeCol=data.regime==="RISK-ON"?"#10b981":data.regime==="RISK-OFF"?"#ef4444":"#f59e0b";

  const xauLive = mt5Prices?.XAUUSD?.mid;
  const eurLive = mt5Prices?.EURUSD?.mid;
  const gbpLive = mt5Prices?.GBPUSD?.mid;
  const prices=[
    {icon:"🥇",label:"XAU/USD",main:xauLive?`$${xauLive.toFixed(2)}`:(data.gold_price?`$${data.gold_price.toFixed(0)}`:"—"),       chg:data.gold_chg_pct,mainC:"#fbbf24",invert:false,live:!!xauLive},
    {icon:"💶",label:"EUR/USD",main:eurLive?eurLive.toFixed(5):(data.eur_price?data.eur_price.toFixed(4):"—"),                       chg:data.eur_chg_pct, mainC:"#22d3ee",invert:false,live:!!eurLive},
    {icon:"🟠",label:"BTC/USD",main:data.btc_price?`$${data.btc_price.toLocaleString("en-US",{maximumFractionDigits:0})}`:"—",       chg:data.btc_chg_pct, mainC:"#f97316",invert:false,live:false},
    {icon:"💵",label:"DXY",    main:data.dxy_price?data.dxy_price.toFixed(2):"—",                                                    chg:data.dxy_chg_pct, mainC:"#818cf8",invert:true, live:false},
  ];

  return(
    <div style={{marginBottom:20}}>
      {/* Row 1: prices */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:10}}>
        {prices.map(p=>{
          const chgStr=chgFmt(p.chg);
          const chgC=chgCol(p.chg,p.invert);
          return(
            <div key={p.label} style={{padding:"14px 16px",borderRadius:12,
              background:"#ffffff",border:"1px solid rgba(0,0,0,0.05)",
              display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:20,flexShrink:0}}>{p.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",fontWeight:700,marginBottom:2,display:"flex",alignItems:"center",gap:4}}>
                  {p.label}
                  {(p as {live?:boolean}).live&&<span style={{display:"inline-block",width:5,height:5,borderRadius:"50%",background:"#10b981",animation:"pulse 1.5s infinite"}} title="MT5 live"/>}
                </div>
                <div style={{fontSize:20,fontWeight:800,color:p.mainC,fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>{p.main}</div>
                {chgStr&&<div style={{fontSize:10,color:chgC,fontWeight:700,marginTop:3}}>{chgStr}</div>}
                {!chgStr&&<div style={{fontSize:9,color:"#94a3b8",marginTop:3}}>no data</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Row 2: regime + F&G gauge + sessions + divergence */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr 1.4fr 1fr",gap:10}}>

        {/* Regime */}
        <div style={{padding:"12px 16px",borderRadius:12,
          background:`${regimeCol}0d`,border:`1px solid ${regimeCol}30`,
          display:"flex",flexDirection:"column" as const,justifyContent:"center"}}>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",fontWeight:700,marginBottom:6}}>สภาวะตลาด</div>
          <div style={{fontSize:18,fontWeight:900,color:regimeCol,letterSpacing:"0.04em"}}>{data.regime??"UNKNOWN"}</div>
          {data.gold_dxy_divergence!=null&&(()=>{
            const div=data.gold_dxy_divergence!;
            const high=Math.abs(div)>=1.0;
            const divC=high?"#f59e0b":"#475569";
            return(
              <div style={{marginTop:6,padding:high?"5px 8px":"0",borderRadius:high?7:0,
                background:high?"rgba(245,158,11,0.08)":"transparent",
                border:high?"1px solid rgba(245,158,11,0.25)":"none",
                display:"flex",alignItems:"center",gap:5}}>
                {high&&<span style={{fontSize:9}}>⚠️</span>}
                <span style={{fontSize:9,color:divC}}>
                  Au/DXY div: <b style={{color:high?"#f59e0b":div>0?"#fbbf24":"#22d3ee"}}>
                    {div>0?"+":""}{div.toFixed(2)}%
                  </b>
                </span>
              </div>
            );
          })()}
        </div>

        {/* Fear & Greed gauge */}
        <div style={{padding:"12px 16px",borderRadius:12,
          background:"#ffffff",border:"1px solid rgba(0,0,0,0.05)"}}>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",fontWeight:700,marginBottom:6}}>Fear & Greed</div>
          {fgVal!=null?(
            <>
              <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:6}}>
                <span style={{fontSize:26,fontWeight:900,color:fgColor,fontFamily:"var(--font-mono,monospace)"}}>{fgVal}</span>
                <span style={{fontSize:10,color:fgColor,fontWeight:700}}>{data.fg_classification}</span>
              </div>
              <div style={{height:6,borderRadius:3,overflow:"hidden",background:"linear-gradient(90deg,#ef4444,#f59e0b,#10b981)"}}>
                <div style={{position:"relative" as const,height:"100%"}}>
                  <div style={{position:"absolute" as const,left:`${fgVal}%`,transform:"translateX(-50%)",
                    width:10,height:10,borderRadius:"50%",background:"#fff",
                    top:-2,border:`2px solid ${fgColor}`,boxShadow:`0 0 6px ${fgColor}`}}/>
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#94a3b8",marginTop:4}}>
                <span>กลัว</span><span>เป็นกลาง</span><span>โลภ</span>
              </div>
            </>
          ):(
            <div style={{fontSize:11,color:"#94a3b8"}}>Fetching…</div>
          )}
        </div>

        {/* Market sessions */}
        <div style={{padding:"12px 16px",borderRadius:12,
          background:"#ffffff",border:"1px solid rgba(0,0,0,0.05)"}}>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",fontWeight:700,marginBottom:8}}>Market Sessions</div>
          <div style={{display:"flex",flexDirection:"column" as const,gap:7}}>
            {sesStatus.map(s=>(
              <div key={s.label} style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:s.isOpen?s.col:"#1e293b",
                    boxShadow:s.isOpen?`0 0 6px ${s.col}`:"none"}}/>
                  <span style={{fontSize:11,fontWeight:700,color:s.isOpen?s.col:"#334155"}}>{s.label}</span>
                </div>
                <span style={{fontSize:9,color:s.isOpen?"#94a3b8":"#1e293b",fontFamily:"var(--font-mono,monospace)"}}>
                  {s.isOpen?"OPEN":"CLOSED"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Bangkok time + data source */}
        <div style={{padding:"12px 16px",borderRadius:12,
          background:"#ffffff",border:"1px solid rgba(0,0,0,0.05)",
          display:"flex",flexDirection:"column" as const,justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",fontWeight:700,marginBottom:4}}>Bangkok</div>
            <div style={{fontSize:22,fontWeight:800,color:"#818cf8",fontFamily:"var(--font-mono,monospace)"}}>
              {new Date().toLocaleTimeString("en-US",{timeZone:"Asia/Bangkok",hour:"2-digit",minute:"2-digit",hour12:false})}
            </div>
            <div style={{fontSize:9,color:"#475569",marginTop:2}}>
              {new Date().toLocaleDateString("en-GB",{timeZone:"Asia/Bangkok",day:"numeric",month:"short"})}
            </div>
          </div>
          <div style={{marginTop:10}}>
            {data._price_source&&(
              <div style={{
                display:"inline-flex",alignItems:"center",gap:4,
                padding:"3px 8px",borderRadius:6,fontSize:8,fontWeight:700,
                letterSpacing:"0.06em",textTransform:"uppercase" as const,
                background:data._price_source==="twelvedata"?"rgba(34,211,238,0.1)":"rgba(16,185,129,0.1)",
                border:`1px solid ${data._price_source==="twelvedata"?"rgba(34,211,238,0.3)":"rgba(16,185,129,0.3)"}`,
                color:data._price_source==="twelvedata"?"#22d3ee":"#10b981",
              }}>
                {data._price_source==="twelvedata"?"📡 TwelveData":"🌿 yfinance"}
              </div>
            )}
            {data.ts&&(
              <div style={{fontSize:8,color:"#94a3b8",fontFamily:"var(--font-mono,monospace)",marginTop:5}}>
                Updated {new Date(data.ts).toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Research card ───────────────────────────────────────────────────── */
function ResearchCard({event}:{event:Ev}){
  const r=(event.data.research??{}) as Record<string,unknown>;
  const sent=String(r.sentiment??"—"),conf=r.confidence as number|undefined;
  const factors=(r.factors as string[]|undefined)??[];
  const sc=sent==="bullish"?"#10b981":sent==="bearish"?"#ef4444":"#6b7280";
  return(
    <div style={{padding:"11px 13px",borderRadius:10,marginBottom:6,background:"rgba(139,92,246,0.06)",border:"1px solid rgba(139,92,246,0.18)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <Chip label="Research" color="#8b5cf6"/>
          <span style={{fontWeight:700,fontSize:11,color:sc}}>{sent.toUpperCase()}</span>
        </div>
        {conf!=null&&<span style={{fontSize:13,fontWeight:800,color:"#8b5cf6",fontFamily:"var(--font-mono,monospace)"}}>{conf}%</span>}
      </div>
      {factors.length>0&&<div style={{fontSize:10,color:"#64748b",fontStyle:"italic",lineHeight:1.5}}>{factors.join(" · ")}</div>}
      <div style={{fontSize:9,color:"#475569",marginTop:4,fontFamily:"var(--font-mono,monospace)"}}>{String(event.data.symbol??"XAUUSD")} · {new Date(event.ts).toLocaleTimeString()}</div>
    </div>
  );
}

/* ── Trade card ──────────────────────────────────────────────────────── */
function TradeCard({event}:{event:Ev}){
  const d=event.data,ok=event.topic==="TRADE_APPROVED",col=ok?"#10b981":"#f59e0b";
  return(
    <div style={{padding:"11px 13px",borderRadius:10,marginBottom:6,background:`${col}08`,border:`1px solid ${col}25`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <Chip label={ok?"อนุมัติ":"ถูกบล็อก"} color={col}/>
          <span style={{fontWeight:700,fontSize:11,color:"#1e293b"}}>{String(d.direction??"").toUpperCase()} {String(d.symbol??"")}</span>
        </div>
        {d.price!=null&&<span style={{color:"#64748b",fontSize:10,fontFamily:"var(--font-mono,monospace)"}}>@ ${fmtPrice(Number(d.price))}</span>}
      </div>
      {d.reason!=null&&<div style={{fontSize:10,color:"#64748b",fontStyle:"italic"}}>"{String(d.reason)}"</div>}
      <div style={{fontSize:9,color:"#475569",marginTop:3,fontFamily:"var(--font-mono,monospace)"}}>risk {d.risk?(Number(d.risk)*100).toFixed(2)+"%":"—"} · {new Date(event.ts).toLocaleTimeString()}</div>
    </div>
  );
}

/* ── Open Positions Widget ───────────────────────────────────────────── */
function OpenPositionsWidget({ positions, onClose }: {
  positions: OpenPosition[];
  onClose: (ticket: number, symbol: string, pnl: number) => void;
}) {
  const [confirmTicket, setConfirmTicket] = useState<number | null>(null);
  const [closing, setClosing] = useState<number | null>(null);

  function fmtDur(openTime: number): string {
    const ms = Date.now() - openTime * 1000;
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }

  const SYM_COL: Record<string, string> = {
    XAUUSD: "#f59e0b", EURUSD: "#6366f1", GBPUSD: "#ec4899",
    BTCUSD: "#f97316", XAGUSD: "#94a3b8",
  };

  const totalPnl = positions.reduce((s, p) => s + p.pnl + p.swap, 0);
  const confirmPos = positions.find(p => p.ticket === confirmTicket);

  async function handleConfirmClose() {
    if (!confirmPos) return;
    setClosing(confirmPos.ticket);
    setConfirmTicket(null);
    await onClose(confirmPos.ticket, confirmPos.symbol, confirmPos.pnl + confirmPos.swap);
    setClosing(null);
  }

  return (
    <>
      {/* Confirm Dialog */}
      {confirmPos && (
        <div style={{
          position: "fixed" as const, inset: 0, zIndex: 1000,
          background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, padding: "28px 32px", maxWidth: 380, width: "90%",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)", border: "1px solid rgba(239,68,68,0.2)",
          }}>
            <div style={{ fontSize: 20, marginBottom: 8 }}>⚠️ ยืนยันปิด Position</div>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 16, lineHeight: 1.6 }}>
              ปิด <b style={{ color: "#1e293b" }}>{confirmPos.direction.toUpperCase()} {confirmPos.symbol}</b><br/>
              ticket <b>#{confirmPos.ticket}</b> · {confirmPos.lots} lots<br/>
              P&L ปัจจุบัน: <b style={{ color: (confirmPos.pnl + confirmPos.swap) >= 0 ? "#10b981" : "#ef4444" }}>
                {(confirmPos.pnl + confirmPos.swap) >= 0 ? "+" : ""}${(confirmPos.pnl + confirmPos.swap).toFixed(2)}
              </b>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => setConfirmTicket(null)} style={{
                flex: 1, padding: "10px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)",
                background: "#f8fafc", color: "#475569", fontWeight: 700, fontSize: 12, cursor: "pointer",
              }}>ยกเลิก</button>
              <button type="button" onClick={handleConfirmClose} style={{
                flex: 1, padding: "10px", borderRadius: 10, border: "none",
                background: "#ef4444", color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer",
                boxShadow: "0 0 16px rgba(239,68,68,0.3)",
              }}>ปิด Position</button>
            </div>
          </div>
        </div>
      )}

      <Card accent={positions.length > 0 ? "#06b6d4" : "#334155"} style={{ marginBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13 }}>📈</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
              Open Positions
            </span>
            {positions.length > 0 && (
              <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 10, background: "#06b6d418", color: "#06b6d4", fontWeight: 700 }}>
                {positions.length}
              </span>
            )}
          </div>
          {positions.length > 0 && (
            <div style={{ fontSize: 13, fontWeight: 800, color: totalPnl >= 0 ? "#10b981" : "#ef4444", fontFamily: "var(--font-mono,monospace)" }}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </div>
          )}
        </div>

        {positions.length === 0 ? (
          <div style={{ textAlign: "center" as const, padding: "24px 0", color: "#475569", fontSize: 11, fontStyle: "italic" }}>
            ไม่มี position ที่เปิดอยู่
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
            {positions.map(pos => {
              const pnlTotal  = pos.pnl + pos.swap;
              const pnlCol    = pnlTotal >= 0 ? "#10b981" : "#ef4444";
              const symCol    = SYM_COL[pos.symbol] ?? "#6366f1";
              const isLong    = pos.direction === "long";
              const priceDiff = isLong ? pos.current - pos.entry : pos.entry - pos.current;
              const isClosing = closing === pos.ticket;
              return (
                <div key={pos.ticket} style={{
                  padding: "10px 14px", borderRadius: 10,
                  background: `${pnlCol}06`, border: `1px solid ${pnlCol}20`,
                  opacity: isClosing ? 0.6 : 1, transition: "opacity 0.3s",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                      <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, background: `${symCol}18`, color: symCol, fontWeight: 700 }}>
                        {pos.symbol}
                      </span>
                      <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, fontWeight: 700,
                        background: isLong ? "#10b98115" : "#ef444415",
                        color: isLong ? "#10b981" : "#ef4444" }}>
                        {isLong ? "▲ LONG" : "▼ SHORT"}
                      </span>
                      <span style={{ fontSize: 9, color: "#94a3b8" }}>{pos.lots} lots</span>
                      <span style={{ fontSize: 9, color: "#64748b" }}>⏱ {fmtDur(pos.open_time)}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ textAlign: "right" as const }}>
                        <div style={{ fontSize: 9, color: "#94a3b8" }}>P&L</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: pnlCol, fontFamily: "var(--font-mono,monospace)" }}>
                          {pnlTotal >= 0 ? "+" : ""}${pnlTotal.toFixed(2)}
                        </div>
                      </div>
                      <button type="button"
                        onClick={() => setConfirmTicket(pos.ticket)}
                        disabled={isClosing}
                        style={{
                          padding: "5px 12px", borderRadius: 8, fontSize: 10, fontWeight: 700,
                          border: "1px solid rgba(239,68,68,0.35)",
                          background: "rgba(239,68,68,0.08)", color: "#ef4444",
                          cursor: isClosing ? "not-allowed" : "pointer",
                          whiteSpace: "nowrap" as const,
                        }}>
                        {isClosing ? "กำลังปิด…" : "✕ Close"}
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, fontSize: 9, fontFamily: "var(--font-mono,monospace)", color: "#64748b" }}>
                    <span>Entry <b style={{ color: "#1e293b" }}>{fmtPrice(pos.entry)}</b></span>
                    <span>Now <b style={{ color: pnlCol }}>{fmtPrice(pos.current)}</b></span>
                    <span style={{ color: priceDiff >= 0 ? "#10b981" : "#ef4444" }}>
                      {priceDiff >= 0 ? "+" : ""}{fmtPrice(Math.abs(priceDiff))} pts
                    </span>
                    {pos.sl > 0 && <span>SL <b style={{ color: "#ef4444" }}>{fmtPrice(pos.sl)}</b></span>}
                    {pos.tp > 0 && <span>TP <b style={{ color: "#10b981" }}>{fmtPrice(pos.tp)}</b></span>}
                    <span style={{ color: "#94a3b8" }}>#{pos.ticket}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

/* ── Manual Trade Panel ──────────────────────────────────────────────── */
const CONTRACT_SIZE: Record<string, number> = {
  XAUUSD: 100, EURUSD: 100000, GBPUSD: 100000, XAGUSD: 5000,
};

function ManualTradePanel({ onSent, thbRate }: { onSent: (msg: string) => void; thbRate: number }) {
  const SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "XAGUSD"];
  const SYM_COL: Record<string, string> = {
    XAUUSD: "#f59e0b", EURUSD: "#6366f1", GBPUSD: "#ec4899", XAGUSD: "#94a3b8",
  };

  const [symbol,    setSymbol]    = useState("XAUUSD");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [lots,      setLots]      = useState("0.01");
  const [stop,      setStop]      = useState("");
  const [confirm,   setConfirm]   = useState(false);
  const [sending,   setSending]   = useState(false);
  const [feedback,  setFeedback]  = useState("");

  const lotsNum   = parseFloat(lots) || 0;
  const stopNum   = parseFloat(stop) || 0;
  const valid     = lotsNum >= 0.01 && symbol;
  const riskUsd   = stopNum > 0 ? lotsNum * stopNum * (CONTRACT_SIZE[symbol] ?? 100) : 0;
  const riskThb   = riskUsd * thbRate;
  const rewardUsd = riskUsd * 3;

  async function submit() {
    setSending(true); setConfirm(false);
    try {
      const res = await fetch(`${GW}/mt5/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, direction, lots: lotsNum, stop: stopNum }),
      });
      if (res.ok) {
        const msg = `✅ ${direction.toUpperCase()} ${symbol} ${lotsNum} lots — ส่งไปยัง bridge แล้ว`;
        setFeedback(msg); onSent(msg);
        setTimeout(() => setFeedback(""), 5000);
      } else {
        setFeedback("❌ Gateway ตอบ error");
      }
    } catch {
      setFeedback("❌ ไม่สามารถเชื่อมต่อ gateway");
    }
    setSending(false);
  }

  const dirCol = direction === "long" ? "#10b981" : "#ef4444";

  return (
    <>
      {/* Confirm Dialog */}
      {confirm && (
        <div style={{
          position: "fixed" as const, inset: 0, zIndex: 1000,
          background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, padding: "28px 32px", maxWidth: 380, width: "90%",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            border: `1px solid ${dirCol}30`,
          }}>
            <div style={{ fontSize: 20, marginBottom: 8 }}>
              {direction === "long" ? "▲" : "▼"} ยืนยัน Manual Trade
            </div>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 18, lineHeight: 1.7 }}>
              <b style={{ color: dirCol }}>{direction.toUpperCase()}</b> {" "}
              <b style={{ color: SYM_COL[symbol] ?? "#6366f1" }}>{symbol}</b><br />
              Lots: <b>{lotsNum}</b>
              {stopNum > 0 && <> · Stop: <b>{stopNum} pts</b></>}<br />
              <span style={{ fontSize: 11, color: "#94a3b8" }}>
                order จะถูก execute ทันทีที่ตลาดเปิด
              </span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => setConfirm(false)} style={{
                flex: 1, padding: "10px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)",
                background: "#f8fafc", color: "#475569", fontWeight: 700, fontSize: 12, cursor: "pointer",
              }}>ยกเลิก</button>
              <button type="button" onClick={submit} style={{
                flex: 1, padding: "10px", borderRadius: 10, border: "none",
                background: dirCol, color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer",
                boxShadow: `0 0 16px ${dirCol}44`,
              }}>
                {direction === "long" ? "▲ LONG" : "▼ SHORT"} ยืนยัน
              </button>
            </div>
          </div>
        </div>
      )}

      <Card accent={dirCol}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 16 }}>
          Manual Trade
        </div>

        {/* Symbol */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700, marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Symbol</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
            {SYMBOLS.map(s => (
              <button key={s} type="button" onClick={() => setSymbol(s)} style={{
                padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer",
                border: `1.5px solid ${symbol === s ? (SYM_COL[s] ?? "#6366f1") : "rgba(0,0,0,0.1)"}`,
                background: symbol === s ? `${SYM_COL[s] ?? "#6366f1"}18` : "#fff",
                color: symbol === s ? (SYM_COL[s] ?? "#6366f1") : "#64748b",
              }}>{s}</button>
            ))}
          </div>
        </div>

        {/* Direction */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700, marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Direction</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setDirection("long")} style={{
              flex: 1, padding: "10px", borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: "pointer",
              border: `1.5px solid ${direction === "long" ? "#10b981" : "rgba(0,0,0,0.08)"}`,
              background: direction === "long" ? "#10b98118" : "#f8fafc",
              color: direction === "long" ? "#10b981" : "#94a3b8",
            }}>▲ LONG</button>
            <button type="button" onClick={() => setDirection("short")} style={{
              flex: 1, padding: "10px", borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: "pointer",
              border: `1.5px solid ${direction === "short" ? "#ef4444" : "rgba(0,0,0,0.08)"}`,
              background: direction === "short" ? "#ef444418" : "#f8fafc",
              color: direction === "short" ? "#ef4444" : "#94a3b8",
            }}>▼ SHORT</button>
          </div>
        </div>

        {/* Lots + Stop */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700, marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Lots</div>
            <input
              type="number" min="0.01" step="0.01" value={lots}
              onChange={e => setLots(e.target.value)}
              style={{
                width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)",
                fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono,monospace)",
                outline: "none", boxSizing: "border-box" as const,
              }}
            />
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              {["0.01", "0.05", "0.10", "0.50"].map(v => (
                <button key={v} type="button" onClick={() => setLots(v)} style={{
                  flex: 1, padding: "3px 0", borderRadius: 6, fontSize: 9, fontWeight: 700, cursor: "pointer",
                  border: "1px solid rgba(0,0,0,0.1)", background: lots === v ? "#6366f118" : "#fff",
                  color: lots === v ? "#6366f1" : "#64748b",
                }}>{v}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700, marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
              Stop (pts) <span style={{ color: "#cbd5e1", fontWeight: 400 }}>optional</span>
            </div>
            <input
              type="number" min="0" step="0.1" value={stop} placeholder="e.g. 15"
              onChange={e => setStop(e.target.value)}
              style={{
                width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)",
                fontSize: 13, fontFamily: "var(--font-mono,monospace)",
                outline: "none", boxSizing: "border-box" as const,
              }}
            />
              <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 6 }}>
              {stopNum > 0 ? `TP = ${(stopNum * 3).toFixed(stopNum < 1 ? 4 : 1)} pts (3R)` : "ไม่มี SL/TP"}
            </div>
          </div>
        </div>

        {/* Risk Calculator */}
        {riskUsd > 0 && (
          <div style={{
            marginBottom: 14, padding: "10px 14px", borderRadius: 10,
            background: "linear-gradient(135deg,#6366f108,#fff)",
            border: "1px solid #6366f122",
          }}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 8 }}>
              Risk Calculator
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div style={{ textAlign: "center" as const }}>
                <div style={{ fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>Max Risk</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: "#ef4444", fontFamily: "var(--font-mono,monospace)" }}>
                  ${riskUsd.toFixed(2)}
                </div>
                <div style={{ fontSize: 9, color: "#94a3b8" }}>฿{riskThb.toFixed(0)}</div>
              </div>
              <div style={{ textAlign: "center" as const, borderLeft: "1px solid rgba(0,0,0,0.06)", borderRight: "1px solid rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>Target (3R)</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: "#10b981", fontFamily: "var(--font-mono,monospace)" }}>
                  +${rewardUsd.toFixed(2)}
                </div>
                <div style={{ fontSize: 9, color: "#94a3b8" }}>฿{(rewardUsd * thbRate).toFixed(0)}</div>
              </div>
              <div style={{ textAlign: "center" as const }}>
                <div style={{ fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>R:R</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: "#8b5cf6", fontFamily: "var(--font-mono,monospace)" }}>1:3</div>
                <div style={{ fontSize: 9, color: "#94a3b8" }}>fixed</div>
              </div>
            </div>
          </div>
        )}

        {/* Submit */}
        <button type="button" onClick={() => setConfirm(true)} disabled={!valid || sending} style={{
          width: "100%", padding: "12px", borderRadius: 10, border: "none", cursor: valid && !sending ? "pointer" : "not-allowed",
          fontWeight: 800, fontSize: 13, letterSpacing: "0.04em",
          background: !valid || sending ? "#f1f5f9" : dirCol,
          color: !valid || sending ? "#94a3b8" : "#fff",
          boxShadow: valid && !sending ? `0 0 18px ${dirCol}33` : "none",
          transition: "all 0.2s",
        }}>
          {sending ? "กำลังส่ง…" : `${direction === "long" ? "▲ LONG" : "▼ SHORT"} ${symbol} — Place Trade`}
        </button>

        {feedback && (
          <div style={{ marginTop: 10, fontSize: 10, color: feedback.startsWith("✅") ? "#10b981" : "#ef4444",
            textAlign: "center" as const, fontWeight: 600 }}>{feedback}</div>
        )}
      </Card>
    </>
  );
}

/* ── Price Alert Panel ───────────────────────────────────────────────── */
type PriceAlert = { id: string; symbol: string; price: number; when: "above" | "below"; triggered: boolean };

const ALERT_PRICES: Record<string, number | undefined> = {};

function PriceAlertPanel({ worldData }: { worldData: WorldData }) {
  const PRICE_MAP: Record<string, number | undefined> = {
    XAUUSD: worldData.gold_price,
    EURUSD: worldData.eur_price,
    BTCUSD: worldData.btc_price,
  };

  const [alerts,  setAlerts]  = useState<PriceAlert[]>(() => {
    try { return JSON.parse(localStorage.getItem("polis_price_alerts") ?? "[]"); } catch { return []; }
  });
  const [symbol,  setSymbol]  = useState("XAUUSD");
  const [price,   setPrice]   = useState("");
  const [when,    setWhen]    = useState<"above" | "below">("above");

  // persist
  useEffect(() => {
    try { localStorage.setItem("polis_price_alerts", JSON.stringify(alerts)); } catch { /* ignore */ }
  }, [alerts]);

  // check alerts every time world data changes
  useEffect(() => {
    setAlerts(prev => prev.map(a => {
      if (a.triggered) return a;
      const current = PRICE_MAP[a.symbol];
      if (!current) return a;
      const hit = (a.when === "above" && current >= a.price) ||
                  (a.when === "below" && current <= a.price);
      if (!hit) return a;

      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(`🔔 POLIS Price Alert — ${a.symbol}`, {
          body: `ราคา ${a.when === "above" ? "แตะ/เกิน" : "ต่ำกว่า"} ${a.price.toLocaleString()} · ปัจจุบัน ${current.toLocaleString()}`,
          icon: "/favicon.ico",
          tag: `polis-alert-${a.id}`,
        });
      }
      return { ...a, triggered: true };
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldData]);

  function addAlert() {
    const p = parseFloat(price);
    if (!p || !symbol) return;
    const newAlert: PriceAlert = {
      id: Math.random().toString(36).slice(2),
      symbol, price: p, when, triggered: false,
    };
    setAlerts(prev => [newAlert, ...prev]);
    setPrice("");
  }

  const active    = alerts.filter(a => !a.triggered);
  const triggered = alerts.filter(a => a.triggered);

  return (
    <Card accent="#f59e0b">
      <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 14 }}>
        🔔 Price Alert
      </div>

      {/* Add form */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" as const }}>
        <select value={symbol} onChange={e => setSymbol(e.target.value)}
          style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)", fontSize: 11, fontWeight: 700, cursor: "pointer", background: "#fff" }}>
          {["XAUUSD", "EURUSD", "BTCUSD"].map(s => <option key={s}>{s}</option>)}
        </select>

        <select value={when} onChange={e => setWhen(e.target.value as "above" | "below")}
          style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)", fontSize: 11, cursor: "pointer", background: "#fff" }}>
          <option value="above">≥ ขึ้นถึง</option>
          <option value="below">≤ ลงถึง</option>
        </select>

        <input type="number" placeholder="ราคาเป้า" value={price}
          onChange={e => setPrice(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addAlert()}
          style={{ flex: 1, minWidth: 100, padding: "7px 10px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)", fontSize: 12, fontFamily: "var(--font-mono,monospace)", outline: "none" }} />

        <button type="button" onClick={addAlert} disabled={!price}
          style={{
            padding: "7px 16px", borderRadius: 8, border: "none", cursor: price ? "pointer" : "not-allowed",
            background: price ? "#f59e0b" : "#f1f5f9", color: price ? "#fff" : "#94a3b8",
            fontSize: 12, fontWeight: 700,
          }}>+ เพิ่ม</button>
      </div>

      {/* Current prices reference */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        {Object.entries(PRICE_MAP).filter(([,v]) => v).map(([sym, val]) => (
          <div key={sym} style={{ fontSize: 9, color: "#64748b" }}>
            {sym} <b style={{ fontFamily: "var(--font-mono,monospace)", color: "#1e293b" }}>
              {Number(val).toLocaleString("en", { maximumFractionDigits: sym === "EURUSD" ? 4 : 0 })}
            </b>
          </div>
        ))}
      </div>

      {/* Active alerts */}
      {active.length === 0 && triggered.length === 0 ? (
        <div style={{ textAlign: "center" as const, padding: "16px 0", color: "#94a3b8", fontSize: 11, fontStyle: "italic" }}>
          ยังไม่มี alert — ตั้งราคาเป้าด้านบน
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
          {[...active, ...triggered].map(a => {
            const current = PRICE_MAP[a.symbol];
            return (
              <div key={a.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "7px 12px", borderRadius: 8,
                background: a.triggered ? "#10b98108" : "#f59e0b08",
                border: `1px solid ${a.triggered ? "#10b98122" : "#f59e0b22"}`,
                opacity: a.triggered ? 0.65 : 1,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10 }}>{a.triggered ? "✅" : "🔔"}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#1e293b" }}>{a.symbol}</span>
                  <span style={{ fontSize: 9, color: "#64748b" }}>
                    {a.when === "above" ? "≥" : "≤"} <b style={{ fontFamily: "var(--font-mono,monospace)" }}>
                      {a.price.toLocaleString("en", { maximumFractionDigits: a.price < 10 ? 4 : 0 })}
                    </b>
                  </span>
                  {current && !a.triggered && (
                    <span style={{ fontSize: 9, color: "#94a3b8" }}>
                      now {Number(current).toLocaleString("en", { maximumFractionDigits: a.price < 10 ? 4 : 0 })}
                    </span>
                  )}
                  {a.triggered && <span style={{ fontSize: 9, color: "#10b981", fontWeight: 700 }}>triggered!</span>}
                </div>
                <button type="button" onClick={() => setAlerts(prev => prev.filter(x => x.id !== a.id))}
                  style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>×</button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ── Control panel ───────────────────────────────────────────────────── */
function ControlPanel({paused,maxRisk,onPause,onResume,onRisk,onBoard,lastAction}:{
  paused:boolean;maxRisk:number;
  onPause:()=>void;onResume:()=>void;onRisk:(v:number)=>void;onBoard:()=>void;lastAction:string;
}){
  const[riskDraft,setRiskDraft]=useState((maxRisk*100).toFixed(1));
  const[boardSent,setBoardSent]=useState(false);
  useEffect(()=>setRiskDraft((maxRisk*100).toFixed(1)),[maxRisk]);
  const applyRisk=()=>{const v=parseFloat(riskDraft)/100;if(!isNaN(v))onRisk(v);};
  const triggerBoard=()=>{setBoardSent(true);onBoard();setTimeout(()=>setBoardSent(false),5000);};
  const pc=paused?"#ef4444":"#10b981";

  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1.6fr 1fr",gap:12}}>

      <Card accent={pc}>
        <div style={{fontSize:10,fontWeight:700,color:"#64748b",letterSpacing:"0.08em",textTransform:"uppercase" as const,marginBottom:12}}>สถานะการเทรด</div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,padding:"10px 12px",borderRadius:10,background:`${pc}0d`,border:`1px solid ${pc}25`}}>
          <Dot color={pc} pulse={!paused}/>
          <div>
            <div style={{fontSize:13,fontWeight:800,color:pc}}>{paused?"หยุดชั่วคราว":"ใช้งาน"}</div>
            <div style={{fontSize:9,color:"#475569",marginTop:1}}>{paused?"สัญญาณถูกบล็อก":"รับสัญญาณ"}</div>
          </div>
        </div>
        <button type="button" onClick={paused?onResume:onPause} style={{
          width:"100%",padding:"11px",borderRadius:10,border:"none",cursor:"pointer",
          fontWeight:800,fontSize:12,letterSpacing:"0.04em",
          background:paused?"#10b981":"#ef4444",color:"#fff",
          boxShadow:paused?"0 0 18px rgba(16,185,129,0.25)":"0 0 18px rgba(239,68,68,0.25)",
          transition:"all 0.2s",
        }}>
          {paused?"▶  RESUME":"⏸  PAUSE"}
        </button>
        {lastAction&&<div style={{fontSize:9,color:"#475569",marginTop:8,textAlign:"center" as const,lineHeight:1.4}}>{lastAction}</div>}
      </Card>

      <Card accent="#6366f1">
        <div style={{fontSize:10,fontWeight:700,color:"#64748b",letterSpacing:"0.08em",textTransform:"uppercase" as const,marginBottom:12}}>ความเสี่ยง / เทรด</div>
        <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:14}}>
          <span style={{fontSize:44,fontWeight:800,color:"#818cf8",fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>{parseFloat(riskDraft)||0}</span>
          <span style={{fontSize:18,color:"#475569",fontWeight:700}}>%</span>
          <span style={{fontSize:10,color:"#94a3b8",marginLeft:4}}>current: <b style={{color:"#6366f1"}}>{(maxRisk*100).toFixed(1)}%</b></span>
        </div>
        <input type="range" min={0.2} max={1.0} step={0.1}
          title="Risk per trade"
          value={parseFloat(riskDraft)||0.5}
          onChange={e=>setRiskDraft(e.target.value)}
          style={{width:"100%",accentColor:"#6366f1",marginBottom:12,cursor:"pointer",height:4}}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:6}}>
            {[0.2,0.5,0.8,1.0].map(v=>(
              <button key={v} type="button" onClick={()=>setRiskDraft(v.toFixed(1))} style={{
                padding:"3px 9px",borderRadius:6,border:"1px solid rgba(99,102,241,0.25)",
                background:parseFloat(riskDraft)===v?"rgba(99,102,241,0.2)":"transparent",
                color:parseFloat(riskDraft)===v?"#818cf8":"#475569",
                fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"var(--font-mono,monospace)",
              }}>{v}%</button>
            ))}
          </div>
          <button type="button" onClick={applyRisk} style={{
            padding:"6px 16px",borderRadius:8,border:"1px solid rgba(99,102,241,0.4)",
            background:"rgba(99,102,241,0.18)",color:"#818cf8",fontSize:11,fontWeight:800,cursor:"pointer",
          }}>APPLY</button>
        </div>
      </Card>

      <Card accent="#ec4899">
        <div style={{fontSize:10,fontWeight:700,color:"#64748b",letterSpacing:"0.08em",textTransform:"uppercase" as const,marginBottom:12}}>การประชุมบอร์ด</div>
        <div style={{fontSize:11,color:"#64748b",marginBottom:16,lineHeight:1.65}}>
          ข้ามการรอ 5 นาทีและเรียกประชุมทันทีโดยผู้บริหาร AI ทั้ง 5 คน
        </div>
        <button type="button" onClick={triggerBoard} disabled={boardSent} style={{
          width:"100%",padding:"11px",borderRadius:10,
          border:`1px solid ${boardSent?"rgba(16,185,129,0.35)":"rgba(236,72,153,0.35)"}`,
          background:boardSent?"rgba(16,185,129,0.1)":"rgba(236,72,153,0.1)",
          color:boardSent?"#34d399":"#f472b6",
          fontSize:12,fontWeight:800,cursor:boardSent?"default":"pointer",letterSpacing:"0.04em",
        }}>
          {boardSent?"✅ เรียกประชุมแล้ว":"📣 เรียกประชุม"}
        </button>
      </Card>
    </div>
  );
}

/* ══ MAIN PAGE ═══════════════════════════════════════════════════════════ */
export default function TradingPage(){
  const[events,    setEvents]    = useState<Ev[]>([]);
  const[decisions, setDecisions] = useState<Decision[]>([]);
  const[equityPts, setEquityPts] = useState<EquityPoint[]>([]);
  const[connected, setConnected] = useState(false);
  const[maxRisk,   setMaxRisk]   = useState(0.005);
  const[brokerLive,setBrokerLive]= useState(false);
  const[svcStatus, setSvcStatus] = useState<SvcStatus>({});
  const[uptimeMs,  setUptimeMs]  = useState(0);
  const[bangkokTime,setBkk]      = useState("");
  const[paused,    setPaused]    = useState(false);
  const[lastAction,setLastAction]= useState("");
  const[worldData, setWorldData] = useState<WorldData>({});
  const[mt5Live,   setMt5Live]   = useState<Record<string,unknown> | null>(null);
  const[mt5Pos,    setMt5Pos]    = useState<OpenPosition[]>([]);
  const[cfg,       setCfg]       = useState<{thb_per_usd:number}|null>(null);
  const[mt5Prices, setMt5Prices] = useState<Record<string,{bid:number;ask:number;mid:number}>|null>(null);
  const wsRef=useRef<WebSocket|null>(null);
  const t0=useRef(Date.now());

  const loadHistory=()=>fetch(`${GW}/trades?limit=50`).then(r=>r.json()).then((d:Decision[])=>setDecisions(Array.isArray(d)?d:[])).catch(()=>{});
  const loadEquity =()=>fetch(`${GW}/equity`).then(r=>r.json()).then((d:EquityPoint[])=>setEquityPts(Array.isArray(d)?d:[])).catch(()=>{});
  const loadWorld  =()=>fetch(`${GW}/world`).then(r=>r.json()).then((d:unknown)=>{if(d&&typeof d==="object"&&!Array.isArray(d))setWorldData(d as WorldData);}).catch(()=>{});

  useEffect(()=>{
    // ขอ permission browser notification ครั้งแรก
    if(typeof Notification!=="undefined"&&Notification.permission==="default"){
      Notification.requestPermission().catch(()=>{});
    }

    fetch(`${GW}/events`).then(r=>r.json()).then((d:Ev[])=>setEvents(d)).catch(()=>{});
    loadHistory();loadEquity();loadWorld();
    fetch(`${GW}/control/status`).then(r=>r.json()).then((d:{paused:boolean;max_risk:number})=>{setPaused(d.paused);setMaxRisk(d.max_risk);}).catch(()=>{});

    const ph=()=>fetch(`${GW}/health/services`).then(r=>r.json()).then((d:SvcStatus)=>setSvcStatus(d)).catch(()=>setSvcStatus(p=>({...p,gateway:"error"})));
    ph();const ht=setInterval(ph,10_000);
    const wp=setInterval(loadWorld,300_000);
    fetch(`${GW}/analytics/thb`).then(r=>r.json()).then((d:{thb_per_usd:number})=>setCfg(d)).catch(()=>{});
    const loadMt5=()=>fetch(`${GW}/mt5/live`).then(r=>r.json()).then((d:Record<string,unknown>)=>setMt5Live(d.error?null:d)).catch(()=>setMt5Live(null));
    const loadMt5Pos=()=>fetch(`${GW}/mt5/positions`).then(r=>r.json()).then((d:OpenPosition[])=>setMt5Pos(Array.isArray(d)?d:[])).catch(()=>setMt5Pos([]));
    const loadMt5Prices=()=>fetch(`${GW}/mt5/prices`).then(r=>r.json()).then((d:Record<string,{bid:number;ask:number;mid:number}>)=>setMt5Prices(Object.keys(d).length>0?d:null)).catch(()=>{});
    loadMt5();loadMt5Pos();loadMt5Prices();
    const mt=setInterval(()=>{loadMt5();loadMt5Pos();},5_000);
    const pt=setInterval(loadMt5Prices,1_000);
    const ut=setInterval(()=>setUptimeMs(Date.now()-t0.current),1000);
    const bt=()=>setBkk(new Date().toLocaleTimeString("th-TH",{timeZone:"Asia/Bangkok",hour12:false}));
    bt();const btt=setInterval(bt,1000);

    function connect(){
      const ws=new WebSocket(GWWS);wsRef.current=ws;
      ws.onopen=()=>{setConnected(true);loadHistory();};
      ws.onclose=()=>{setConnected(false);setTimeout(connect,3000);};
      ws.onerror=()=>ws.close();
      ws.onmessage=({data})=>{
        let ev:Ev;
        try{ev=JSON.parse(data);}catch{return;}
        if(!ev?.topic)return;
        const d=ev.data??{};
        if(ev.topic==="PING") return;
        setEvents(p=>[ev,...p].slice(0,300));
        if(["TRADE_APPROVED","POLICY_BLOCKED","SIGNAL_REJECTED"].includes(ev.topic))loadHistory();
        if(ev.topic==="TRADE_CLOSED"){
          loadEquity();
          // browser notification
          if(typeof Notification!=="undefined"&&Notification.permission==="granted"){
            const d=ev.data as{symbol?:string;direction?:string;pnl_usd?:number;result?:string};
            const win=(d.result??"").toUpperCase()==="WIN";
            const pnl=Number(d.pnl_usd??0);
            new Notification(`POLIS — Trade Closed ${win?"✅ WIN":"❌ LOSS"}`,{
              body:`${String(d.direction??"").toUpperCase()} ${d.symbol??""} · ${pnl>=0?"+":""}$${Math.abs(pnl).toFixed(2)}`,
              icon:"/favicon.ico",
              tag:"polis-trade-closed",
            });
          }
        }
        if(ev.topic==="TRADE_APPROVED"){setBrokerLive((d as{broker_live?:boolean}).broker_live??false);}
        if(ev.topic==="POLICY_ADJUSTED"){const nr=(d as{new_risk?:number}).new_risk;if(typeof nr==="number")setMaxRisk(nr);}
        if(ev.topic==="TRADING_PAUSED") {setPaused(true); setLastAction(`Paused at ${new Date(ev.ts).toLocaleTimeString()}`);}
        if(ev.topic==="TRADING_RESUMED"){setPaused(false);setLastAction(`Resumed at ${new Date(ev.ts).toLocaleTimeString()}`);}
        if(ev.topic==="RISK_OVERRIDE"){const nr=(d as{max_risk?:number}).max_risk;if(typeof nr==="number"){setMaxRisk(nr);setLastAction(`Risk set to ${(nr*100).toFixed(1)}% · ${new Date(ev.ts).toLocaleTimeString()}`);}}
        if(ev.topic==="WORLD_UPDATE"){setWorldData(d as WorldData);}
      };
    }
    connect();
    return()=>{wsRef.current?.close();clearInterval(ht);clearInterval(wp);clearInterval(ut);clearInterval(btt);clearInterval(mt);clearInterval(pt);};
  },[]);

  const ctrlPause =()=>fetch(`${GW}/control/pause`, {method:"POST"}).then(()=>setLastAction(`Paused · ${new Date().toLocaleTimeString()}`)).catch(()=>{});
  const ctrlResume=()=>fetch(`${GW}/control/resume`,{method:"POST"}).then(()=>setLastAction(`Resumed · ${new Date().toLocaleTimeString()}`)).catch(()=>{});
  const ctrlRisk  =(v:number)=>fetch(`${GW}/control/risk`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({max_risk:v})}).then(()=>setLastAction(`Risk → ${(v*100).toFixed(1)}%`)).catch(()=>{});
  const ctrlBoard =()=>fetch(`${GW}/control/board`,{method:"POST"}).then(()=>setLastAction(`Board triggered · ${new Date().toLocaleTimeString()}`)).catch(()=>{});
  const closePosition=async(ticket:number,symbol:string,pnl:number)=>{
    setMt5Pos(prev=>prev.filter(p=>p.ticket!==ticket));
    try{
      await fetch(`${GW}/mt5/close/${ticket}`,{method:"POST"});
      setLastAction(`Closed ${symbol} #${ticket} P&L ${pnl>=0?"+":""}$${pnl.toFixed(2)}`);
    }catch{
      setLastAction(`Close failed #${ticket}`);
    }
  };

  const liveResearch=events.filter(e=>e.topic==="RESEARCH_COMPLETE").slice(0,4);
  const liveDecisions=events.filter(e=>e.topic==="TRADE_APPROVED"||e.topic==="POLICY_BLOCKED").slice(0,6);
  const feedEvents=events.filter(e=>!["HEALTH_TICK","PING"].includes(e.topic));
  const closed=decisions.filter(d=>d.pnl_usd!=null);
  const wins=closed.filter(d=>d.trade_result==="WIN");
  const wr=pct(wins.length,closed.length);

  return(
    <div className="dot-bg" style={{minHeight:"100vh",background:"var(--bg)",padding:"24px 28px 48px"}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div>
          <div style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",textTransform:"uppercase" as const,marginBottom:6}}>
            POLIS HQ › เทรด › ภาพรวม
          </div>
          <div style={{fontSize:24,fontWeight:800,letterSpacing:"-0.03em",color:"#0f172a",lineHeight:1}}>
            ระบบเทรด AI
          </div>
          <div style={{fontSize:11,color:"#64748b",marginTop:5}}>
            <span style={{color:"#34d399",fontWeight:700,fontFamily:"var(--font-mono,monospace)"}}>{bangkokTime}</span>
            <span style={{margin:"0 6px",color:"#1e293b"}}>·</span>
            Bangkok · {new Date().toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}
          </div>
        </div>

        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <MiniEquity pts={equityPts}/>
          <div style={{width:1,height:40,background:"rgba(0,0,0,0.05)"}}/>
          {paused&&(
            <div style={{padding:"5px 12px",borderRadius:8,fontSize:11,fontWeight:800,
              background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.35)",
              color:"#f87171",animation:"pulse 2s ease-in-out infinite"}}>
              ⏸ PAUSED
            </div>
          )}
          <div style={{padding:"5px 12px",borderRadius:8,fontSize:10,fontWeight:600,
            background:brokerLive?"rgba(16,185,129,0.1)":"rgba(245,158,11,0.08)",
            border:`1px solid ${brokerLive?"rgba(16,185,129,0.25)":"rgba(245,158,11,0.2)"}`,
            color:brokerLive?"#34d399":"#f59e0b"}}>
            OANDA {brokerLive?"LIVE":"SIM"}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:7,padding:"5px 12px",
            borderRadius:8,background:"rgba(0,0,0,0.03)",border:"1px solid rgba(0,0,0,0.06)"}}>
            <Dot color={connected?"#10b981":"#ef4444"} pulse={connected}/>
            <span style={{fontSize:10,color:connected?"#34d399":"#f87171",fontWeight:600}}>
              {connected?"สด":"กำลังเชื่อมต่อใหม่…"}
            </span>
          </div>
        </div>
      </div>

      <HealthStrip status={svcStatus}/>

      {/* Live MT5 Account Widget */}
      {mt5Live && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:10, marginBottom:14 }}>
          {[
            { label:"MT5 Balance",    value:`$${(mt5Live.balance as number)?.toLocaleString("en",{maximumFractionDigits:0})}`,  color:"#6366f1" },
            { label:"Equity",         value:`$${(mt5Live.equity   as number)?.toLocaleString("en",{maximumFractionDigits:0})}`,  color:(mt5Live.equity as number)>=(mt5Live.balance as number)?"#10b981":"#ef4444" },
            { label:"Open P&L",       value:`${(mt5Live.open_pnl as number)>=0?"+":""}$${Math.abs(mt5Live.open_pnl as number).toFixed(2)}`, color:(mt5Live.open_pnl as number)>=0?"#10b981":"#ef4444" },
            { label:"Open Positions", value:String(mt5Live.open_pos ?? 0), color:"#f59e0b" },
            { label:"Free Margin",    value:`$${(mt5Live.free_margin as number)?.toLocaleString("en",{maximumFractionDigits:0})}`, color:"#64748b" },
          ].map(k=>(
            <div key={k.label} style={{ background:`linear-gradient(135deg,${k.color}10,#fff)`,
              border:`1px solid ${k.color}25`, borderRadius:10, padding:"10px 14px" }}>
              <div style={{ fontSize:8, color:"#64748b", textTransform:"uppercase" as const, letterSpacing:"0.1em", fontWeight:700, marginBottom:4 }}>
                🔴 LIVE · {k.label}
              </div>
              <div style={{ fontSize:18, fontWeight:900, color:k.color, fontFamily:"var(--font-mono,monospace)" }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Open Positions */}
      {(mt5Live || mt5Pos.length > 0) && (
        <>
          <SectionLabel icon="📈" label="Open Positions" accent="#06b6d4"
            right={<span style={{fontSize:9,color:"#94a3b8"}}>อัปเดตทุก 5s</span>}/>
          <div style={{marginBottom:20}}>
            <OpenPositionsWidget positions={mt5Pos} onClose={closePosition}/>
          </div>
        </>
      )}

      <KpiStrip decisions={decisions} events={events} uptimeMs={uptimeMs}/>

      <SectionLabel icon="🌍" label="ภาพรวมตลาดโลก" accent="#34d399"/>
      <WorldModelPanel data={worldData}/>

      {/* Live 3-col */}
      <SectionLabel icon="⚡" label="เหตุการณ์แบบเรียลไทม์" accent="#6366f1"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>{feedEvents.length} events</span>}/>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1.1fr",gap:12,marginBottom:0}}>
        <Card>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:12,display:"flex",alignItems:"center",gap:7}}>
            <span>🔬</span> Research
          </div>
          <div style={{maxHeight:280,overflowY:"auto"}}>
            {liveResearch.length===0
              ?<div style={{color:"#94a3b8",textAlign:"center",padding:"28px 0",fontSize:11,fontStyle:"italic"}}>รอสัญญาณ…</div>
              :liveResearch.map((ev,i)=><ResearchCard key={i} event={ev}/>)}
          </div>
        </Card>

        <Card>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:12}}>⚡ Live Decisions</div>
          <div style={{maxHeight:280,overflowY:"auto"}}>
            {liveDecisions.length===0
              ?<div style={{color:"#94a3b8",textAlign:"center",padding:"28px 0",fontSize:11,fontStyle:"italic"}}>ยังไม่มีการตัดสินใจ…</div>
              :liveDecisions.map((ev,i)=><TradeCard key={i} event={ev}/>)}
          </div>
        </Card>

        <Card>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:12,display:"flex",alignItems:"center",gap:7}}>
            <span>📡</span> Event Stream <Dot color="#10b981" pulse/>
          </div>
          <div style={{maxHeight:280,overflowY:"auto",display:"flex",flexDirection:"column",gap:2}}>
            {feedEvents.length===0
              ?<div style={{color:"#94a3b8",textAlign:"center",padding:"28px 0",fontSize:11,fontStyle:"italic"}}>กำลังเชื่อมต่อ…</div>
              :feedEvents.slice(0,60).map((ev,i)=>{
                const c=EV_COLOR[ev.topic]??"#475569";
                return(
                  <div key={i} style={{display:"flex",alignItems:"flex-start",gap:7,padding:"5px 8px",borderRadius:7,
                    background:"#f8fafc",borderLeft:`2px solid ${c}55`}}>
                    <Chip label={ev.topic.replace(/_/g," ")} color={c}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.4,wordBreak:"break-word" as const}}>{evSummary(ev)}</div>
                      <div style={{fontSize:9,color:"#475569",marginTop:1,fontFamily:"var(--font-mono,monospace)"}}>{new Date(ev.ts).toLocaleTimeString()}</div>
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>
      </div>

      {/* Price Alert */}
      <SectionLabel icon="🔔" label="Price Alert" accent="#f59e0b"/>
      <div style={{ marginBottom: 0 }}>
        <PriceAlertPanel worldData={worldData}/>
      </div>

      {/* Manual Trade */}
      <SectionLabel icon="🖐" label="Manual Trade" accent="#06b6d4"/>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12, marginBottom: 0 }}>
        <ManualTradePanel onSent={setLastAction} thbRate={cfg?.thb_per_usd ?? 35}/>
        <Card accent="#475569">
          <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 12 }}>
            คำเตือน
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10, fontSize: 11, color: "#475569", lineHeight: 1.7 }}>
            <div>⚠️ <b>Bridge ต้องรันอยู่</b> — ถ้า bridge ไม่ได้รัน คำสั่งจะหายไปโดยไม่มี error</div>
            <div>⚠️ <b>ตลาดต้องเปิด</b> — MT5 จะ reject order ถ้าตลาดปิด</div>
            <div>🔄 <b>Anti-hedge เปิดอยู่</b> — ถ้ามี position ตรงข้ามอยู่ bridge จะปิดก่อนแล้วเปิดใหม่</div>
            <div>🎯 <b>Trailing Stop</b> — ถ้าใส่ Stop (pts) ระบบจะ trail ที่ 1R อัตโนมัติ</div>
          </div>
        </Card>
      </div>

      {/* Control panel */}
      <SectionLabel icon="🎛" label="Control Panel" accent="#ec4899"/>
      <ControlPanel paused={paused} maxRisk={maxRisk}
        onPause={ctrlPause} onResume={ctrlResume}
        onRisk={ctrlRisk} onBoard={ctrlBoard}
        lastAction={lastAction}/>

    </div>
  );
}
