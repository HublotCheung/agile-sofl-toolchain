import { traceMetrics } from './traceAdvanced'
export interface TraceEvaluationCase {
  name:string
  requirements:Array<{id:string;title:string;content:string;vector?:number[]}>
  processes:Array<{id:string;title:string;content:string;vector?:number[]}>
  expected:Array<{source:string;target:string}>
  predicted?:Array<{source:string;target:string}>
}
export function evaluateTraceCases(cases:TraceEvaluationCase[],method:'supplied'|'name'|'vsm'|'embeddings',threshold=.5){
  if(!Array.isArray(cases)||!cases.length||!Number.isFinite(threshold))throw new Error('Provide labeled evaluation cases and a finite threshold.')
  const rows=cases.map(c=>{
    const sourceIds=new Set(c.requirements.map(r=>r.id)),targetIds=new Set(c.processes.map(p=>p.id))
    if(sourceIds.size!==c.requirements.length||targetIds.size!==c.processes.length)throw new Error('Duplicate evaluation IDs.')
    for(const l of [...c.expected,...(c.predicted??[])])if(!sourceIds.has(l.source)||!targetIds.has(l.target))throw new Error('Unknown endpoint in labeled data.')
    const tokens=(s:string)=>s.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[]
    const all=[...c.requirements,...c.processes],vocabulary=[...new Set(all.flatMap(e=>tokens(e.content)))]
    const vector=(s:string)=>{const words=tokens(s);return vocabulary.map(w=>words.filter(v=>v===w).length)}
    const cosine=(a:number[],b:number[])=>{
      if(a.length!==b.length||!a.length||[...a,...b].some(n=>!Number.isFinite(n)))throw new Error('Embedding vectors must be finite and have the same dimension.')
      const den=Math.sqrt(a.reduce((s,v)=>s+v*v,0)*b.reduce((s,v)=>s+v*v,0))
      return den?a.reduce((s,v,i)=>s+v*b[i]!,0)/den:0
    }
    let actual=c.predicted??[]
    if(method!=='supplied'){
      actual=[]
      for(const r of c.requirements){
        const scores=c.processes.map(p=>({target:p.id,score:method==='name'?(r.title.toLowerCase()===p.title.toLowerCase()?1:0):method==='vsm'?cosine(vector(r.content),vector(p.content)):cosine(r.vector??[],p.vector??[])}))
        // Paper comparison baselines select the highest score above a threshold.
        scores.sort((a,b)=>b.score-a.score)
        if(scores[0]&&scores[0].score>=threshold)actual.push({source:r.id,target:scores[0].target})
      }
    }
    return {name:c.name,requirements:c.requirements.length,processes:c.processes.length,expected:c.expected.length,predicted:actual.length,...traceMetrics(c.expected,actual)}
  })
  const tp=rows.reduce((s,r)=>s+r.tp,0),fp=rows.reduce((s,r)=>s+r.fp,0),fn=rows.reduce((s,r)=>s+r.fn,0)
  const precision=tp+fp?tp/(tp+fp):tp+fn?0:1,recall=tp+fn?tp/(tp+fn):1
  return {method,threshold,projects:rows,micro:{tp,fp,fn,precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0},macro:{precision:rows.reduce((s,r)=>s+r.precision,0)/rows.length,recall:rows.reduce((s,r)=>s+r.recall,0)/rows.length,f1:rows.reduce((s,r)=>s+r.f1,0)/rows.length}}
}
