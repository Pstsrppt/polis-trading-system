"use client";
import { useEffect, useRef, useState } from "react";

const GW   = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";
const GWWS = process.env.NEXT_PUBLIC_GATEWAY_WS  ?? "ws://localhost:19000/ws/feed";

type Ev        = { topic: string; data: Record<string, unknown>; ts: string };
type LLMMetrics = { gemini?:{calls:number;cost_usd:number}; groq?:{calls:number;cost_usd:number}; openrouter?:{calls:number;cost_usd:number}; total?:{calls:number;cost_usd:number}; agents?:Record<string,{calls:number;cost_usd:number}>; last_updated?:string };
type AgentInfo  = { role:string; division:string; online:boolean; hired_at:string; llm_calls:number; llm_cost_usd:number };
type CbStatus   = { triggered:boolean; reason:string; consec:number; day_notional:number; daily_budget:number; max_consec:number; triggered_at:string|null };
type BriefingToday = { total:number; approved:number; blocked:number; wins:number; losses:number; approval_rate:number; win_rate:number; total_pnl:number; avg_confidence:number; max_confidence:number; total_notional:number; board:Record<string,number>; by_symbol?:Record<string,{total:number;approved:number;blocked:number}> };
type Briefingเมื่อวาน = { total:number; approved:number; wins:number; total_pnl:number };
type BriefingBroker = { mode:string; live:boolean; signal:string };
type Briefing = { today:BriefingToday; yesterday:Briefingเมื่อวาน; broker:BriefingBroker };

const EV_COLOR: Record<string,string> = {
  AGENT_HIRED:"#10b981",AGENT_FIRED:"#ef4444",TASK_COMPLETED:"#6366f1",
  POLICY_BLOCKED:"#f59e0b",TRADE_SIGNAL:"#06b6d4",RESEARCH_COMPLETE:"#8b5cf6",
  TRADE_APPROVED:"#10b981",BOARD_RESOLUTION:"#ec4899",POLICY_ADJUSTED:"#ef4444",
  SIGNAL_APPROVED:"#06b6d4",SIGNAL_REJECTED:"#f59e0b",WORLD_UPDATE:"#34d399",
};
const TOPIC_ICON: Record<string,string> = {
  AGENT_HIRED:"🟢",AGENT_FIRED:"🔴",TRADE_SIGNAL:"📡",RESEARCH_COMPLETE:"🔬",
  TRADE_APPROVED:"✅",POLICY_BLOCKED:"⚠️",SIGNAL_REJECTED:"🚫",BOARD_RESOLUTION:"🏛",
  POLICY_ADJUSTED:"⚙️",WORLD_UPDATE:"🌍",TASK_COMPLETED:"✓",
};
const OFFICER: Record<string,{icon:string;color:string;title:string;name:string}> = {
  ceo:{icon:"👔",color:"#818cf8",title:"Chief Executive",  name:"Marcus"},
  cto:{icon:"💻",color:"#22d3ee",title:"Chief Technology", name:"Aria"},
  cfo:{icon:"💰",color:"#fbbf24",title:"Chief Financial",  name:"Nova"},
  coo:{icon:"⚙️", color:"#34d399",title:"Chief Operating",  name:"Atlas"},
  cmo:{icon:"📊",color:"#f472b6",title:"Chief Marketing",  name:"Iris"},
};
const OFFICER_SKILLS: Record<string,string[]> = {
  ceo:["Strategy","Vision","Board","Hiring"],
  cto:["LLM","Pipeline","Research","Analysis"],
  cfo:["Risk","P&L","Budget","Cost"],
  coo:["Execution","Throughput","Latency","Ops"],
  cmo:["Sentiment","Regime","Macro","Bias"],
};

const fmtPrice = (v:number) => v < 10 ? v.toFixed(5) : v < 1000 ? v.toFixed(2) : v.toFixed(0);

function evSummary(ev:Ev):string{
  const d=ev.data;
  switch(ev.topic){
    case "RESEARCH_COMPLETE":{const r=(d.research??{}) as Record<string,unknown>;return`${d.symbol??""} · ${r.sentiment??""} · ${r.confidence??"?"}% conf`;}
    case "TRADE_APPROVED":   return`${String(d.direction??"").toUpperCase()} ${d.symbol} @ $${fmtPrice(Number(d.price??0))}`;
    case "POLICY_BLOCKED":   return`${String(d.direction??"").toUpperCase()} ${d.symbol} — ${d.reason??"blocked"}`;
    case "BOARD_RESOLUTION": return`${String(d.resolution??"").toUpperCase()} · ${d.directive}`;
    case "POLICY_ADJUSTED":  return`max_risk → ${(Number(d.new_risk??0)*100).toFixed(2)}%`;
    case "AGENT_HIRED":      return`${d.role} joined ${d.division}`;
    default: return JSON.stringify(d).slice(0,70);
  }
}

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

