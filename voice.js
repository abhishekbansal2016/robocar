import {activeModelCache} from './setup.js';
// Optional OFFLINE speech. No Web Speech cloud recognition or LLM.
export class OfflineVoice {
  constructor(onText,onPartial){this.onText=onText;this.onPartial=onPartial;this.active=false;}
  async start(){
    if(this.active)return;
    if(!navigator.mediaDevices?.getUserMedia)throw Error('Microphone requires localhost or trusted HTTPS.');
    if(!globalThis.Vosk)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='./vendor/vosk/vosk.js';s.onload=resolve;s.onerror=()=>reject(Error('Vosk library missing; run npm run prepare:web.'));document.head.append(s);});
    const cache=await caches.open(activeModelCache());
    const url=new URL('./stored/voice.tar.gz',location.href).href;
    if(!await cache.match(url))throw Error('Import your Vosk .tar.gz file first.');
    this.model=await Vosk.createModel(url+'?cache='+encodeURIComponent(activeModelCache()),0);
    try{
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,channelCount:1},video:false});
      this.context=new AudioContext();await this.context.resume();
      this.recognizer=new this.model.KaldiRecognizer(this.context.sampleRate);
      this.recognizer.on('result',m=>{const text=m.result?.text?.trim();if(this.active&&text)this.onText(text);});
      this.recognizer.on('partialresult',m=>{const text=m.result?.partial||'';this.onPartial(text);if(this.active&&/\b(stop|halt|cancel)\b/i.test(text))this.onText('stop');});
      this.source=this.context.createMediaStreamSource(this.stream);
      // ScriptProcessor is deprecated but retained by vosk-browser 0.0.8; keep this optional.
      this.processor=this.context.createScriptProcessor(4096,1,1);
      this.processor.onaudioprocess=e=>{if(this.active)this.recognizer.acceptWaveform(e.inputBuffer);e.outputBuffer.getChannelData(0).fill(0);};
      this.source.connect(this.processor);this.processor.connect(this.context.destination);this.active=true;
    }catch(e){await this.stop();throw e;}
  }
  async stop(){
    this.active=false;this.processor?.disconnect();this.source?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());
    if(this.context&&this.context.state!=='closed')await this.context.close();
    this.recognizer?.remove();this.model?.terminate();this.model=null;
  }
}
