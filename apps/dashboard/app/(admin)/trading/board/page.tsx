"use client";
import { useEffect, useRef, useState } from "react";

const GW   = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";
const GWWS = process.env.NEXT_PUBLIC_GATEWAY_WS  ?? "ws://localhost:19000/ws/feed";

type Ev         = { topic: string; data: Record<string, unknown>; ts: string };
type Resolution = { id: number; resolution: string; directive: string; confidence: number|null; metrics: Record<string,unknown>; exec_views: Record<string,{assessment:string;vote:string}>; created_at: string };
type OfficerStatus = "idle"|"analyzing"|"decided";
type OfficerState  = { status:OfficerStatus; vote?:string; assessment?:string; signal?:{direction:string;sentiment:string;confidence:number}; ts?:string };
type OfficerMap    = Record<string,OfficerState>;

const BOARD = ["ceo","cto","cfo","coo","cmo"];
const OFFICER: Record<string,{icon:string;color:string;title:string;name:string;focus:string}> = {
  ceo:{icon:"👔",color:"#818cf8",title:"Chief Executive", name:"Marcus",focus:"Corporate Strategy"},
  cto:{icon:"💻",color:"#22d3ee",title:"Chief Technology",name:"Aria",  focus:"Technical Analysis"},
  cfo:{icon:"💰",color:"#fbbf24",title:"Chief Financial",  name:"Nova",  focus:"Risk & P&L"},
  coo:{icon:"⚙️", color:"#34d399",title:"Chief Operating", name:"Atlas", focus:"Trade Execution"},
  cmo:{icon:"📊",color:"#f472b6",title:"Chief Marketing",  name:"Iris",  focus:"Market Sentiment"},
};
const RES_COLOR: Record<string,string>  = { tighten:"#ef4444", hold:"#6b7280", loosen:"#10b981" };
const VOTE_COLOR: Record<string,string> = { tighten:"#ef4444", hold:"#6b7280", loosen:"#10b981", approve:"#10b981", block:"#ef4444" };
const OFFICER_SKILLS: Record<string,string[]> = {
  ceo:["Strategy","Vision","Board","Hiring"],
  cto:["LLM","Pipeline","Research","Analysis"],
  cfo:["Risk","P&L","Budget","Cost"],
  coo:["Execution","Throughput","Latency","Ops"],
  cmo:["Sentiment","Regime","Macro","Bias"],
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

/* ── Officer Pod ─────────────────────────────────────────────────────── */
function OfficerPod({role,state,online}:{role:string;state:OfficerState;online:boolean}){
  const m=OFFICER[role],isA=state.status==="analyzing",isD=state.status==="decided";
  const vc=VOTE_COLOR[state.vote??""]??"#475569";
  const borderC=isA?m.color:isD?vc:"rgba(0,0,0,0.06)";
  return(
    <div style={{
      background:"#ffffff",
      border:`1px solid ${borderC}${isA||isD?"55":""}`,
      borderRadius:18,padding:"20px 18px",
      display:"flex",flexDirection:"column",gap:12,
      boxShadow:(isA||isD)?`0 0 24px ${isA?m.color:vc}18,0 4px 24px rgba(0,0,0,0.08)`:"0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.04)",
      transition:"all 0.5s ease",position:"relative",overflow:"hidden",
    }}>
      {(isA||isD)&&<div style={{position:"absolute",inset:0,
        background:`radial-gradient(ellipse at 50% -10%,${isA?m.color:vc}10,transparent 65%)`,
        pointerEvents:"none"}}/>}

      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
        <div style={{
          width:46,height:46,borderRadius:14,flexShrink:0,
          background:`linear-gradient(135deg,${m.color}28,${m.color}0a)`,
          border:`1.5px solid ${m.color}40`,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,
          boxShadow:isA?`0 0 16px ${m.color}44`:undefined,
        }}>{m.icon}</div>
        <div style={{
          width:8,height:8,borderRadius:"50%",marginTop:3,
          background:!online?"#1e293b":isA?m.color:isD?vc:"#1e293b",
          boxShadow:isA?`0 0 12px ${m.color},0 0 24px ${m.color}66`:isD?`0 0 8px ${vc}88`:undefined,
          transition:"all 0.4s",
        }}/>
      </div>

      <div>
        <div style={{fontSize:14,fontWeight:800,color:m.color,letterSpacing:"-0.01em",lineHeight:1.1}}>{role.toUpperCase()}</div>
        <div style={{fontSize:11,color:"#64748b",fontWeight:500,marginTop:2}}>{m.name}</div>
        <div style={{fontSize:9,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.07em",marginTop:1}}>{m.title}</div>
      </div>

      <div style={{display:"flex",flexWrap:"wrap" as const,gap:4}}>
        {(OFFICER_SKILLS[role]??[]).map(sk=><Chip key={sk} label={sk} color={m.color}/>)}
      </div>

      <div style={{
        flex:1,borderRadius:10,padding:"10px 12px",minHeight:72,
        background:isA?`${m.color}0d`:isD?`${vc}08`:"#f8fafc",
        border:`1px solid ${isA?m.color+"30":isD?vc+"28":"rgba(0,0,0,0.04)"}`,
        transition:"all 0.4s",
      }}>
        {!online?(
          <span style={{fontSize:10,color:"#475569",fontStyle:"italic"}}>Offline</span>
        ):isA?(
          <div>
            <div style={{fontSize:11,fontWeight:700,color:m.color,marginBottom:4,display:"flex",alignItems:"center",gap:5}}>
              <span className="spinning">⟳</span> กำลังวิเคราะห์…
            </div>
            <div style={{fontSize:10,color:"#64748b"}}>{m.focus}</div>
            {state.signal&&(
              <div style={{display:"flex",gap:5,flexWrap:"wrap" as const,marginTop:6}}>
                <Chip label={state.signal.direction.toUpperCase()} color={m.color}/>
                <Chip label={`${state.signal.confidence}%`} color="#64748b"/>
              </div>
            )}
          </div>
        ):isD?(
          <div>
            <div style={{marginBottom:6}}><Chip label={(state.vote??"—").toUpperCase()} color={vc}/></div>
            <div style={{fontSize:10,color:"#64748b",lineHeight:1.6,
              display:"-webkit-box",overflow:"hidden",WebkitLineClamp:4,WebkitBoxOrient:"vertical" as const}}>
              {state.assessment}
            </div>
          </div>
        ):(
          <span style={{fontSize:10,color:"#475569",fontStyle:"italic"}}>รอสัญญาณ…</span>
        )}
      </div>

      {state.ts&&(
        <div style={{fontSize:9,color:"#94a3b8",textAlign:"right" as const,letterSpacing:"0.04em"}}>
          {new Date(state.ts).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

/* ── ห้องประชุมบอร์ด ──────────────────────────────────────────────────────── */
function BoardRoom({resolutions,lastResTs}:{resolutions:Resolution[];lastResTs:number|null}){
  const[cd,setCd]=useState("—");
  useEffect(()=>{
    const tick=()=>{
      if(!lastResTs){setCd("~5:00");return;}
      const r=300-((Date.now()-lastResTs)/1000%300);
      setCd(`${Math.floor(r/60)}:${String(Math.floor(r%60)).padStart(2,"0")}`);
    };
    tick();const t=setInterval(tick,1000);return()=>clearInterval(t);
  },[lastResTs]);
  const latest=resolutions[0];
  const rc=latest?RES_COLOR[latest.resolution]??"#6b7280":"#6366f1";
  return(
    <Card accent={rc}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:18}}>🏛</span>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#0f172a"}}>ห้องประชุมบอร์ด</div>
            <div style={{fontSize:9,color:"#475569"}}>คณะกรรมการบริหาร</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:7,padding:"5px 12px",borderRadius:18,
          background:"rgba(99,102,241,0.12)",border:"1px solid rgba(99,102,241,0.25)"}}>
          <span style={{fontSize:9,color:"#818cf8"}}>NEXT</span>
          <span style={{fontSize:13,fontWeight:700,color:"#818cf8",fontFamily:"var(--font-mono,monospace)"}}>{cd}</span>
        </div>
      </div>
      {!latest?(
        <div style={{color:"#475569",fontSize:12,textAlign:"center" as const,padding:"24px 0",fontStyle:"italic"}}>รอการประชุมครั้งแรก…</div>
      ):(
        <>
          <div style={{padding:"14px 16px",borderRadius:12,marginBottom:12,
            background:`linear-gradient(135deg,${rc}12,${rc}05)`,border:`1px solid ${rc}30`}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <Chip label={latest.resolution.toUpperCase()} color={rc}/>
              {latest.confidence!=null&&(
                <span style={{fontSize:18,fontWeight:800,color:rc,fontFamily:"var(--font-mono,monospace)"}}>{latest.confidence}%</span>
              )}
            </div>
            <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.6,fontStyle:"italic"}}>"{latest.directive}"</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
            {Object.entries(latest.exec_views??{}).map(([role,v])=>{
              const vc2=RES_COLOR[v.vote]??"#6b7280",om=OFFICER[role];
              return(
                <div key={role} style={{padding:"7px 9px",borderRadius:9,background:"#f8fafc",border:`1px solid ${vc2}18`}}>
                  <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                    <span style={{fontSize:10}}>{om?.icon??"👤"}</span>
                    <span style={{fontSize:9,fontWeight:800,color:om?.color??"#94a3b8",textTransform:"uppercase" as const,letterSpacing:"0.06em"}}>{role}</span>
                    <Chip label={v.vote.toUpperCase()} color={vc2}/>
                  </div>
                  <div style={{fontSize:9,color:"#475569",overflow:"hidden",whiteSpace:"nowrap" as const,textOverflow:"ellipsis"}}>{v.assessment}</div>
                </div>
              );
            })}
          </div>
          <div style={{fontSize:9,color:"#94a3b8",marginTop:8,textAlign:"right" as const}}>{new Date(latest.created_at).toLocaleTimeString()}</div>
        </>
      )}
    </Card>
  );
}

/* ── Vote Tally ──────────────────────────────────────────────────────── */
function VoteTally({views}:{views:Record<string,{vote:string;assessment:string}>}){
  const tally:Record<string,number>={};
  Object.values(views).forEach(v=>{tally[v.vote]=(tally[v.vote]??0)+1;});
  const total=Object.values(tally).reduce((a,b)=>a+b,0)||1;
  const order=["loosen","hold","tighten","approve","block"];
  const entries=order.filter(k=>tally[k]).map(k=>({vote:k,n:tally[k]}));
  if(!entries.length)return null;
  return(
    <div style={{marginBottom:10}}>
      <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.1em",marginBottom:6}}>Vote Tally</div>
      <div style={{display:"flex",gap:6,marginBottom:6}}>
        {entries.map(({vote,n})=>{
          const vc=RES_COLOR[vote]??"#6b7280";
          return(
            <div key={vote} style={{padding:"3px 10px",borderRadius:6,background:`${vc}18`,border:`1px solid ${vc}35`,fontSize:9,fontWeight:800,color:vc}}>
              {n}× {vote.toUpperCase()}
            </div>
          );
        })}
      </div>
      <div style={{height:4,borderRadius:2,overflow:"hidden",background:"rgba(0,0,0,0.03)",display:"flex"}}>
        {entries.map(({vote,n})=>{
          const vc=RES_COLOR[vote]??"#6b7280";
          return <div key={vote} style={{height:"100%",width:`${n/total*100}%`,background:vc,transition:"width 0.4s"}}/>;
        })}
      </div>
    </div>
  );
}

/* ── Resolution Card ─────────────────────────────────────────────────── */
function ResolutionCard({r}:{r:Resolution}){
  const[expanded,setExpanded]=useState(false);
  const col=RES_COLOR[r.resolution]??"#6b7280";
  const m=r.metrics??{};
  const views=r.exec_views??{};
  return(
    <div style={{padding:"16px 18px",borderRadius:14,
      background:`linear-gradient(135deg,${col}0a,transparent)`,border:`1px solid ${col}28`,marginBottom:10}}>

      {/* Header row */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:10}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:6,flexWrap:"wrap" as const}}>
            <Chip label={r.resolution.toUpperCase()} color={col}/>
            {r.confidence!=null&&<span style={{fontSize:14,fontWeight:800,color:col,fontFamily:"var(--font-mono,monospace)"}}>{r.confidence}%</span>}
            <span style={{fontSize:9,color:"#94a3b8",fontFamily:"var(--font-mono,monospace)"}}>{new Date(r.created_at).toLocaleTimeString()}</span>
          </div>
          <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.6,fontStyle:"italic"}}>"{r.directive}"</div>
        </div>
        <button type="button" onClick={()=>setExpanded(p=>!p)} style={{
          marginLeft:10,padding:"3px 9px",borderRadius:6,border:"1px solid rgba(0,0,0,0.06)",
          background:"rgba(0,0,0,0.03)",color:"#475569",fontSize:9,cursor:"pointer",flexShrink:0,
        }}>{expanded?"▲ Less":"▼ More"}</button>
      </div>

      {/* Metrics row */}
      <div style={{display:"flex",gap:16,marginBottom:8,fontSize:10,color:"#64748b"}}>
        <span>Decisions <b style={{color:"#64748b",fontFamily:"var(--font-mono,monospace)"}}>{String(m.total??0)}</b></span>
        <span>Approved <b style={{color:"#10b981",fontFamily:"var(--font-mono,monospace)"}}>{String(m.approved??0)}</b></span>
        <span>Rate <b style={{color:"#0f172a",fontFamily:"var(--font-mono,monospace)"}}>{String(m.approval_rate??0)}%</b></span>
        {m.avg_confidence!=null&&<span>Avg Conf <b style={{color:"#818cf8",fontFamily:"var(--font-mono,monospace)"}}>{String(m.avg_confidence)}%</b></span>}
      </div>
      {/* Per-symbol breakdown */}
      {!!m.by_symbol&&Object.keys(m.by_symbol as Record<string,unknown>).length>0&&(
        <div style={{display:"flex",gap:5,flexWrap:"wrap" as const,marginBottom:10}}>
          {Object.entries(m.by_symbol as Record<string,{total:number;approved:number;blocked:number}>).map(([sym,s])=>{
            const rate=s.total>0?Math.round(s.approved/s.total*100):0;
            const c=rate>=60?"#10b981":rate>=40?"#f59e0b":"#ef4444";
            return(
              <div key={sym} style={{padding:"3px 9px",borderRadius:6,background:`${c}10`,border:`1px solid ${c}28`,
                display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:9,fontWeight:700,color:c,fontFamily:"var(--font-mono,monospace)"}}>{sym}</span>
                <span style={{fontSize:8,color:"#475569"}}>✅{s.approved} 🚫{s.blocked}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Vote tally */}
      <VoteTally views={views}/>

      {/* Exec views — compact by default, expanded on toggle */}
      <div style={{display:"grid",gridTemplateColumns:expanded?"1fr":"1fr 1fr",gap:expanded?6:4}}>
        {Object.entries(views).map(([role,v])=>{
          const vc=RES_COLOR[v.vote]??"#6b7280",om=OFFICER[role];
          return(
            <div key={role} style={{padding:expanded?"10px 12px":"5px 9px",borderRadius:9,
              background:"#f8fafc",border:`1px solid ${vc}18`}}>
              <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:expanded?5:2}}>
                <span style={{fontSize:expanded?13:10}}>{om?.icon??"👤"}</span>
                <span style={{fontSize:9,fontWeight:800,color:om?.color??"#94a3b8",textTransform:"uppercase" as const,letterSpacing:"0.06em"}}>{role}</span>
                <Chip label={v.vote.toUpperCase()} color={vc}/>
              </div>
              <div style={{
                fontSize:9,color:"#64748b",lineHeight:1.5,
                overflow:expanded?"visible":"hidden",
                display:expanded?"block":"-webkit-box",
                WebkitLineClamp:expanded?undefined:2,
                WebkitBoxOrient:expanded?undefined:"vertical" as const,
              }}>{v.assessment}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══ BOARD PAGE ══════════════════════════════════════════════════════════ */
export default function BoardPage(){
  const[events,          setEvents]          = useState<Ev[]>([]);
  const[resolutions,     setResolutions]     = useState<Resolution[]>([]);
  const[officerActivity, setOfficerActivity] = useState<OfficerMap>({});
  const[hiredRoles,      setHiredRoles]      = useState<Set<string>>(new Set());
  const[agentCount,      setAgentCount]      = useState(0);
  const[lastResTs,       setLastResTs]       = useState<number|null>(null);
  const[connected,       setConnected]       = useState(false);
  const wsRef=useRef<WebSocket|null>(null);
  const resetRef=useRef<ReturnType<typeof setTimeout>|null>(null);

  const loadRes=()=>fetch(`${GW}/resolutions?limit=10`).then(r=>r.json()).then((d:Resolution[])=>{
    setResolutions(d);
    if(d.length>0)setLastResTs(new Date(d[0].created_at).getTime());
  }).catch(()=>{});

  useEffect(()=>{
    loadRes();
    fetch(`${GW}/resolutions?limit=1`).then(r=>r.json()).then((d:Resolution[])=>{
      if(!d.length)return;
      const res=d[0];
      if(Date.now()-new Date(res.created_at).getTime()>300_000)return;
      const views=res.exec_views??{};
      setOfficerActivity({
        ...Object.fromEntries(Object.entries(views).map(([role,v])=>[role,{status:"decided" as const,vote:v.vote,assessment:v.assessment,ts:res.created_at}])),
        ceo:{status:"decided",vote:res.resolution,assessment:res.directive,ts:res.created_at},
      });
    }).catch(()=>{});

    function connect(){
      const ws=new WebSocket(GWWS);wsRef.current=ws;
      ws.onopen=()=>setConnected(true);
      ws.onclose=()=>{setConnected(false);setTimeout(connect,3000);};
      ws.onerror=()=>ws.close();
      ws.onmessage=({data})=>{
        let ev:Ev;
        try{ev=JSON.parse(data);}catch{return;}
        if(!ev?.topic)return;
        const d=ev.data??{};
        if(ev.topic==="PING"||ev.topic==="HEALTH_TICK"){
          if(ev.topic==="HEALTH_TICK"){const n=(d as{agents?:number}).agents;if(typeof n==="number")setAgentCount(n);}
          return;
        }
        setEvents(p=>[ev,...p].slice(0,200));
        if(ev.topic==="AGENT_HIRED"){const r=(d as{role?:string}).role;if(r)setHiredRoles(p=>new Set([...p,r]));}
        if(ev.topic==="AGENT_FIRED"){const r=(d as{role?:string}).role;if(r)setHiredRoles(p=>{const s=new Set(p);s.delete(r);return s;});}
        if(ev.topic==="RESEARCH_COMPLETE"){
          const r=((d as Record<string,unknown>).research??{}) as Record<string,unknown>;
          const sig={direction:String((d as Record<string,unknown>).direction??""),sentiment:String(r.sentiment??""),confidence:Number(r.confidence??0)};
          setOfficerActivity(()=>Object.fromEntries(BOARD.map(role=>[role,{status:"analyzing" as const,signal:sig,ts:ev.ts}])));
        }
        if(ev.topic==="BOARD_RESOLUTION"){
          const views=((d as Record<string,unknown>).exec_views??{}) as Record<string,{assessment:string;vote:string}>;
          setOfficerActivity(()=>({
            ...Object.fromEntries(Object.entries(views).map(([role,v])=>[role,{status:"decided" as const,vote:v.vote,assessment:v.assessment,ts:ev.ts}])),
            ceo:{status:"decided",vote:String((d as Record<string,unknown>).resolution??"hold"),assessment:String((d as Record<string,unknown>).directive??""),ts:ev.ts},
          }));
          setLastResTs(Date.now());loadRes();
          if(resetRef.current)clearTimeout(resetRef.current);
          resetRef.current=setTimeout(()=>setOfficerActivity({}),295_000);
        }
      };
    }
    connect();
    return()=>{wsRef.current?.close();if(resetRef.current)clearTimeout(resetRef.current);};
  },[]);

  return(
    <div className="dot-bg" style={{minHeight:"100vh",background:"var(--bg)",padding:"24px 28px 48px"}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
        <div>
          <div style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",textTransform:"uppercase" as const,marginBottom:6}}>
            POLIS HQ › เทรด › ห้องประชุมบอร์ด
          </div>
          <div style={{fontSize:24,fontWeight:800,letterSpacing:"-0.03em",color:"#0f172a",lineHeight:1}}>
            ชั้นผู้บริหาร
          </div>
          <div style={{fontSize:11,color:"#64748b",marginTop:4}}>ผู้บริหาร AI 5 ท่าน · ประชุมทุก 5 นาที</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{padding:"5px 12px",borderRadius:8,fontSize:10,fontWeight:600,
            background:"rgba(0,0,0,0.03)",border:"1px solid rgba(0,0,0,0.06)"}}>
            <span style={{color:"#64748b"}}>Agents online: </span>
            <span style={{color:"#818cf8",fontWeight:800,fontFamily:"var(--font-mono,monospace)"}}>{agentCount}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",
            borderRadius:8,background:"rgba(0,0,0,0.03)",border:"1px solid rgba(0,0,0,0.06)"}}>
            <Dot color={connected?"#10b981":"#ef4444"} pulse={connected}/>
            <span style={{fontSize:10,color:connected?"#34d399":"#f87171",fontWeight:600}}>{connected?"Live":"Reconnecting…"}</span>
          </div>
        </div>
      </div>

      {/* Officers */}
      <SectionLabel icon="🏢" label="คณะผู้บริหาร" accent="#818cf8"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>{hiredRoles.size} / 5 online</span>}/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:0}}>
        {BOARD.map(role=>(
          <OfficerPod key={role} role={role} state={officerActivity[role]??{status:"idle"}} online={hiredRoles.has(role)}/>
        ))}
      </div>

      {/* Board room + recent events */}
      <SectionLabel icon="🏛" label="ห้องประชุมบอร์ด" accent="#6366f1"/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <BoardRoom resolutions={resolutions} lastResTs={lastResTs}/>
        <Card>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:12,display:"flex",alignItems:"center",gap:7}}>
            📡 เหตุการณ์บอร์ด
            <Dot color="#10b981" pulse/>
          </div>
          <div style={{maxHeight:280,overflowY:"auto",display:"flex",flexDirection:"column",gap:2}}>
            {events.filter(e=>["BOARD_RESOLUTION","BOARD_MEETING","RESEARCH_COMPLETE","TRADE_SIGNAL","POLICY_ADJUSTED"].includes(e.topic)).slice(0,30).map((ev,i)=>{
              const colors:Record<string,string>={BOARD_RESOLUTION:"#ec4899",BOARD_MEETING:"#818cf8",RESEARCH_COMPLETE:"#8b5cf6",TRADE_SIGNAL:"#06b6d4",POLICY_ADJUSTED:"#ef4444"};
              const c=colors[ev.topic]??"#475569";
              return(
                <div key={i} style={{display:"flex",gap:7,padding:"5px 8px",borderRadius:7,background:"#f8fafc",borderLeft:`2px solid ${c}55`}}>
                  <span style={{fontSize:9,color:c,fontWeight:700,flexShrink:0,paddingTop:2,textTransform:"uppercase" as const,letterSpacing:"0.05em"}}>{ev.topic.replace(/_/g," ")}</span>
                  <span style={{fontSize:9,color:"#475569",fontFamily:"var(--font-mono,monospace)",paddingTop:2,flexShrink:0}}>{new Date(ev.ts).toLocaleTimeString()}</span>
                </div>
              );
            })}
            {events.filter(e=>["BOARD_RESOLUTION","BOARD_MEETING","RESEARCH_COMPLETE","TRADE_SIGNAL","POLICY_ADJUSTED"].includes(e.topic)).length===0&&(
              <div style={{color:"#94a3b8",textAlign:"center" as const,padding:"28px 0",fontSize:11,fontStyle:"italic"}}>Waiting for first meeting…</div>
            )}
          </div>
        </Card>
      </div>

      {/* Resolution history */}
      <SectionLabel icon="📋" label="ประวัติมติบอร์ด" accent="#10b981"
        right={<span style={{fontSize:9,color:"#94a3b8"}}>{resolutions.length} meetings</span>}/>
      <Card>
        {resolutions.length===0
          ?<div style={{color:"#94a3b8",textAlign:"center" as const,padding:"32px 0",fontStyle:"italic",fontSize:12}}>First meeting in ~5 minutes…</div>
          :resolutions.map(r=><ResolutionCard key={r.id} r={r}/>)}
      </Card>

    </div>
  );
}