/* ── LLM Cost Monitor ────────────────────────────────────────────────── */
function LLMMonitor({llm}:{llm:LLMMetrics}){
  const providers=[
    {key:"gemini",     label:"Gemini 2.0", color:"#818cf8",icon:"✨"},
    {key:"groq",       label:"Groq Llama", color:"#22d3ee",icon:"⚡"},
    {key:"openrouter", label:"OpenRouter", color:"#f472b6",icon:"🔄"},
  ] as const;
  const total=llm.total??{calls:0,cost_usd:0};
  const costPerCall=total.calls>0?(total.cost_usd/total.calls):0;
  return(
    <Card accent="#818cf8">
      <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:16}}>🧠 การใช้งาน LLM</div>

      {/* KPI grid */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
        {[
          {l:"เรียกใช้ทั้งหมด",  v:total.calls.toString(),             c:"#f1f5f9"},
          {l:"ค่าใช้จ่ายรวม",   v:`$${total.cost_usd.toFixed(4)}`,   c:"#fbbf24"},
          {l:"ค่าใช้จ่าย/ครั้ง",  v:total.calls>0?`$${costPerCall.toFixed(5)}`:"—", c:"#94a3b8"},
        ].map(r=>(
          <div key={r.l} style={{padding:"10px 12px",borderRadius:10,background:"#f1f5f9",border:"1px solid rgba(0,0,0,0.04)"}}>
            <div style={{fontSize:7,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:4}}>{r.l}</div>
            <div style={{fontSize:r.l==="เรียกใช้ทั้งหมด"?24:16,fontWeight:800,color:r.c,fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>{r.v}</div>
          </div>
        ))}
      </div>

      {/* Provider bars */}
      {providers.map(p=>{
        const d=(llm as Record<string,{calls?:number;cost_usd?:number}>)[p.key]??{calls:0,cost_usd:0};
        const calls=d.calls??0,cost=d.cost_usd??0;
        const pct=total.calls>0?(calls/total.calls*100):0;
        const cpc=calls>0?(cost/calls):0;
        return(
          <div key={p.key} style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,alignItems:"center"}}>
              <span style={{fontSize:10,color:p.color,fontWeight:700}}>{p.icon} {p.label}</span>
              <div style={{textAlign:"right" as const}}>
                <span style={{fontSize:10,color:"#475569",fontFamily:"var(--font-mono,monospace)"}}>{calls} calls</span>
                <span style={{fontSize:9,color:"#94a3b8",marginLeft:6}}>·</span>
                <span style={{fontSize:10,color:"#fbbf24",fontFamily:"var(--font-mono,monospace)",marginLeft:6}}>${cost.toFixed(5)}</span>
                {calls>0&&<span style={{fontSize:8,color:"#94a3b8",marginLeft:6}}>({`$${cpc.toFixed(5)}/call`})</span>}
              </div>
            </div>
            <div style={{height:4,background:"rgba(0,0,0,0.04)",borderRadius:2,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${pct}%`,borderRadius:2,background:`linear-gradient(90deg,${p.color}88,${p.color})`,transition:"width 0.6s"}}/>
            </div>
          </div>
        );
      })}

      {/* Per-agent breakdown */}
      {llm.agents&&Object.keys(llm.agents).length>0&&(
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(0,0,0,0.04)"}}>
          <div style={{fontSize:9,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:8}}>แยกตาม Agent</div>
          {Object.entries(llm.agents).sort((a,b)=>b[1].calls-a[1].calls).map(([ag,info])=>{
            const om=OFFICER[ag];
            const maxCalls=Math.max(...Object.values(llm.agents??{}).map(x=>x.calls),1);
            return(
              <div key={ag} style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3,fontSize:10}}>
                  <span style={{color:om?.color??"#64748b",fontWeight:700}}>{om?.icon??""} {ag.toUpperCase()}</span>
                  <span style={{color:"#64748b",fontFamily:"var(--font-mono,monospace)"}}>{info.calls} · ${info.cost_usd.toFixed(5)}</span>
                </div>
                <div style={{height:3,background:"rgba(0,0,0,0.03)",borderRadius:2,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${info.calls/maxCalls*100}%`,background:om?.color??"#475569",opacity:0.6,transition:"width 0.5s"}}/>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {llm.last_updated&&(
        <div style={{fontSize:8,color:"#94a3b8",marginTop:10,fontFamily:"var(--font-mono,monospace)"}}>Updated {new Date(llm.last_updated).toLocaleTimeString()}</div>
      )}
    </Card>
  );
}

/* ── Event Rate Mini Chart ───────────────────────────────────────────── */
function EventRateChart({events}:{events:Ev[]}){
  const BUCKETS=10,BUCKET_S=30;
  const now=Date.now();
  const buckets=Array.from({length:BUCKETS},(_,i)=>{
    const end=now-(BUCKETS-1-i)*BUCKET_S*1000;
    const start=end-BUCKET_S*1000;
    return events.filter(e=>{const t=new Date(e.ts).getTime();return t>=start&&t<end;}).length;
  });
  const max=Math.max(...buckets,1);
  return(
    <div>
      <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:8}}>
        Event Rate · last {BUCKETS*BUCKET_S/60}min (30s buckets)
      </div>
      <div style={{display:"flex",alignItems:"flex-end",gap:3,height:48,marginBottom:4}}>
        {buckets.map((n,i)=>{
          const h=Math.max(n/max*100,n>0?8:2);
          const age=(BUCKETS-1-i)/BUCKETS;
          const opacity=0.3+0.7*(1-age);
          return(
            <div key={i} style={{flex:1,display:"flex",flexDirection:"column" as const,alignItems:"center",height:"100%",justifyContent:"flex-end"}}>
              {n>0&&<div style={{fontSize:7,color:"#22d3ee",marginBottom:2,opacity}}>{n}</div>}
              <div style={{width:"100%",borderRadius:"2px 2px 0 0",height:`${h}%`,
                background:`linear-gradient(180deg,#22d3ee,#06b6d4)`,opacity,transition:"height 0.4s"}}/>
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#94a3b8"}}>
        <span>-{BUCKETS*BUCKET_S/60}min</span><span>now</span>
      </div>
    </div>
  );
}

/* ── ท่อสัญญาณ Funnel ──────────────────────────────────────────── */
function SignalFunnel({events}:{events:Ev[]}){
  const counts={
    signals:  events.filter(e=>e.topic==="TRADE_SIGNAL").length,
    research: events.filter(e=>e.topic==="RESEARCH_COMPLETE").length,
    approved: events.filter(e=>e.topic==="SIGNAL_APPROVED").length,
    rejected: events.filter(e=>e.topic==="SIGNAL_REJECTED").length,
    trades:   events.filter(e=>e.topic==="TRADE_APPROVED").length,
    blocked:  events.filter(e=>e.topic==="POLICY_BLOCKED").length,
  };
  const top=Math.max(counts.signals,1);
  const steps=[
    {label:"สัญญาณ",    n:counts.signals,  col:"#06b6d4"},
    {label:"วิจัยแล้ว", n:counts.research, col:"#8b5cf6"},
    {label:"กรองแล้ว",  n:counts.approved, col:"#f59e0b"},
    {label:"อนุมัติ",   n:counts.trades,   col:"#10b981"},
  ];
  return(
    <div>
      <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:10}}>ท่อสัญญาณ</div>
      {steps.map((s,i)=>{
        const w=Math.max(s.n/top*100,s.n>0?4:1);
        const pct=i>0?steps[i-1].n>0?Math.round(s.n/steps[i-1].n*100):0:100;
        return(
          <div key={s.label} style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3,fontSize:9}}>
              <span style={{color:s.col,fontWeight:700}}>{s.label}</span>
              <div>
                {i>0&&<span style={{color:"#94a3b8",marginRight:6}}>{pct}% ผ่าน</span>}
                <span style={{color:"#64748b",fontFamily:"var(--font-mono,monospace)",fontWeight:700}}>{s.n}</span>
              </div>
            </div>
            <div style={{height:5,background:"rgba(0,0,0,0.03)",borderRadius:3,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${w}%`,background:`linear-gradient(90deg,${s.col}88,${s.col})`,borderRadius:3,transition:"width 0.6s"}}/>
            </div>
          </div>
        );
      })}
      <div style={{display:"flex",gap:8,marginTop:10}}>
        <div style={{flex:1,padding:"7px 10px",borderRadius:8,background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.2)"}}>
          <div style={{fontSize:7,color:"#ef4444",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:3}}>ปฏิเสธ</div>
          <div style={{fontSize:18,fontWeight:800,color:"#ef4444",fontFamily:"var(--font-mono,monospace)"}}>{counts.rejected}</div>
        </div>
        <div style={{flex:1,padding:"7px 10px",borderRadius:8,background:"rgba(245,158,11,0.07)",border:"1px solid rgba(245,158,11,0.2)"}}>
          <div style={{fontSize:7,color:"#f59e0b",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:3}}>Blocked</div>
          <div style={{fontSize:18,fontWeight:800,color:"#f59e0b",fontFamily:"var(--font-mono,monospace)"}}>{counts.blocked}</div>
        </div>
      </div>
    </div>
  );
}

/* ── Circuit Breaker Panel ───────────────────────────────────────────── */
function CircuitBreakerPanel({cb}:{cb:CbStatus|null}){
  if(!cb) return(
    <Card accent="#334155" style={{flex:1}}>
      <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:12}}>🔌 เซอร์กิตเบรกเกอร์</div>
      <div style={{color:"#94a3b8",fontSize:11}}>กำลังเชื่อมต่อ…</div>
    </Card>
  );
  const col         = cb.triggered ? "#ef4444" : "#10b981";
  const dayNotional = cb.day_notional  ?? 0;
  const dailyBudget = cb.daily_budget  ?? 620;
  const maxConsec   = cb.max_consec    ?? 5;
  const consec      = cb.consec        ?? 0;
  const budgetPct   = dailyBudget>0 ? Math.min(dayNotional/dailyBudget*100,100) : 0;
  const budgetCol   = budgetPct>80?"#ef4444":budgetPct>50?"#f59e0b":"#10b981";
  return(
    <Card accent={col} style={{flex:1}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:"#64748b"}}>🔌 เซอร์กิตเบรกเกอร์</div>
        <div style={{display:"flex",alignItems:"center",gap:7,padding:"4px 12px",borderRadius:8,
          background:`${col}18`,border:`1px solid ${col}33`}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:col,
            boxShadow:`0 0 8px ${col}`,animation:cb.triggered?"pulse 1s ease infinite":undefined}}/>
          <span style={{fontSize:11,fontWeight:800,color:col,letterSpacing:"0.05em"}}>
            {cb.triggered?"TRIGGERED":"ARMED"}
          </span>
        </div>
      </div>

      {cb.triggered&&(
        <div style={{padding:"10px 14px",borderRadius:10,marginBottom:14,
          background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.25)"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#ef4444",marginBottom:4}}>⛔ Reason</div>
          <div style={{fontSize:11,color:"#fca5a5",lineHeight:1.5}}>{cb.reason}</div>
          {cb.triggered_at&&(
            <div style={{fontSize:9,color:"#7f1d1d",marginTop:6}}>
              At {new Date(cb.triggered_at).toLocaleString()}
            </div>
          )}
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
        <div style={{padding:"10px 12px",borderRadius:10,background:"#f1f5f9",border:"1px solid rgba(0,0,0,0.04)"}}>
          <div style={{fontSize:7,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:4}}>ปฏิเสธต่อเนื่อง</div>
          <div style={{fontSize:22,fontWeight:800,color:consec>=maxConsec?"#ef4444":consec>0?"#f59e0b":"#10b981",fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>
            {consec}<span style={{fontSize:11,color:"#94a3b8"}}>/{maxConsec}</span>
          </div>
        </div>
        <div style={{padding:"10px 12px",borderRadius:10,background:"#f1f5f9",border:"1px solid rgba(0,0,0,0.04)"}}>
          <div style={{fontSize:7,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:4}}>ความเสี่ยงรายวัน (USD)</div>
          <div style={{fontSize:15,fontWeight:800,color:budgetCol,fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>
            ${dayNotional.toLocaleString("en-US",{maximumFractionDigits:0})}
          </div>
          <div style={{fontSize:8,color:"#94a3b8",marginTop:2}}>/ ${dailyBudget.toLocaleString("en-US",{maximumFractionDigits:0})}</div>
        </div>
      </div>

      <div style={{fontSize:8,color:"#475569",marginBottom:5}}>งบประมาณวันนี้ที่ใช้ไป</div>
      <div style={{height:8,background:"rgba(0,0,0,0.04)",borderRadius:4,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${budgetPct}%`,borderRadius:4,
          background:`linear-gradient(90deg,${budgetCol}88,${budgetCol})`,transition:"width 0.6s"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:"#94a3b8",marginTop:4}}>
        <span>$0</span>
        <span style={{color:budgetCol,fontWeight:700}}>{budgetPct.toFixed(1)}%</span>
        <span>${dailyBudget.toLocaleString("en-US",{maximumFractionDigits:0})}</span>
      </div>

      {!cb.triggered&&(
        <div style={{fontSize:9,color:"#94a3b8",marginTop:12,padding:"6px 10px",borderRadius:7,
          background:"rgba(0,0,0,0.03)",border:"1px solid rgba(0,0,0,0.04)"}}>
          Auto-reset: midnight UTC · Manual: /resume via Telegram
        </div>
      )}
    </Card>
  );
}

/* ── Broker Status ───────────────────────────────────────────────────── */
function BrokerStatus({broker}:{broker:BriefingBroker|null}){
  if(!broker) return null;
  const isLive   = broker.live;
  const col      = isLive ? "#ef4444" : "#f59e0b";
  const sigCol   = broker.signal==="mock" ? "#f59e0b" : broker.signal==="twelvedata" ? "#22d3ee" : "#6366f1";
  return(
    <Card accent={col} style={{flex:1}}>
      <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:14}}>🏦 โหมดโบรกเกอร์</div>

      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <div style={{width:52,height:52,borderRadius:16,background:`${col}18`,border:`2px solid ${col}44`,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>
          {isLive?"🔴":"🟡"}
        </div>
        <div>
          <div style={{fontSize:20,fontWeight:900,color:col,letterSpacing:"-0.02em"}}>
            {isLive?"ซื้อขายจริง":"โหมดทดลอง"}
          </div>
          <div style={{fontSize:10,color:"#64748b",marginTop:2}}>
            {isLive?"ออเดอร์จริงบน OANDA":"จำลอง — ไม่มีออเดอร์จริง"}
          </div>
        </div>
      </div>

      <div style={{display:"flex",flexDirection:"column" as const,gap:8}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          padding:"8px 12px",borderRadius:9,background:"#f1f5f9",border:"1px solid rgba(0,0,0,0.04)"}}>
          <span style={{fontSize:10,color:"#64748b"}}>OANDA Environment</span>
          <span style={{fontSize:11,fontWeight:700,color:col,fontFamily:"var(--font-mono,monospace)"}}>
            {broker.mode.toUpperCase()}
          </span>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          padding:"8px 12px",borderRadius:9,background:"#f1f5f9",border:"1px solid rgba(0,0,0,0.04)"}}>
          <span style={{fontSize:10,color:"#64748b"}}>Signal Source</span>
          <span style={{fontSize:11,fontWeight:700,color:sigCol,fontFamily:"var(--font-mono,monospace)"}}>
            {broker.signal.toUpperCase()}
          </span>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          padding:"8px 12px",borderRadius:9,background:"#f1f5f9",border:"1px solid rgba(0,0,0,0.04)"}}>
          <span style={{fontSize:10,color:"#64748b"}}>Order Execution</span>
          <span style={{fontSize:11,fontWeight:700,color:isLive?"#ef4444":"#10b981"}}>
            {isLive?"ออเดอร์จริง":"จำลอง"}
          </span>
        </div>
      </div>
    </Card>
  );
}

