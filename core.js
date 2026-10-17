// Pure logic shared by the controller and deterministic tests. Seconds use performance.now()/1000.
export const CLASSES = ['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'];
export const UNKNOWN = 'Sorry, I can understand only these commands right now: What do you see? Find or go to an object.';
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const position = x => x < .4 ? 'LEFT' : x > .6 ? 'RIGHT' : 'CENTER';
export function clean(text) { return text.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
export function similarity(a,b) {
  if (!a.length || !b.length) return a === b ? 1 : 0;
  let row = Array.from({length:b.length+1},(_,i)=>i);
  for (let i=1;i<=a.length;i++) {
    const next=[i]; for (let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1)); row=next;
  }
  return 1-row[b.length]/Math.max(a.length,b.length);
}
const aliases = {'ball':'sports ball','balls':'sports ball','sofa':'couch','television':'tv','phone':'cell phone','mobile phone':'cell phone','plant':'potted plant','table':'dining table','water bottle':'bottle','notebook computer':'laptop','bottles':'bottle','chairs':'chair'};
export function canonicalTarget(raw, names=CLASSES) {
  const text=clean(raw); const alias=aliases[text] || text;
  if (names.includes(alias)) return alias;
  const scores=names.map(n=>[similarity(alias,n),n]).sort((a,b)=>b[0]-a[0]);
  return scores[0]?.[0]>=.8 && scores[0][0]-(scores[1]?.[0]||0)>=.1 ? scores[0][1] : null;
}
export function parseCommand(raw, names=CLASSES) {
  const text=clean(raw);
  if (['stop','halt','cancel'].includes(text)) return {action:'stop'};
  if (['what do you see','what can you see','what you see'].some(p=>similarity(text,p)>=.80)) return {action:'describe'};
  const match=text.match(/^(?:find|fine|fined|go to|go too|go two|goto)\s+(?:the\s+|a\s+|an\s+)?(.+)$/);
  if (!match) return {action:'unknown'};
  const target=canonicalTarget(match[1],names);
  return target ? {action:'approach',target} : {action:'unsupported',raw:match[1]};
}
export function iou(a,b) {
  const inter=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  return inter/Math.max(1,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter);
}
export function nms(objects, threshold=.45) {
  const kept=[];
  for (const o of [...objects].sort((a,b)=>b.confidence-a.confidence)) if (!kept.some(k=>k.name===o.name&&iou(k.box,o.box)>threshold)) kept.push(o);
  return kept.slice(0,100);
}
export function letterbox(width,height,size) {
  const scale=Math.min(size/width,size/height), w=Math.round(width*scale), h=Math.round(height*scale);
  return {scale,w,h,padX:Math.floor((size-w)/2),padY:Math.floor((size-h)/2),width,height};
}
export function decodeOutput(data, dims, meta, transform, threshold=.3) {
  if (dims.length!==3 || dims[0]!==1) throw Error(`Unsupported detection shape ${dims}. Export a detection-only model.`);
  const names=meta.names, count=names.length, objects=[];
  const add=(x1,y1,x2,y2,confidence,cls)=>{
    if (!Number.isFinite(confidence)||confidence<threshold||!Number.isInteger(cls)||cls<0||cls>=count) return;
    const box=[clamp((x1-transform.padX)/transform.scale,0,transform.width),clamp((y1-transform.padY)/transform.scale,0,transform.height),clamp((x2-transform.padX)/transform.scale,0,transform.width),clamp((y2-transform.padY)/transform.scale,0,transform.height)];
    if (!box.every(Number.isFinite)||box[2]<=box[0]||box[3]<=box[1]) return;
    const x=(box[0]+box[2])/(2*transform.width), y=(box[1]+box[3])/(2*transform.height);
    objects.push({name:names[cls],confidence,box,x,y,location:position(x),width:transform.width,height:transform.height});
  };
  if (meta.layout==='end2end') {
    if (dims[2]!==6) throw Error(`Expected [1,N,6], got ${dims}`);
    for(let i=0;i<dims[1];i++) {const k=i*6; add(data[k],data[k+1],data[k+2],data[k+3],data[k+4],Number(data[k+5]));}
    return objects.sort((a,b)=>b.confidence-a.confidence).slice(0,100);
  }
  const transposed=dims[1]===count+4;
  if (!transposed&&dims[2]!==count+4) throw Error(`Expected ${count+4} channels, got ${dims}`);
  const n=transposed?dims[2]:dims[1], at=(i,c)=>data[transposed?c*n+i:i*(count+4)+c];
  for(let i=0;i<n;i++) {
    let cls=0, conf=-Infinity; for(let c=0;c<count;c++) if(at(i,4+c)>conf){conf=at(i,4+c);cls=c;}
    if(conf<threshold)continue;
    const x=at(i,0),y=at(i,1),w=at(i,2),h=at(i,3); add(x-w/2,y-h/2,x+w/2,y+h/2,conf,cls);
  }
  return nms(objects);
}
export class DetectionWindow {
  constructor(names=CLASSES,size=2){this.names=names;this.size=size;this.frames=[];}
  add(objects,at){
    this.frames.push({objects,at});if(this.frames.length>this.size)this.frames.shift();
    const tracks=[],scores=Object.fromEntries(this.names.map(n=>[n,0])),n=this.frames.length;
    this.frames.forEach((frame,index)=>{
      const used=new Set(),perClass={};
      for(const o of [...frame.objects].sort((a,b)=>b.confidence-a.confidence)){
        perClass[o.name]=Math.max(perClass[o.name]||0,o.confidence);
        let best=null,overlap=.25;
        for(const t of tracks)if(!used.has(t)&&t.obj.name===o.name&&iou(t.obj.box,o.box)>=overlap){best=t;overlap=iou(t.obj.box,o.box);}
        if(!best){best={sum:0,hits:0};tracks.push(best);}
        Object.assign(best,{obj:o,at:frame.at,index,sum:best.sum+o.confidence,hits:best.hits+1});used.add(best);
      }
      for(const [name,score]of Object.entries(perClass))scores[name]=(scores[name]||0)+score/n;
    });
    return {scores,count:n,objects:tracks.map(t=>({...t.obj,rawConfidence:t.obj.confidence,confidence:t.sum/n,hits:t.hits,samples:n,lastSeen:t.at,presentLatest:t.index===n-1}))};
  }
}
export class MotionHistory {
  constructor(turn360=6){this.turn360=turn360;this.events=[];}
  add(at,command,lease=.3){this.events.push({at,command,lease});if(this.events.length>10000)this.events.shift();}
  since(start,end){let yaw=0,forward=0;
    this.events.forEach((e,i)=>{const until=Math.min(end,e.at+e.lease,this.events[i+1]?.at??end),dt=Math.max(0,until-Math.max(start,e.at));
      if(e.command==='R'||e.command==='L')yaw+=dt*360/this.turn360*(e.command==='R'?1:-1);
      if(e.command==='F')forward+=dt;
    });return {yaw,forward};
  }
  project(obj,now,hfov=60){const {yaw,forward}=this.since(obj.lastSeen,now),f=1/(2*Math.tan(hfov*Math.PI/360)),a=Math.atan((obj.x-.5)/f)-yaw*Math.PI/180;
    return {...obj,x:Math.abs(a)<Math.PI/2?.5+f*Math.tan(a):(a<0?-1:2),yaw,forward};}
}
export const boxArea=o=>Math.max(0,o.box[2]-o.box[0])*Math.max(0,o.box[3]-o.box[1])/(o.width*o.height);
export function pickTarget(target,objects,previous){
  let matches=objects.filter(o=>o.name===target&&o.confidence>0&&o.hits>=1);
  if(previous)matches=matches.filter(o=>Math.abs(o.x-previous.x)<=.22&&Math.abs(o.y-previous.y)<=.18&&Math.max(.001,boxArea(o))/Math.max(.001,boxArea(previous))>=.25&&boxArea(o)/Math.max(.001,boxArea(previous))<=4);
  return matches.sort((a,b)=>previous?(Math.abs(a.x-previous.x)+Math.abs(a.y-previous.y))-(Math.abs(b.x-previous.x)+Math.abs(b.y-previous.y)):b.confidence-a.confidence)[0]||null;
}
export class Navigator {
  constructor(target,config,history,start){
    Object.assign(this,{target,config,history,start,lastSequence:0,previous:null,centred:0,approached:false,turnUntil:0,searchDegrees:0,growth:0,areaObservation:null,missing:0});
    this.lastFresh=start;
  }
  step(packet,now,uncertainty=0){
    const stop=message=>({command:'S',done:true,message});
    if(now-this.start>240)return stop('Navigation time limit reached. Stopped.');
    const forward=this.history.since(this.start,now).forward;
    if(forward>=30)return stop('Forward movement limit reached. Stopped.');
    if(!packet||now-packet.capturedAt+uncertainty>this.config.maxAge){
      if(now-this.lastFresh>15)return stop('No fresh camera predictions arrived. Stopped.');
      return {command:'S',message:'Waiting for a fresh prediction…'};
    }
    this.lastFresh=now;
    if(now<this.turnUntil)return {command:'S',holdTurn:true,message:'Turning; capturing in the background…'};
    if(packet.sequence===this.lastSequence){
      if(this.approached&&this.previous&&this.centred>=2){
        const p=this.history.project(this.previous,now,this.config.hfov);
        if(now-p.lastSeen+uncertainty>this.config.maxAge)return {command:'S',message:'Waiting for a fresh target observation…'};
        if(p.x<.4||p.x>.6)return {command:'S',message:'Checking alignment…'};
        if(boxArea(p)*Math.exp(Math.min(4,this.growth*(now-p.lastSeen)))>=this.config.stopArea)return stop('Estimated target box reached the size limit. Stopped.');
        return {command:'F',message:`Approaching ${this.target}…`};
      }
      return {command:'S'};
    }
    this.lastSequence=packet.sequence;
    const objects=packet.objects.filter(o=>now-o.lastSeen+uncertainty<=this.config.maxAge).map(o=>this.history.project(o,now,this.config.hfov));
    const prev=this.previous?this.history.project(this.previous,now,this.config.hfov):null;
    const obj=pickTarget(this.target,objects,prev);
    if(!obj){
      this.centred=0;
      if(this.approached)return stop(`I lost the ${this.target} during approach. Stopped.`);
      if(this.previous){if(++this.missing>=3)return stop(`The ${this.target} disappeared or changed label. Stopped.`);return {command:'S',message:'Target identity uncertain; checking again…'};}
      if(this.searchDegrees>=720)return stop(`I could not find the ${this.target}. Stopped.`);
      this.searchDegrees+=10;const duration=this.config.turn360*10/360;this.turnUntil=now+duration+.12;
      return {command:'R',duration,degrees:10,message:`Searching for ${this.target}: 10° estimated turn`};
    }
    this.missing=0;
    // Retain unprojected coordinates. Raw YOLO labels are never renamed to fit a request.
    this.previous=packet.objects.find(o=>o.name===obj.name&&o.lastSeen===obj.lastSeen&&o.box===obj.box)||{...obj,x:obj.x};
    if(obj.x<.4||obj.x>.6){
      this.centred=0;const duration=this.config.turn360*3/360;this.turnUntil=now+duration+.12;
      return {command:obj.x<.4?'L':'R',duration,degrees:3,message:`Centring ${this.target}: 3° estimated turn`,projection:obj};
    }
    this.centred++;
    const area=boxArea(obj),old=this.areaObservation;
    if(old&&obj.lastSeen>old.at&&this.history.since(old.at,obj.lastSeen).forward>0)
      this.growth=clamp(Math.log(Math.max(.001,area)/Math.max(.001,old.area))/(obj.lastSeen-old.at),0,2);
    this.areaObservation={at:obj.lastSeen,area};
    if(area*Math.exp(Math.min(4,this.growth*(now-obj.lastSeen)))>=this.config.stopArea)return stop(`The ${this.target} box reached the size limit. Stopped.`);
    if(this.centred>=2&&packet.count>=2){this.approached=true;return {command:'F',message:`Approaching ${this.target}…`,projection:obj};}
    return {command:'S',message:'Confirming target is centred…',projection:obj};
  }
}
