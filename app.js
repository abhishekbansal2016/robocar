import {CLASSES,UNKNOWN,parseCommand,DetectionWindow,Navigator,boxArea} from './core.js';
import {RobotClient,now} from './robot.js';
import {OfflineVoice} from './voice.js';
import {Teaching} from './teaching.js';
import {APP_CACHE,activeModelCache,installBundle,cacheApp} from './setup.js';
const $=id=>document.getElementById(id);
let MODEL_CACHE=activeModelCache(),settingUp=false;
let robot=null,worker=null,workerId=0,modelReady=false,busy=false,generation=0,navigatorState=null,latest=null,windowVotes=null;
let motorBusy=false,lastCommand='S',lastSent=0,wakeLock=null,voice=null,isDemo=false,meta=JSON.parse(localStorage.getItem('robotbot-meta')||'null')||{names:CLASSES,size:640,layout:'raw',model:'YOLO26m'};
let teaching=null;
let manualCommand=null,manualReady=false,manualToken=0,manualSource=null;
const pending=new Map(),photos=[],records=[];let photoCounter=0;
function log(text){$('log').textContent=`${new Date().toLocaleTimeString()} ${text}\n`+$('log').textContent.slice(0,16000);}
function status(text){$('status').textContent=text;}
function reply(text){$('reply').textContent=text;log(text);if($('tts').checked&&'speechSynthesis'in window){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);const local=speechSynthesis.getVoices().find(v=>v.localService&&v.lang.startsWith('en'));if(local){u.voice=local;speechSynthesis.speak(u);}else log('No local English TTS voice installed; reply shown as text.');}}
function setBusy(value){busy=value;$('mode').textContent=value?'Working':'Idle';$('connect').disabled=value;$('load').disabled=value;$('model-file').disabled=value;$('metadata').disabled=value;$('provider').disabled=value;}
function configuration(){
  const c={turn360:+$('turn360').value,hfov:+$('hfov').value,stopArea:+$('stop-area').value/100,maxAge:+$('max-age').value,forwardPWM:+$('forward-pwm').value,turnPWM:+$('turn-pwm').value};
  if(!Number.isFinite(c.turn360)||c.turn360<1||c.turn360>9||c.hfov<20||c.hfov>140||c.stopArea<.1||c.stopArea>.95||c.maxAge<.5||c.maxAge>5||![c.forwardPWM,c.turnPWM].every(n=>Number.isInteger(n)&&n>=1&&n<=255))throw Error('Invalid movement settings. Check the limits beside each field.');
  return c;
}
async function storage(){const result=await navigator.storage?.persist?.();log(result?'Persistent storage granted.':'Storage persistence not granted. Keep a backup of your model files.');}
async function saved(key){return (await caches.open(MODEL_CACHE)).match(new URL('./stored/'+key,location.href).href);}
async function saveFile(key,file){const cache=await caches.open(MODEL_CACHE);await cache.put(new URL('./stored/'+key,location.href).href,new Response(file,{headers:{'Content-Type':key.endsWith('.json')?'application/json':'application/octet-stream'}}));}
function setupWorker(){
  if(worker)return;
  worker=new Worker('./inference-worker.js',{type:'module'});
  worker.onmessage=({data})=>{if(data.type==='notice'){log(data.message);return;}const callback=pending.get(data.id);if(!callback)return;clearTimeout(callback.timer);pending.delete(data.id);data.ok?callback.resolve(data):callback.reject(Error(data.error));};
  worker.onerror=e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(e.message||'Inference worker failed'));}pending.clear();worker?.terminate();worker=null;modelReady=false;void stopAll('Inference worker failed. Stopped.');};
}
function inferCall(type,payload={},transfer=[],timeout=90000){setupWorker();const id=++workerId;return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('Inference timed out. Reload the saved model.'));worker?.terminate();worker=null;modelReady=false;},timeout);
  pending.set(id,{resolve,reject,timer});worker.postMessage({id,type,...payload},transfer);
});}
async function loadModel(){
  if(busy||teaching?.working||teaching?.recording)return false;setBusy(true);status('Loading and warming up your saved YOLO model…');
  try{
    const file=await saved('model.onnx');if(!file)throw Error('Import model.json and the exported .onnx model first.');
    // Reloading constructs a fresh worker, including a clean GPU->WASM fallback.
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Model reload cancelled the previous inference.'));}pending.clear();
    worker?.terminate();worker=null;modelReady=false;
    const buffer=await file.arrayBuffer(),result=await inferCall('load',{buffer,meta,provider:$('provider').value},[buffer]);modelReady=true;
    $('runtime').textContent=`${meta.model||'YOLO'} · ${result.provider} · ${meta.size}px`;status('YOLO ready. Connect to RobotBot, then give a command.');log('Model warm-up passed on '+result.provider);return true;
  }catch(e){status(e.message);log(e.message);return false;}finally{setBusy(false);}
}
async function stopAll(message='Stopped. Give your next command.',{keepRecording=false}={}){
  teaching?.noteRemote('S',now());teaching?.cancel({keepRecording});
  manualCommand=null;manualReady=false;manualSource=null;manualToken++;
  document.querySelectorAll('[data-drive]').forEach(b=>b.classList.remove('held'));
  generation++;navigatorState=null;latest=null;lastCommand='S';setBusy(false);
  // STOP is deliberately allowed to overtake an older HTTP command. Firmware sequence numbers enforce ordering.
  try{await robot?.stop();}catch(e){log(e.message);}
  if(wakeLock){await wakeLock.release().catch(()=>{});wakeLock=null;}
  if(message){status(message);reply(message);}
}
async function wake(){try{wakeLock=await navigator.wakeLock?.request('screen');}catch(e){log('Keep the laptop awake: '+e.message);}}
async function connect(){
  if(busy||teaching?.working||teaching?.recording)return;status('Connecting. Allow local-network access if Chrome asks…');$('connect').disabled=true;
  try{
    await robot?.stop().catch(()=>{});robot=new RobotClient($('robot-url').value,configuration().turn360);
    const frame=await robot.connect();isDemo=false;lastCommand='S';
    $('connection').textContent='RobotBot connected';status('Connected. Photos, timestamps and STOP verified.');log(`Clock uncertainty ±${robot.uncertainty.toFixed(3)}s`);
    const card=addPhoto(frame);await updatePhoto(card,[],{},0,null);
    await storage();
  }catch(e){robot?.emergency();robot=null;$('connection').textContent='Connection failed';status('Could not connect. Check RobotBot Wi-Fi, firmware and site permissions.');reply(e.message);}
  finally{$('connect').disabled=false;}
}
function addPhoto(frame){
  const photo={...frame,id:++photoCounter,objects:[],scores:{},elapsed:0,width:0,height:0};
  const article=document.createElement('article');article.className='photo';
  const canvas=document.createElement('canvas');photo.canvas=canvas;
  const body=document.createElement('div');body.className='photo-body';
  const head=document.createElement('div');head.className='photo-head';
  const title=document.createElement('strong');title.textContent=`Photo ${photo.id}`;head.append(title);
  const time=document.createElement('span');time.textContent=new Date(frame.capturedUnix*1000).toLocaleTimeString();head.append(time);body.append(head);
  photo.info=document.createElement('p');photo.info.className='hint';photo.info.textContent='Captured · awaiting prediction';body.append(photo.info);
  photo.tags=document.createElement('div');photo.tags.className='tags';body.append(photo.tags);
  photo.details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Boxes, votes & timestamps';photo.details.append(summary);photo.data=document.createElement('pre');photo.details.append(photo.data);body.append(photo.details);
  article.append(canvas,body);photo.article=article;
  $('gallery').querySelector('.empty')?.remove();$('gallery').prepend(article);photos.push(photo);
  if(photos.length>30){const old=photos.shift();old.article.remove();old.bitmap?.close();}
  void drawPhoto(photo);return photo;
}
async function drawPhoto(photo){
  if(!photo.bitmap)photo.bitmap=await createImageBitmap(photo.blob);
  const {canvas,bitmap}=photo;canvas.width=bitmap.width;canvas.height=bitmap.height;photo.width=bitmap.width;photo.height=bitmap.height;
  const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
  if(!$('boxes').checked)return;
  ctx.font=`${Math.max(10,Math.round(bitmap.width/42))}px system-ui`;ctx.lineWidth=Math.max(1,bitmap.width/240);
  for(const o of photo.objects){const [x1,y1,x2,y2]=o.box;ctx.strokeStyle='#40ffbd';ctx.strokeRect(x1,y1,x2-x1,y2-y1);const text=`${o.name} ${o.rawConfidence.toFixed(2)} / ${o.confidence.toFixed(2)}`;const y=Math.max(16,y1);ctx.fillStyle='#102f28';ctx.fillRect(x1,y-16,ctx.measureText(text).width+7,18);ctx.fillStyle='#fff';ctx.fillText(text,x1+3,y-2);}
}
async function updatePhoto(photo,objects,scores,elapsed,packet){
  photo.objects=objects;photo.scores=scores;photo.elapsed=elapsed;photo.latency=now()-photo.capturedAt;
  photo.info.textContent=`${isDemo?'SAMPLE · ':''}YOLO ${elapsed.toFixed(2)}s · prediction age ${photo.latency.toFixed(2)}s`;
  photo.tags.replaceChildren();for(const o of objects){const tag=document.createElement('span');tag.className='tag';tag.textContent=`${o.name} · ${o.location} · raw ${o.rawConfidence.toFixed(2)} / mean ${o.confidence.toFixed(2)} · ${o.hits}/${o.samples}`;photo.tags.append(tag);}
  if(!objects.length)photo.tags.textContent=packet?'No objects detected in this photo.':'Connection test photo.';
  const record={id:photo.id,sample:!!isDemo,capturedUnix:photo.capturedUnix,capturedMonotonic:photo.capturedAt,predictedMonotonic:now(),inferenceSeconds:elapsed,latencySeconds:photo.latency,clockUncertaintySeconds:robot?.uncertainty??0,objects,scores};
  photo.data.textContent=JSON.stringify(record,null,2);records.push(record);if(records.length>1000)records.shift();
  await drawPhoto(photo);
}
async function captureAndDetect(run){
  const frame=await robot.capture();if(run!==generation)return null;
  const photo=addPhoto(frame),bitmap=await createImageBitmap(frame.blob);
  const result=await inferCall('infer',{bitmap,threshold:.3},[bitmap],20000);if(run!==generation)return null;
  const evidence=windowVotes.add(result.objects,frame.capturedAt);
  const packet={...evidence,capturedAt:frame.capturedAt,sequence:photo.id};
  await updatePhoto(photo,evidence.objects.filter(o=>o.presentLatest),evidence.scores,result.elapsed,packet);
  return packet;
}
async function perceptionLoop(run){
  let failures=0;
  while(run===generation&&busy){
    try{const packet=await captureAndDetect(run);if(!packet||run!==generation)return;latest=packet;failures=0;}
    catch(e){if(run!==generation)return;latest=null;log('Vision: '+e.message);robot.emergency();if(++failures>=3){await stopAll('Camera/YOLO failed repeatedly. '+e.message);return;}}
    await new Promise(r=>setTimeout(r,150));
  }
}
async function execute(text){
  const parsed=parseCommand(text,meta.names);log('You: '+text);
  if(parsed.action==='stop'){await stopAll();return;}
  if(teaching?.recording){reply('Stop demonstration recording before running autonomous commands.');return;}
  if(teaching?.working){reply('Stop teaching and wait for the current camera/training operation to finish first.');return;}
  if(settingUp){reply('Device setup is still in progress. Wait for it to finish.');return;}
  if(busy){reply('Robot is busy. Press STOP to cancel.');return;}
  if(parsed.action==='unknown'){reply(UNKNOWN);return;}
  if(parsed.action==='unsupported'){reply(`I cannot detect “${parsed.raw}” with this model. Try a listed category such as bottle, chair or sports ball.`);return;}
  if(pending.size){reply('The previous inference is finishing. Please try again in a moment.');return;}
  if(!robot?.ready){reply('Connect to RobotBot first.');return;}
  if(!modelReady){reply('Import and load the YOLO model first.');return;}
  if(document.hidden){reply('Keep this app visible while operating the robot.');return;}
  isDemo=false;const config=configuration();robot.history.turn360=config.turn360;
  const run=++generation;setBusy(true);latest=null;windowVotes=new DetectionWindow(meta.names,2);await wake();
  try{
    await robot.stop();if(run!==generation)return;
    if(parsed.action==='describe'){
      status('Taking two photos…');for(let i=0;i<2;i++){latest=await captureAndDetect(run);if(run!==generation)return;}
      const labels=latest.objects.map(o=>`${o.name} at the ${o.location.toLowerCase()}`);
      reply(labels.length?'YOLO detects '+labels.join(', ')+'.':'No objects detected.');status('Two-photo inspection complete.');setBusy(false);await robot.stop();if(wakeLock){await wakeLock.release().catch(()=>{});wakeLock=null;}return;
    }
    navigatorState=new Navigator(parsed.target,config,robot.history,now());status('Looking for '+parsed.target+'…');reply('I am looking for the '+parsed.target+'.');
    void perceptionLoop(run);
  }catch(e){if(run===generation)await stopAll(e.message);}
}
// Manual control needs a robot connection, but no YOLO model. It cancels navigation.
async function startManual(command,source){
  if(document.hidden||settingUp||teaching?.working)return;
  if(!robot?.ready){reply('Connect to RobotBot first.');return;}
  if(busy&&!navigatorState&&!manualCommand){reply('Wait for setup or model loading to finish.');return;}
  generation++;navigatorState=null;latest=null;lastCommand='S';
  const token=++manualToken;manualCommand=command;manualReady=false;manualSource=source;teaching?.noteRemote(command,now());setBusy(true);
  document.querySelectorAll('[data-drive]').forEach(b=>b.classList.toggle('held',b.dataset.drive===command));
  try{
    await robot.stop();
    // An already in-flight autonomous request must finish before manual movement starts.
    while(motorBusy&&token===manualToken)await new Promise(r=>setTimeout(r,10));
    if(token!==manualToken)return;
    manualReady=true;lastSent=0;$('mode').textContent='Remote control';status('Remote control: '+({F:'forward',B:'backward',L:'left',R:'right'}[command])+' — release to stop');
    if(!wakeLock)await wake();
  }catch(e){if(token===manualToken)await stopAll('Remote control error: '+e.message);}
}
function releaseManual(source){if(manualCommand&&(source===undefined||source===manualSource))void stopAll('Remote control stopped.',{keepRecording:true});}
// All inference is in a dedicated worker. This timer only decides and sends commands.
setInterval(async()=>{
  if((!navigatorState&&!manualCommand)||!busy||motorBusy||document.hidden)return;
  const run=generation;motorBusy=true;
  try{
    if(manualCommand){
      if(!manualReady||now()-lastSent<.085)return;
      const token=manualToken,command=manualCommand;
      const field=(command==='L'||command==='R')?'turn-pwm':'forward-pwm';
      const speed=+$(''+field).value;
      if(!Number.isInteger(speed)||speed<1||speed>255)throw Error('PWM must be between 1 and 255.');
      await robot.send(command,0,speed);
      if(token!==manualToken){robot.emergency();return;}
      lastSent=now();return;
    }
    const decision=navigatorState.step(latest,now(),robot.uncertainty);
    if(decision.message)status(decision.message);
    if(decision.done){await stopAll(decision.message);return;}
    if(decision.holdTurn)return; // Firmware owns the turn deadline, not the browser scheduler.
    const command=decision.command||'S';
    if(command==='S'&&lastCommand==='S')return;
    if(command==='F'&&lastCommand==='F'&&now()-lastSent<.085)return;
    const speed=command==='F'?navigatorState.config.forwardPWM:navigatorState.config.turnPWM;
    const result=await robot.send(command,decision.duration||0,speed);
    if(run!==generation){robot.emergency();return;}
    lastCommand=decision.duration?'S':command;lastSent=now();
    if(decision.duration)navigatorState.turnUntil=Math.max(navigatorState.turnUntil,result.applied+decision.duration+.12);
  }catch(e){if(run===generation)await stopAll('Motor/control error: '+e.message);}
  finally{motorBusy=false;}
},30);
$('command-form').addEventListener('submit',e=>{e.preventDefault();void execute($('command').value).catch(e=>stopAll(e.message));});
for(const b of document.querySelectorAll('[data-command]'))b.onclick=()=>{ $('command').value=b.dataset.command;void execute(b.dataset.command).catch(e=>stopAll(e.message));};
$('stop').onclick=()=>{globalThis.speechSynthesis?.cancel();void stopAll();};$('connect').onclick=connect;$('load').onclick=loadModel;
for(const button of document.querySelectorAll('[data-drive]')){
  button.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;event.preventDefault();
    button.setPointerCapture(event.pointerId);
    void startManual(button.dataset.drive,'pointer:'+event.pointerId);
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,event=>releaseManual('pointer:'+event.pointerId));
  button.addEventListener('contextmenu',event=>event.preventDefault());
}
const driveKeys={ArrowUp:'F',ArrowDown:'B',ArrowLeft:'L',ArrowRight:'R',w:'F',s:'B',a:'L',d:'R'};
window.addEventListener('keydown',event=>{
  if(event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
  const command=driveKeys[event.key]||driveKeys[event.key.toLowerCase()];
  if(!command)return;event.preventDefault();if(event.repeat)return;
  void startManual(command,'key:'+event.code);
});
window.addEventListener('keyup',event=>releaseManual('key:'+event.code));
window.addEventListener('blur',()=>{if(teaching?.recording){void stopAll('Recording stopped: app lost focus.');return;}if(manualCommand)releaseManual();if(teaching?.driving)void stopAll('Learned drive stopped: app lost focus.');});
$('remote-stop').onclick=()=>void stopAll();
$('boxes').onchange=()=>photos.forEach(p=>void drawPhoto(p));
$('metadata').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;const m=JSON.parse(await f.text());if(!Array.isArray(m.names)||!['raw','end2end'].includes(m.layout)||!Number.isInteger(m.size))throw Error('Invalid model.json');meta=m;localStorage.setItem('robotbot-meta',JSON.stringify(meta));await saveFile('model.json',JSON.stringify(meta));modelReady=false;status('Model metadata imported. Import the matching ONNX file next.');}catch(e){status(e.message);}};
$('model-file').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;status('Saving ONNX model on this device…');await saveFile('model.onnx',f);await storage();modelReady=false;status('Model saved. Click Load saved YOLO.');}catch(e){status('Could not save model: '+e.message);}};
$('voice-file').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;await saveFile('voice.tar.gz',f);await storage();status('Offline Vosk model saved.');}catch(e){status(e.message);}};
$('voice').onclick=async()=>{
  try{if(voice?.active){await voice.stop();$('voice').textContent='Enable offline voice';return;}
    status('Loading offline Vosk and requesting microphone access…');
    voice=new OfflineVoice(text=>{if(globalThis.speechSynthesis?.speaking&&text!=='stop')return;void execute(text).catch(e=>stopAll(e.message));},text=>$('partial').textContent=text);
    await voice.start();$('voice').textContent='Disable voice';status('Offline voice listening. Say stop to cancel movement.');
  }catch(e){reply(e.message);}
};
$('export').onclick=()=>{const blob=new Blob([records.map(r=>JSON.stringify(r)).join('\n')],{type:'application/x-ndjson'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='robotbot-captures-'+Date.now()+'.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
let deferredInstall=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$('install').hidden=false;});
$('install').onclick=async()=>{if(deferredInstall){await deferredInstall.prompt();deferredInstall=null;$('install').hidden=true;}else reply('Use Chrome’s menu → Cast, save and share → Install page as app, or its install icon in the address bar. If already installed, open RobotBot from Start.');};
$('cache').onclick=async()=>{
  $('cache').disabled=true;
  try{await cacheApp(text=>$('offline-status').textContent=text);await storage();$('offline-status').textContent='App files saved. Models are stored separately.';}
  catch(e){$('offline-status').textContent='Offline preparation failed: '+e.message;}
  finally{$('cache').disabled=false;}
};
$('setup-device').onclick=async()=>{
  if(busy||settingUp||teaching?.recording)return;
  settingUp=true;$('setup-device').disabled=true;setBusy(true);
  const progress=text=>{status(text);$('setup-progress').textContent=text;};
  try{
    const result=await installBundle(progress);
    meta=result.meta;MODEL_CACHE=result.cache;
    await storage();setBusy(false);
    if(!await loadModel())throw Error('Files saved, but YOLO warm-up failed. Try CPU/WebAssembly in Advanced settings, then Load saved YOLO.');
    $('setup-progress').textContent='✓ App saved · ✓ YOLO ready · '+(result.voice?'✓ Offline voice saved':'Typed commands ready');
    $('install').hidden=false;
    status('Device ready. Install the app, then connect Wi-Fi to RobotBot.');
  }catch(e){progress('Setup did not finish: '+e.message);log(e.message);}
  finally{settingUp=false;setBusy(false);$('setup-device').disabled=false;}
};
// Stop immediately on backgrounding/navigation; hardware watchdog covers suspended JavaScript.
document.addEventListener('visibilitychange',()=>{if(document.hidden){robot?.emergency();if(navigatorState||manualCommand||teaching?.working||teaching?.recording)void stopAll('App hidden. Robot stopped. Give a new command to resume.');void voice?.stop();$('voice').textContent='Enable offline voice';}});
window.addEventListener('pagehide',()=>robot?.emergency());
window.addEventListener('keydown',e=>{if(e.key==='Escape')void stopAll();});
window.addEventListener('unhandledrejection',e=>{log('Error: '+(e.reason?.message||e.reason));robot?.emergency();});
$('demo').onclick=async()=>{
  if(busy||teaching?.recording)return;await robot?.stop().catch(()=>{});isDemo=true;status('Sample mode. No robot commands are sent.');
  const {drawDemo}=await import('./sample.js');await drawDemo({addPhoto,updatePhoto});
};
if(!isSecureContext){status('Open http://localhost:8765 or a trusted HTTPS site. file:// and robot HTTP pages are not the app.');$('cache').disabled=true;}
else if('serviceWorker'in navigator){
  navigator.serviceWorker.register('./sw.js').then(async()=>{
    await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>{navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});setTimeout(resolve,4000);});
    const cache=await caches.open(APP_CACHE),ready=await cache.match(new URL('./offline-ready',location.href));$('offline-status').textContent=ready?'App files cached on this device.':'First time? Click Set up this device while connected to internet.';
    if(await saved('model.onnx')){
      const metadata=await saved('model.json');if(metadata){meta=await metadata.json();localStorage.setItem('robotbot-meta',JSON.stringify(meta));}
      if(!busy&&!document.hidden)await loadModel();
    }
  }).catch(e=>log('Service worker registration: '+e.message));
}

