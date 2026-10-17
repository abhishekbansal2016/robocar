import {ALL_LABELS as LABELS,validatePolicy}from'./learning.js';
import {recordedLabel}from'./demonstrations.js';
const $=id=>document.getElementById(id),names={F:'Forward',L:'Left',R:'Right',S:'Stop',B:'Backward'};
async function db(){return new Promise((resolve,reject)=>{const r=indexedDB.open('robotbot-teaching',1);r.onupgradeneeded=()=>r.result.createObjectStore('tasks',{keyPath:'name'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function storeTask(task){const d=await db();try{await new Promise((resolve,reject)=>{const t=d.transaction('tasks','readwrite');t.objectStore('tasks').put(task);t.oncomplete=resolve;t.onerror=()=>reject(t.error);});}finally{d.close();}}
async function getTask(name){const d=await db();try{return await new Promise((resolve,reject)=>{const r=d.transaction('tasks').objectStore('tasks').get(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{d.close();}}
export class Teaching {
 constructor(adapter){
  this.recording=false;this.recordToken=0;this.remoteInputs=[];this.recordingJob=null;this.adapter=adapter;this.samples=[];this.trained=null;this.token=0;this.working=false;this.driving=false;this.tested=false;this.job=0;this.callbacks=new Map();
  this.worker=new Worker('./learning-worker.js',{type:'module'});
  this.worker.onmessage=({data})=>{const cb=this.callbacks.get(data.id);if(!cb)return;if(data.type==='progress'){this.message(`Epoch ${data.metrics.epoch}: training ${(data.metrics.train.accuracy*100).toFixed(0)}%, held-out capture set ${(data.metrics.validation.accuracy*100).toFixed(0)}%`);return;}this.callbacks.delete(data.id);data.ok?cb.resolve(data.result):cb.reject(Error(data.error));};
  this.worker.onerror=e=>{for(const cb of this.callbacks.values())cb.reject(Error(e.message));this.callbacks.clear();this.cancel();this.message('Learning worker failed. Reload the app.');};
  $('teach-record').onclick=()=>this.guard(()=>this.startRecording());
  $('teach-record-stop').onclick=()=>{this.recording=false;this.recordToken++;void adapter.stop('Demonstration recording stopped.');this.update();};
  $('teach-capture').onclick=()=>this.guard(()=>this.captureSet());$('teach-import-images').onchange=e=>this.guard(()=>this.importImages([...e.target.files]));
  $('teach-train').onclick=()=>this.guard(()=>this.train());$('teach-test').onclick=()=>this.guard(()=>this.run(false));$('teach-drive').onclick=()=>this.guard(()=>this.run(true));
  $('teach-cancel').onclick=()=>{this.cancel();void adapter.stop('Teaching stopped.');};
  $('teach-save').onclick=()=>this.guard(()=>this.save());$('teach-load').onclick=()=>this.guard(()=>this.load());
  $('teach-export').onclick=()=>this.guard(()=>this.export());$('teach-import-task').onchange=e=>this.guard(()=>this.importTask(e.target.files[0]));
  $('teach-clear').onclick=()=>{if(this.working||this.recording||this.recordingJob)return;this.samples=[];this.trained=null;this.tested=false;this.update();};this.update();
 }
 message(text){$('teach-status').textContent=text;}
 update(){ $('teach-record').disabled=this.recording||this.working;$('teach-record-stop').disabled=!this.recording;const counts=Object.fromEntries(LABELS.map(l=>[l,this.samples.filter(s=>s.label===l).length]));$('teach-counts').textContent=LABELS.map(l=>names[l]+': '+counts[l]).join(' · ');$('teach-model').textContent=this.trained?'Trained policy available':'No learned policy';$('teach-drive').disabled=!this.trained||!this.tested||this.working;}
 async guard(fn){if(this.recording){this.message('Stop recording before training, importing or saving.');return;}if(this.recordingJob){await this.recordingJob;}if(this.dispatching){this.message('Finish or stop the current teaching operation first.');return;}this.dispatching=true;try{await fn();}catch(e){this.message(e.message);}finally{this.dispatching=false;}}
 rpc(type,payload){const id=++this.job;return new Promise((resolve,reject)=>{this.callbacks.set(id,{resolve,reject});this.worker.postMessage({id,type,...payload});});}
 cancel({keepRecording=false}={}){if(!keepRecording){this.recording=false;this.recordToken++;}this.token++;this.driving=false;this.worker.postMessage({type:'cancel'});this.update();}
 async feature(blob){const bitmap=await createImageBitmap(blob),canvas=new OffscreenCanvas(24,18),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,24,18);bitmap.close();const rgba=ctx.getImageData(0,0,24,18).data,x=new Float32Array(24*18*3);for(let i=0;i<24*18;i++)for(let c=0;c<3;c++)x[i*3+c]=rgba[i*4+c]/127.5-1;return x;}
 noteRemote(command,at=performance.now()/1000){if(!this.recording)return;const last=this.remoteInputs.at(-1);if(last?.command!==command)this.remoteInputs.push({at,command});}
 async startRecording(){
  if(this.working||this.recording)return;
  await this.adapter.beginRecording();this.recording=true;this.recordingError=null;const token=++this.recordToken,group=crypto.randomUUID();this.remoteInputs=[];this.noteRemote('S');this.trained=null;this.tested=false;this.update();
  this.message('RECORDING: drive with the remote buttons or arrow/WASD keys. Release records Stop. End recording before training.');
  this.recordingJob=this.recordLoop(token,group).catch(e=>{this.recordingError=e.message;this.message('Recording stopped: '+e.message);this.recording=false;this.recordToken++;void this.adapter.stop('Recording camera error.');}).finally(async()=>{try{if(this.samples.length&&$('teach-name').value.trim()){await storeTask(this.task());this.message((this.recordingError?'Recording stopped: '+this.recordingError+'. ':'Recording finished. ')+'Examples saved on this device. Collect another independent run before training.');}}catch(e){this.message('Could not auto-save examples: '+e.message+'; export them before closing.');}this.recordingJob=null;this.update();});
 }
 async recordLoop(token,group){
  let kept=0,skipped=0,stoppedFrames=0;
  while(this.recording&&token===this.recordToken){
   if(this.samples.length>=600){this.recording=false;await this.adapter.stop('Dataset full: 600 images.');this.message('Dataset full. Export/save or clear before collecting more.');return;}
   const frame=await this.adapter.capture();if(!this.recording||token!==this.recordToken)return;
   // Wait out the uncertainty/transition bracket; a later input must not relabel this image.
   const delay=Math.max(0,(frame.capturedAt+(frame.clockUncertainty||0)+.045-performance.now()/1000)*1000);if(delay)await new Promise(r=>setTimeout(r,delay));
   if(!this.recording||token!==this.recordToken)return;
   const label=recordedLabel(frame.capturedAt,frame.clockUncertainty||0,this.remoteInputs,this.adapter.motorEvents(),performance.now()/1000);
   // Keep stop examples, but limit idle flooding to roughly one image per second.
   const use=label&&(label!=='S'||frame.capturedAt-stoppedFrames>=1);
   if(use){const x=await this.feature(frame.blob);if(!this.recording||token!==this.recordToken)return;this.samples.push({x,label,group,capturedAt:frame.capturedAt,capturedUnix:frame.capturedUnix,source:'remote-demonstration',clockUncertainty:frame.clockUncertainty||0});if(label==='S')stoppedFrames=frame.capturedAt;kept++;this.adapter.show(frame,label);this.update();}else skipped++;
   this.message(`RECORDING · ${kept} labelled frames · ${skipped} transitions/idle frames skipped · ${label?names[label]:'uncertain transition'}. Use remote controls; Stop recording ends this run.`);
   await new Promise(r=>setTimeout(r,150));
  }
 }
 async captureSet(){
  if(this.working)return;await this.adapter.begin();this.working=true;const token=++this.token,group=crypto.randomUUID(),label=$('teach-label').value;
  try{for(let i=0;i<8&&token===this.token;i++){if(this.samples.length>=600)throw Error('Maximum 600 images. Export or clear this task.');this.message(`Capturing ${names[label]} ${i+1}/8. Reposition between sets to add variety.`);const frame=await this.adapter.capture();if(token!==this.token)break;const x=await this.feature(frame.blob);this.samples.push({x,label,group,capturedAt:frame.capturedAt});this.adapter.show(frame);this.trained=null;this.tested=false;this.update();}}
  finally{this.working=false;await this.adapter.end();this.update();}
 }
 async importImages(files){if(this.working||!files.length)return;const group=crypto.randomUUID(),label=$('teach-label').value;for(const file of files.slice(0,200)){if(this.samples.length>=600)throw Error('Maximum 600 examples. Clear or export the task before adding more.');this.samples.push({x:await this.feature(file),label,group});}this.trained=null;this.tested=false;this.update();this.message('Examples imported. Use a second, independently captured set per action for validation.');}
 async train(){if(this.working)return;await this.adapter.begin(false);this.working=true;this.update();
  try{const result=await this.rpc('train',{samples:this.samples,epochs:60});this.trained=result;this.tested=false;this.message(`Training complete. Held-out set accuracy ${(result.metrics.selectedValidationAccuracy*100).toFixed(0)}%. Test predictions before driving. This is not a clearance or reliability guarantee.`);}
  finally{this.working=false;await this.adapter.end();this.update();}
 }
 async run(drive){
  if(this.working||!this.trained)throw Error('Train or load a policy first.');if(drive&&!this.tested)throw Error('Run Test predictions first.');
  await this.adapter.begin();this.working=true;this.driving=drive;this.update();const token=++this.token;let previous=null,consistent=0,testCount=0;
  try{
   const started=performance.now();while(token===this.token&&performance.now()-started<30000){
    const frame=await this.adapter.capture();if(token!==this.token)break;
    const x=await this.feature(frame.blob),p=await this.rpc('predict',{policy:this.trained.policy,x});if(token!==this.token)break;
    this.adapter.show(frame);const age=performance.now()/1000-frame.capturedAt+(frame.clockUncertainty||0);
    consistent=p.command===previous?consistent+1:1;previous=p.command;testCount++;
    const confident=p.confidence>=.8&&age<=1;
    this.message(`${drive?'Learned drive':'TEST ONLY — motors stopped'}: ${names[p.command]} ${(p.confidence*100).toFixed(0)}% · photo age ${age.toFixed(2)}s${!confident?' · uncertain/stale: STOP':''}`);
    if(!drive){this.tested=testCount>=3;}
    else if(confident&&consistent>=2&&p.command!=='S')await this.adapter.pulse(p.command,token,()=>token===this.token);
    else await this.adapter.halt();
    if(!drive&&testCount>=8)break;
   }
  }finally{this.driving=false;this.working=false;await this.adapter.end();this.update();}
 }
 task(){const name=$('teach-name').value.trim();if(!name)throw Error('Name your task first.');return {format:'robotbot-image-policy-v1',name,samples:this.samples.map(s=>({...s,x:Array.from(s.x)})),trained:this.trained};}
 async save(){if(this.working)return;const task=this.task();await storeTask(task);this.message('Saved on this device: '+task.name);}
 restore(task){if(task?.format!=='robotbot-image-policy-v1'||!Array.isArray(task.samples)||task.samples.length>600)throw Error('Invalid task file.');for(const s of task.samples)if(!LABELS.includes(s.label)||!s.group||!Array.isArray(s.x)||s.x.length!==1296||!s.x.every(v=>Number.isFinite(v)&&Math.abs(v)<=1))throw Error('Invalid image examples.');if(task.trained)validatePolicy(task.trained.policy);this.samples=task.samples.map(s=>({...s,x:Float32Array.from(s.x)}));this.trained=task.trained;this.tested=false;$('teach-name').value=task.name;this.update();}
 async load(){if(this.working)return;const task=await getTask($('teach-name').value.trim());if(!task)throw Error('No saved task with that name.');this.restore(task);this.message('Task loaded. Test predictions before driving.');}
 export(){const blob=new Blob([JSON.stringify(this.task())],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='robotbot-learned-task.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
 async importTask(file){if(this.working||!file)return;if(file.size>25*1024*1024)throw Error('Task file is too large.');this.restore(JSON.parse(await file.text()));this.message('Task imported. Test predictions before driving.');}
}
