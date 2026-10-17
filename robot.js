import {MotionHistory} from './core.js';
export const now=()=>performance.now()/1000;
export async function timedFetch(url, options={}, timeout=1200){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{const r=await fetch(url,{...options,signal:controller.signal,cache:'no-store',credentials:'omit',targetAddressSpace:'local'});if(!r.ok)throw Error(`Robot HTTP ${r.status}: ${await r.text()}`);return r;}
  catch(e){if(e.name==='AbortError')throw Error('Robot request timed out. Motors will expire through the board watchdog.');throw e;}
  finally{clearTimeout(timer);}
}
export class RobotClient {
  constructor(base,turn360=6){
    const u=new URL(base);
    if(u.protocol!=='http:'||u.port||!/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('Enter a private IPv4 URL such as http://192.168.4.1, without a port or path.');
    this.base=u.origin;this.camera=this.base+':81/capture';this.history=new MotionHistory(turn360);this.offset=null;this.uncertainty=0;this.seq=0;this.session='';this.ready=false;
  }
  async connect(){
    const samples=[];
    for(let i=0;i<3;i++){
      const a=now(),r=await timedFetch(this.base+'/clock'),b=now(),data=await r.json();
      if(data.capabilities!=='pwa-v1')throw Error('Upload the included PWA firmware; it adds CORS, timed turns and command ordering.');
      samples.push({rtt:b-a,offset:(a+b)/2-data.boot_us/1e6});
    }
    const sample=samples.sort((a,b)=>a.rtt-b.rtt)[0];this.offset=sample.offset;this.uncertainty=sample.rtt/2;
    if(this.uncertainty>.15)throw Error('Robot clock round trip is too slow. Reconnect closer to RobotBot.');
    this.session=crypto.randomUUID().replaceAll('-','').slice(0,16);this.seq=0;
    const r=await timedFetch(this.base+'/arm?sid='+this.session);await r.json();this.ready=true;
    await this.send('S');
    // Check readable CORS timestamp headers before enabling movement.
    const frame=await this.capture();return frame;
  }
  async send(command,duration=0,speed=140){
    if(!this.ready)throw Error('Connect to RobotBot first.');
    const seq=++this.seq,params=new URLSearchParams({m:command,sid:this.session,seq:String(seq),speed:String(speed)});
    if(duration)params.set('ms',String(Math.max(1,Math.round(duration*1000))));
    const a=now(),r=await timedFetch(this.base+'/cmd?'+params,{},650),data=await r.json(),b=now();
    if(data.seq!==seq||!Number.isFinite(data.applied_us))throw Error('Unexpected motor acknowledgement.');
    const applied=data.applied_us/1e6+this.offset;
    if(applied<a-this.uncertainty-.05||applied>b+this.uncertainty+.05)throw Error('Robot restarted or its clock changed. Reconnect.');
    this.history.add(applied,command,duration||.3);return {applied,seq};
  }
  async stop(){if(this.ready)await this.send('S');}
  emergency(){
    if(!this.ready)return;
    // A higher sequence STOP rejects a delayed earlier movement request.
    void this.stop().catch(()=>{});
  }
  async capture(){
    const requested=now(),r=await timedFetch(this.camera+'?t='+Date.now(),{},6000);
    const header=r.headers.get('X-Capture-Time-Us'),serverHeader=r.headers.get('X-Server-Time-Us');
    if(!header||!serverHeader||r.headers.get('X-Robot-Capabilities')!=='pwa-v1')throw Error('Camera headers are missing. Upload PWA firmware with exposed CORS headers.');
    const capturedAt=Number(header)/1e6+this.offset,serverAt=Number(serverHeader)/1e6+this.offset;
    if(!Number.isFinite(capturedAt)||capturedAt>serverAt+.05||serverAt>now()+this.uncertainty+.1||capturedAt<requested-2)throw Error('Invalid or reset camera clock. Stop and reconnect.');
    const blob=await r.blob();if(!blob.type.includes('image/jpeg'))throw Error('Camera did not return JPEG.');
    return {blob,capturedAt,capturedUnix:Date.now()/1000-(now()-capturedAt),requested};
  }
}
