// Tiny supervised image policy. All training/inference runs locally; no YOLO weights are changed.
export const LABELS=['F','L','R','S'];
export const ALL_LABELS=[...LABELS,'B'];
export const INPUT=24*18*3,HIDDEN=24;
export function rng(seed=12345){return()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};}
export function createPolicy(seed=1,labels=LABELS){const outputs=labels.length;const random=rng(seed),w1=Float32Array.from({length:INPUT*HIDDEN},()=> (random()*2-1)*Math.sqrt(6/(INPUT+HIDDEN))),w2=Float32Array.from({length:HIDDEN*outputs},()=> (random()*2-1)*Math.sqrt(6/(HIDDEN+outputs)));return {version:1,width:24,height:18,labels:labels.slice(),w1:Array.from(w1),b1:Array(HIDDEN).fill(0),w2:Array.from(w2),b2:Array(outputs).fill(0)};}
export function validatePolicy(p){
 if(p.version!==1||p.width!==24||p.height!==18||![JSON.stringify(LABELS),JSON.stringify(ALL_LABELS)].includes(JSON.stringify(p.labels)))throw Error('Unsupported learned policy.');
 for(const [name,size]of [['w1',INPUT*HIDDEN],['b1',HIDDEN],['w2',HIDDEN*p.labels.length],['b2',p.labels.length]])if(!Array.isArray(p[name])||p[name].length!==size||!p[name].every(Number.isFinite))throw Error('Invalid learned weights: '+name);
 return p;
}
function forward(p,x){const outputs=p.labels.length;
 const h=new Float32Array(HIDDEN),logits=new Float32Array(outputs);
 for(let j=0;j<HIDDEN;j++){let v=p.b1[j];for(let i=0;i<INPUT;i++)v+=x[i]*p.w1[i*HIDDEN+j];h[j]=Math.max(0,v);}
 let max=-Infinity;for(let k=0;k<outputs;k++){let v=p.b2[k];for(let j=0;j<HIDDEN;j++)v+=h[j]*p.w2[j*outputs+k];logits[k]=v;max=Math.max(max,v);}
 let sum=0;for(let k=0;k<outputs;k++){logits[k]=Math.exp(logits[k]-max);sum+=logits[k];}for(let k=0;k<outputs;k++)logits[k]/=sum;
 return {h,prob:logits};
}
export function predict(p,x){const outputs=p.labels.length;const {prob}=forward(p,x);let best=0;for(let k=1;k<outputs;k++)if(prob[k]>prob[best])best=k;return {command:p.labels[best],confidence:prob[best],scores:Object.fromEntries(p.labels.map((l,i)=>[l,prob[i]]))};}
export function splitGroups(samples,labels=samples.some(s=>s.label==='B')?ALL_LABELS:LABELS){
 const train=[],validation=[];
 for(const label of labels){
  const subset=samples.filter(s=>s.label===label),groups=[...new Set(subset.map(s=>s.group))];
  if(subset.length<8||groups.length<2)throw Error(`Collect at least 8 images in two separate capture/import sets for ${label}.`);
  const holdout=groups.at(-1);for(const s of subset)(s.group===holdout?validation:train).push(s);
 }
 return {train,validation};
}
export async function trainPolicy(samples,{epochs=60,onEpoch=()=>{},cancelled=()=>false,seed=7}={}){
 const labels=samples.some(s=>s.label==='B')?ALL_LABELS:LABELS,outputs=labels.length;
 const {train,validation}=splitGroups(samples,labels),p=createPolicy(seed,labels),random=rng(seed);
 const keys=['w1','b1','w2','b2'],m={},v={};for(const k of keys){m[k]=new Float32Array(p[k].length);v[k]=new Float32Array(p[k].length);}
 const counts=Object.fromEntries(labels.map(l=>[l,train.filter(s=>s.label===l).length]));
 let bestLoss=Infinity,best=null,stale=0,step=0,lastMetrics=null;
 for(let epoch=1;epoch<=epochs;epoch++){
  const order=train.slice();for(let i=order.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  for(let at=0;at<order.length;at+=16){
   if(cancelled())throw Error('Training cancelled.');
   const grad=Object.fromEntries(keys.map(k=>[k,new Float32Array(p[k].length)])),batch=order.slice(at,at+16);
   for(const s of batch){
    const {h,prob}=forward(p,s.x),target=labels.indexOf(s.label),weight=train.length/(outputs*counts[s.label]),d=Array.from(prob,(value,k)=>(value-(k===target?1:0))*weight),dh=new Float32Array(HIDDEN);
    for(let k=0;k<outputs;k++){grad.b2[k]+=d[k];for(let j=0;j<HIDDEN;j++){grad.w2[j*outputs+k]+=h[j]*d[k];dh[j]+=p.w2[j*outputs+k]*d[k];}}
    for(let j=0;j<HIDDEN;j++)if(h[j]>0){grad.b1[j]+=dh[j];for(let i=0;i<INPUT;i++)grad.w1[i*HIDDEN+j]+=s.x[i]*dh[j];}
   }
   step++;const c1=1-Math.pow(.9,step),c2=1-Math.pow(.999,step);
   for(const k of keys)for(let i=0;i<p[k].length;i++){const g=Math.max(-5,Math.min(5,grad[k][i]/batch.length))+(k.startsWith('w')?.0001*p[k][i]:0);m[k][i]=.9*m[k][i]+.1*g;v[k][i]=.999*v[k][i]+.001*g*g;p[k][i]-=.001*(m[k][i]/c1)/(Math.sqrt(v[k][i]/c2)+1e-8);}
   // Yield in the worker so cancellation messages can be processed.
   await new Promise(r=>setTimeout(r,0));
  }
  function metrics(items){let hits=0,loss=0;const confusion=Array.from({length:outputs},()=>Array(outputs).fill(0));for(const s of items){const result=predict(p,s.x),y=labels.indexOf(s.label),guess=labels.indexOf(result.command);hits+=guess===y?1:0;loss-=Math.log(Math.max(1e-8,result.scores[s.label]));confusion[y][guess]++;}return {accuracy:hits/items.length,loss:loss/items.length,confusion};}
  const t=metrics(train),val=metrics(validation);lastMetrics={epoch,train:t,validation:val,trainCount:train.length,validationCount:validation.length};onEpoch(lastMetrics);
  if(val.loss<bestLoss-1e-5){bestLoss=val.loss;best=JSON.parse(JSON.stringify(p));stale=0;}else if(++stale>=12)break;
 }
 const selected=best||p;let hits=0;for(const s of validation)if(predict(selected,s.x).command===s.label)hits++;
 return {policy:selected,metrics:{...lastMetrics,selectedValidationAccuracy:hits/validation.length},trainedAt:Date.now()};
}