// Learning is separate from YOLO. No training jobs or model downloads run on the ESP32.
teaching=new Teaching({
 beginRecording:async()=>{if(document.hidden||settingUp||teaching?.working||busy)throw Error('Stop the current operation and connect to RobotBot before recording.');if(!robot?.ready)throw Error('Connect to RobotBot first.');await stopAll(null);},
 motorEvents:()=>robot?.history.events||[],
 begin:async(requireRobot=true)=>{
  if(document.hidden)throw Error('Keep the app visible.');
  if(settingUp||(busy&&!navigatorState&&!manualCommand))throw Error('Finish the current operation or press STOP first.');
  if(requireRobot&&!robot?.ready)throw Error('Connect to RobotBot first.');
  await stopAll(null);setBusy(true);$('mode').textContent='Teaching';
 },
 end:async()=>{await stopAll(null);},
 stop:message=>stopAll(message),
 capture:async()=>({...await robot.capture(),clockUncertainty:robot.uncertainty}),
 show:(frame,label)=>{const card=addPhoto(frame);card.info.textContent=label?'DEMONSTRATION LABEL: '+label+' · exposure timestamp matched':'Teaching camera photo · no YOLO boxes';},
 halt:()=>robot.stop(),
 pulse:async(command,token,current)=>{
  if(!current()||document.hidden)return;
  const speed=Math.min(120,+((command==='F'||command==='B')?$('forward-pwm'):$('turn-pwm')).value);
  if(!Number.isInteger(speed)||speed<1)throw Error('Invalid motor speed.');
  await robot.send(command,.1,speed);
  if(!current()){robot.emergency();return;}
  await new Promise(r=>setTimeout(r,120));
 },
});