/* ── รายงานประจำวัน Card ─────────────────────────────────────────────── */
function DailyBriefingCard({b}:{b:Briefing|null}){
  if(!b) return null;
  const t=b.today;
  const y=b.yesterday;
  const pnlCol = t.total_pnl>=0?"#10b981":"#ef4444";
  const ypnlCol = y.total_pnl>=0?"#10b981":"#ef4444";
  const boardEntries=Object.entries(t.board).sort((a,b)=>b[1]-a[1]);
  const boardColor=(res:string)=>res==="loosen"?"#10b981":res==="tighten"?"#ef4444":"#94a3b8";
  const boardIcon =(res:string)=>res==="loosen"?"🟢":res==="tighten"?"🔴":"⚪";
  return(
    <Card accent="#22d3ee">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,color:"#64748b"}}>📊 รายงานประจำวัน</div>
        <div style={{fontSize:9,color:"#94a3b8"}}>เวลากรุงเทพฯ</div>
      </div>

      {/* Today vs เมื่อวาน */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
        {/* Today */}
        <div style={{padding:"12px 14px",borderRadius:12,background:"rgba(34,211,238,0.06)",border:"1px solid rgba(34,211,238,0.15)"}}>
          <div style={{fontSize:9,fontWeight:700,color:"#22d3ee",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:10}}>Today</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {[
              {l:"สัญญาณ",   v:t.total.toString(),             c:"#f1f5f9"},
              {l:"Approved",  v:`${t.approved} (${t.approval_rate}%)`, c:"#10b981"},
              {l:"Blocked",   v:t.blocked.toString(),           c:"#f59e0b"},
              {l:"Win Rate",  v:t.wins+t.losses>0?`${t.win_rate}%`:"—",   c:"#818cf8"},
            ].map(r=>(
              <div key={r.l}>
                <div style={{fontSize:7,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em"}}>{r.l}</div>
                <div style={{fontSize:13,fontWeight:800,color:r.c,fontFamily:"var(--font-mono,monospace)",lineHeight:1.2}}>{r.v}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:10,paddingTop:8,borderTop:"1px solid rgba(0,0,0,0.04)"}}>
            <div style={{fontSize:7,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:2}}>P&L Today</div>
            <div style={{fontSize:20,fontWeight:900,color:pnlCol,fontFamily:"var(--font-mono,monospace)"}}>
              {t.total_pnl>=0?"+":""}{t.total_pnl.toFixed(2)}
            </div>
          </div>
        </div>

        {/* เมื่อวาน */}
        <div style={{padding:"12px 14px",borderRadius:12,background:"#f8fafc",border:"1px solid rgba(0,0,0,0.05)"}}>
          <div style={{fontSize:9,fontWeight:700,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:10}}>เมื่อวาน</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {[
              {l:"สัญญาณ",  v:y.total.toString(),    c:"#64748b"},
              {l:"Approved", v:y.approved.toString(), c:"#64748b"},
              {l:"Wins",     v:y.wins.toString(),     c:"#64748b"},
              {l:"P&L",      v:y.total_pnl>=0?`+$${y.total_pnl.toFixed(2)}`:`-$${Math.abs(y.total_pnl).toFixed(2)}`, c:ypnlCol},
            ].map(r=>(
              <div key={r.l}>
                <div style={{fontSize:7,color:"#94a3b8",textTransform:"uppercase" as const,letterSpacing:"0.08em"}}>{r.l}</div>
                <div style={{fontSize:13,fontWeight:800,color:r.c,fontFamily:"var(--font-mono,monospace)",lineHeight:1.2}}>{r.v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Board summary */}
      {boardEntries.length>0&&(
        <div style={{padding:"10px 12px",borderRadius:10,background:"#f8fafc",border:"1px solid rgba(0,0,0,0.04)"}}>
          <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:8}}>มติบอร์ดวันนี้</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap" as const}}>
            {boardEntries.map(([res,cnt])=>(
              <div key={res} style={{display:"flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:7,
                background:`${boardColor(res)}14`,border:`1px solid ${boardColor(res)}30`}}>
                <span style={{fontSize:12}}>{boardIcon(res)}</span>
                <span style={{fontSize:10,fontWeight:700,color:boardColor(res)}}>{res.toUpperCase()}</span>
                <span style={{fontSize:12,fontWeight:800,color:boardColor(res),fontFamily:"var(--font-mono,monospace)"}}>×{cnt}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confidence */}
      {t.avg_confidence>0&&(
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          marginTop:10,padding:"8px 12px",borderRadius:9,
          background:"#f8fafc",border:"1px solid rgba(0,0,0,0.04)"}}>
          <span style={{fontSize:10,color:"#64748b"}}>ความเชื่อมั่นเฉลี่ย</span>
          <span style={{fontSize:14,fontWeight:800,color:"#818cf8",fontFamily:"var(--font-mono,monospace)"}}>
            {t.avg_confidence.toFixed(1)}%
            <span style={{fontSize:9,color:"#94a3b8",fontWeight:400,marginLeft:6}}>
              (peak {t.max_confidence}%)
            </span>
          </span>
        </div>
      )}

      {/* Per-symbol today */}
      {t.by_symbol&&Object.keys(t.by_symbol).length>0&&(
        <div style={{marginTop:10,padding:"10px 12px",borderRadius:9,
          background:"#f8fafc",border:"1px solid rgba(0,0,0,0.04)"}}>
          <div style={{fontSize:7,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:8}}>By Symbol</div>
          <div style={{display:"flex",flexDirection:"column" as const,gap:5}}>
            {Object.entries(t.by_symbol).map(([sym,s])=>{
              const rate=s.total>0?Math.round(s.approved/s.total*100):0;
              const col=rate>=60?"#10b981":rate>=40?"#f59e0b":"#ef4444";
              return(
                <div key={sym} style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:9,fontWeight:700,color:col,fontFamily:"var(--font-mono,monospace)",width:60,flexShrink:0}}>{sym}</span>
                  <div style={{flex:1,height:4,background:"rgba(0,0,0,0.04)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${rate}%`,background:col,borderRadius:2,transition:"width 0.6s"}}/>
                  </div>
                  <span style={{fontSize:9,color:"#475569",fontFamily:"var(--font-mono,monospace)",width:55,textAlign:"right" as const}}>
                    ✅{s.approved} 🚫{s.blocked}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ── Event SOC ───────────────────────────────────────────────────────── */
function EventSOC({events,clients}:{events:Ev[];clients:number}){
  const now=Date.now();
  const last60=events.filter(e=>now-new Date(e.ts).getTime()<60_000).length;
  const last60Sigs=events.filter(e=>e.topic==="TRADE_SIGNAL"&&now-new Date(e.ts).getTime()<60_000).length;
  return(
    <Card accent="#22d3ee">
      <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:16}}>📡 ศูนย์ควบคุม SOC</div>

      {/* KPI row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:16}}>
        {[
          {l:"เหตุการณ์/นาที", v:last60.toString(),        c:"#22d3ee"},
          {l:"สัญญาณ/นาที",  v:last60Sigs.toString(),    c:"#06b6d4"},
          {l:"WS ผู้ใช้",    v:clients.toString(),       c:"#818cf8"},
          {l:"บัฟเฟอร์",     v:events.length.toString(), c:"#94a3b8"},
        ].map(r=>(
          <div key={r.l} style={{padding:"8px 10px",borderRadius:9,background:"#f1f5f9",border:"1px solid rgba(0,0,0,0.04)"}}>
            <div style={{fontSize:7,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:3}}>{r.l}</div>
            <div style={{fontSize:20,fontWeight:800,color:r.c,fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>{r.v}</div>
          </div>
        ))}
      </div>

      {/* Event rate chart */}
      <div style={{marginBottom:16,padding:"12px 14px",borderRadius:10,background:"#f8fafc",border:"1px solid rgba(0,0,0,0.04)"}}>
        <EventRateChart events={events}/>
      </div>

      {/* Signal funnel */}
      <div style={{marginBottom:14,padding:"12px 14px",borderRadius:10,background:"#f8fafc",border:"1px solid rgba(0,0,0,0.04)"}}>
        <SignalFunnel events={events}/>
      </div>

      {/* Event distribution */}
      <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:10}}>การกระจายเหตุการณ์</div>
      {Object.entries(EV_COLOR).map(([topic,col])=>{
        const count=events.filter(e=>e.topic===topic).length;
        if(count===0)return null;
        const pctE=events.length>0?(count/events.length*100):0;
        return(
          <div key={topic} style={{marginBottom:5}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
              <span style={{fontSize:9,color:col,fontWeight:700}}>{topic.replace(/_/g," ")}</span>
              <span style={{fontSize:9,color:"#475569",fontFamily:"var(--font-mono,monospace)"}}>{count}</span>
            </div>
            <div style={{height:3,background:"rgba(0,0,0,0.03)",borderRadius:2,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${pctE}%`,background:col,opacity:0.7,transition:"width 0.6s"}}/>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/* ── Agent Registry ──────────────────────────────────────────────────── */
function AgentRegistry({agents,llm,hiredRoles}:{agents:AgentInfo[];llm:LLMMetrics;hiredRoles:Set<string>}){
  const execRoles=["ceo","cto","cfo","coo","cmo"];
  const agentCosts=llm.agents??{};
  const allAgents=execRoles.map(role=>{
    const found=agents.find(a=>a.role===role);
    return found??{role,division:"executive_board",online:hiredRoles.has(role),hired_at:"",llm_calls:0,llm_cost_usd:0};
  });
  return(
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>
      {allAgents.map(ag=>{
        const om=OFFICER[ag.role];
        const online=ag.online||hiredRoles.has(ag.role);
        const agCalls=agentCosts[ag.role]?.calls??0;
        const agCost=agentCosts[ag.role]?.cost_usd??0;
        return(
          <Card key={ag.role} accent={om?.color}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <div style={{width:44,height:44,borderRadius:14,flexShrink:0,
                background:`${om?.color??"#475569"}1a`,border:`1.5px solid ${om?.color??"#475569"}33`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>
                {om?.icon??"🤖"}
              </div>
              <Chip label={online?"Online":"Offline"} color={online?"#10b981":"#334155"}/>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:800,color:om?.color??"#94a3b8",letterSpacing:"-0.01em"}}>{ag.role.toUpperCase()}</div>
              <div style={{fontSize:10,color:"#64748b",marginTop:2}}>{om?.name??ag.role}</div>
              <div style={{fontSize:9,color:"#475569",marginTop:1}}>{om?.title??ag.division}</div>
            </div>
            <div style={{display:"flex",flexWrap:"wrap" as const,gap:4,marginBottom:10}}>
              {(OFFICER_SKILLS[ag.role]??[]).map(sk=><Chip key={sk} label={sk} color={om?.color??"#475569"}/>)}
            </div>
            <div style={{borderTop:"1px solid rgba(0,0,0,0.04)",paddingTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#475569",marginBottom:4}}>
                <span>เรียกใช้ LLM</span>
                <span style={{color:"#64748b",fontFamily:"var(--font-mono,monospace)"}}>{agCalls}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#475569"}}>
                <span>ต้นทุน</span>
                <span style={{color:"#fbbf24",fontFamily:"var(--font-mono,monospace)"}}>${agCost.toFixed(5)}</span>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ── ไทม์ไลน์เหตุการณ์ ────────────────────────────────────────────────── */
function CompanyTimeline({events}:{events:Ev[]}){
  const filtered=events.filter(e=>!["PING","HEALTH_TICK"].includes(e.topic)).slice(0,150);
  type Group={hour:string;items:Ev[]};
  const groups:Group[]=[];
  filtered.forEach(ev=>{
    const hr=new Date(ev.ts).toLocaleString("en-GB",{hour:"2-digit",minute:"2-digit",day:"numeric",month:"short"});
    const last=groups[groups.length-1];
    if(!last||last.hour!==hr)groups.push({hour:hr,items:[ev]});
    else last.items.push(ev);
  });
  return(
    <div style={{maxHeight:520,overflowY:"auto",paddingRight:4}}>
      {groups.length===0?(
        <div style={{textAlign:"center" as const,color:"#475569",padding:"36px 0",fontStyle:"italic",fontSize:12}}>ยังไม่มีเหตุการณ์…</div>
      ):groups.map((g,gi)=>(
        <div key={gi} style={{display:"flex",gap:16,marginBottom:18}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:54,flexShrink:0}}>
            <div style={{fontSize:8,color:"#475569",fontFamily:"var(--font-mono,monospace)",textAlign:"center" as const,lineHeight:1.4,marginBottom:5}}>{g.hour}</div>
            <div style={{width:1,flex:1,background:"rgba(0,0,0,0.05)"}}/>
          </div>
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:3}}>
            {g.items.map((ev,i)=>{
              const col=EV_COLOR[ev.topic]??"#475569";
              const icon=TOPIC_ICON[ev.topic]??"·";
              return(
                <div key={i} style={{display:"flex",alignItems:"flex-start",gap:7,padding:"6px 9px",borderRadius:7,background:"#f8fafc",borderLeft:`2px solid ${col}66`}}>
                  <span style={{fontSize:11,flexShrink:0,marginTop:1}}>{icon}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                      <Chip label={ev.topic.replace(/_/g," ")} color={col}/>
                      <span style={{fontSize:9,color:"#475569",fontFamily:"var(--font-mono,monospace)"}}>{new Date(ev.ts).toLocaleTimeString()}</span>
                    </div>
                    <div style={{fontSize:10,color:"#64748b",lineHeight:1.5}}>{evSummary(ev)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ══ SOC PAGE ════════════════════════════════════════════════════════════ */
export default function SOCPage(){
  const[events,         setEvents]         = useState<Ev[]>([]);
  const[llmMetrics,     setLlmMetrics]     = useState<LLMMetrics>({});
  const[registryAgents, setRegistryAgents] = useState<AgentInfo[]>([]);
  const[hiredRoles,     setHiredRoles]     = useState<Set<string>>(new Set());
  const[wsClients,      setWsClients]      = useState(0);
  const[connected,      setConnected]      = useState(false);
  const[cbData,         setCbData]         = useState<CbStatus|null>(null);
  const[briefing,       setBriefing]       = useState<Briefing|null>(null);
  const wsRef=useRef<WebSocket|null>(null);

  const loadLLM     =()=>fetch(`${GW}/metrics/llm`).then(r=>r.json()).then((d:unknown)=>{if(d&&typeof d==="object"&&!Array.isArray(d))setLlmMetrics(d as LLMMetrics);}).catch(()=>{});
  const loadRegistry=()=>fetch(`${GW}/registry`).then(r=>r.json()).then((d:unknown)=>{const a=(d as{agents?:unknown})?.agents;if(Array.isArray(a))setRegistryAgents(a as AgentInfo[]);}).catch(()=>{});
  const loadCB      =()=>fetch(`${GW}/circuit-breaker`).then(r=>r.json()).then((d:CbStatus)=>setCbData(d)).catch(()=>{});
  const loadBriefing =()=>fetch(`${GW}/briefing`).then(r=>r.json()).then((d:Briefing)=>{if(d?.today)setBriefing(d);}).catch(()=>{});

  useEffect(()=>{
    fetch(`${GW}/events`).then(r=>r.json()).then((d:Ev[])=>setEvents(d.filter(e=>!["PING","HEALTH_TICK"].includes(e.topic)))).catch(()=>{});
    loadLLM();loadRegistry();loadCB();loadBriefing();
    const poll=setInterval(()=>{loadLLM();loadRegistry();loadCB();loadBriefing();},30_000);

    function connect(){
      const ws=new WebSocket(GWWS);wsRef.current=ws;
      ws.onopen=()=>setConnected(true);
      ws.onclose=()=>{setConnected(false);setTimeout(connect,3000);};
      ws.onerror=()=>ws.close();
      ws.onmessage=({data})=>{
        let ev:Ev;
        try { ev=JSON.parse(data); } catch { return; }
        if(!ev?.topic) return;
        const d=ev.data??{};
        if(ev.topic==="PING"){const c=(d as{clients?:number}).clients;if(typeof c==="number")setWsClients(c);return;}
        if(ev.topic==="HEALTH_TICK")return;
        setEvents(p=>[ev,...p].slice(0,300));
        if(ev.topic==="AGENT_HIRED"){const r=(d as{role?:string}).role;if(r)setHiredRoles(p=>new Set([...p,r]));}
        if(ev.topic==="AGENT_FIRED"){const r=(d as{role?:string}).role;if(r)setHiredRoles(p=>{const s=new Set(p);s.delete(r);return s;});}
        if(["BOARD_RESOLUTION","TRADE_APPROVED","POLICY_ADJUSTED"].includes(ev.topic)){loadLLM();loadRegistry();}
        if(ev.topic==="CIRCUIT_BREAKER_TRIGGERED"||ev.topic==="CIRCUIT_BREAKER_RESET"){loadCB();}
        if(ev.topic==="TRADE_CLOSED"||ev.topic==="TRADE_APPROVED"||ev.topic==="BOARD_RESOLUTION"){loadBriefing();}
      };
    }
    connect();
    return()=>{wsRef.current?.close();clearInterval(poll);};
  },[]);

  const totalCalls=llmMetrics.total?.calls??0;
  const totalCost=llmMetrics.total?.cost_usd??0;

  return(
    <div className="dot-bg" style={{minHeight:"100vh",background:"var(--bg)",padding:"24px 28px 48px"}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
        <div>
          <div style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",textTransform:"uppercase" as const,marginBottom:6}}>
            POLIS HQ › เทรด › ศูนย์ควบคุม
          </div>
          <div style={{fontSize:24,fontWeight:800,letterSpacing:"-0.03em",color:"#0f172a",lineHeight:1}}>ศูนย์ปฏิบัติการ & ความปลอดภัย</div>
          <div style={{fontSize:11,color:"#64748b",marginTop:4}}>ต้นทุน LLM · ทะเบียน Agent · ไทม์ไลน์เหตุการณ์</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{padding:"5px 12px",borderRadius:8,background:"rgba(0,0,0,0.03)",border:"1px solid rgba(0,0,0,0.06)"}}>
            <span style={{fontSize:9,color:"#475569"}}>LLM calls: </span>
            <span style={{fontSize:13,fontWeight:800,color:"#818cf8",fontFamily:"var(--font-mono,monospace)"}}>{totalCalls}</span>
            <span style={{fontSize:9,color:"#94a3b8",marginLeft:6}}>est. </span>
            <span style={{fontSize:11,fontWeight:700,color:"#fbbf24",fontFamily:"var(--font-mono,monospace)"}}>${totalCost.toFixed(4)}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",
            borderRadius:8,background:"rgba(0,0,0,0.03)",border:"1px solid rgba(0,0,0,0.06)"}}>
            <Dot color={connected?"#10b981":"#ef4444"} pulse={connected}/>
            <span style={{fontSize:10,color:connected?"#34d399":"#f87171",fontWeight:600}}>{connected?"ออนไลน์":"กำลังเชื่อมต่อ…"}</span>
          </div>
        </div>
      </div>

      {/* Safety + Broker */}
      <SectionLabel icon="🔌" label="สถานะความปลอดภัย" accent="#ef4444"/>
      <div style={{display:"flex",gap:12,marginBottom:4}}>
        <CircuitBreakerPanel cb={cbData}/>
        <BrokerStatus broker={briefing?.broker??null}/>
      </div>

      {/* SOC cards */}
      <SectionLabel icon="🛡" label="ศูนย์ควบคุม SOC" accent="#818cf8"/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <LLMMonitor llm={llmMetrics}/>
        <EventSOC events={events} clients={wsClients}/>
      </div>

      {/* Agent registry */}
      <SectionLabel icon="🤖" label="ทะเบียน Agent" accent="#f472b6"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>executive_board division · v1.0</span>}/>
      <AgentRegistry agents={registryAgents} llm={llmMetrics} hiredRoles={hiredRoles}/>

      {/* รายงานประจำวัน */}
      <SectionLabel icon="📊" label="รายงานประจำวัน" accent="#22d3ee"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>เวลากรุงเทพฯ · รีเฟรชอัตโนมัติทุก 30s</span>}/>
      <DailyBriefingCard b={briefing}/>

      {/* Timeline */}
      <SectionLabel icon="🕐" label="ไทม์ไลน์เหตุการณ์" accent="#f59e0b"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>{events.length} เหตุการณ์</span>}/>
      <Card>
        <CompanyTimeline events={events}/>
      </Card>

    </div>
  );
}
