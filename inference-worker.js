import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import {decodeOutput,letterbox} from './core.js';
ort.env.wasm.numThreads=1; // Works without cross-origin isolation on ordinary PWA hosts.
ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths=new URL('./vendor/ort/',import.meta.url).href;
let session=null,meta=null,provider='';
self.onmessage=async ({data})=>{
  const {id,type}=data;
  try{
    if(type==='load'){
      if(session)await session.release();
      session=null;
      meta=data.meta;
      if(!Array.isArray(meta.names)||meta.names.length<1||!['raw','end2end'].includes(meta.layout)||!Number.isInteger(meta.size)||meta.size<160||meta.size>1280)throw Error('Invalid model.json. Use scripts/export_model.py.');
      const bytes=new Uint8Array(data.buffer);
      if(data.provider!=='wasm'&&self.navigator.gpu){
        try{session=await ort.InferenceSession.create(bytes,{executionProviders:['webgpu'],graphOptimizationLevel:'all'});provider='WebGPU';}
        catch(e){postMessage({type:'notice',message:'WebGPU load failed; trying CPU/WASM. '+e.message});}
      }
      if(!session){session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});provider='CPU/WASM';}
      // Warm up and validate actual output layout before any motor can move.
      const tensor=new ort.Tensor('float32',new Float32Array(3*meta.size*meta.size),[1,3,meta.size,meta.size]);
      const output=await session.run({[session.inputNames[0]]:tensor});
      decodeOutput(output[session.outputNames[0]].data,output[session.outputNames[0]].dims,meta,letterbox(meta.size,meta.size,meta.size));
      for(const t of Object.values(output))t.dispose();tensor.dispose();
      postMessage({id,ok:true,provider});return;
    }
    if(type!=='infer'||!session)throw Error('Load the YOLO model first.');
    const started=performance.now(),bitmap=data.bitmap,transform=letterbox(bitmap.width,bitmap.height,meta.size);
    const canvas=new OffscreenCanvas(meta.size,meta.size),ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,meta.size,meta.size);
    ctx.drawImage(bitmap,transform.padX,transform.padY,transform.w,transform.h);bitmap.close();
    const pixels=ctx.getImageData(0,0,meta.size,meta.size).data,n=meta.size*meta.size,input=new Float32Array(n*3);
    for(let i=0;i<n;i++){input[i]=pixels[i*4]/255;input[n+i]=pixels[i*4+1]/255;input[2*n+i]=pixels[i*4+2]/255;}
    const tensor=new ort.Tensor('float32',input,[1,3,meta.size,meta.size]);
    const output=await session.run({[session.inputNames[0]]:tensor});
    const t=output[session.outputNames[0]],objects=decodeOutput(t.data,t.dims,meta,transform,data.threshold??.3);
    for(const v of Object.values(output))v.dispose();tensor.dispose();
    postMessage({id,ok:true,objects,elapsed:(performance.now()-started)/1000});
  }catch(error){data.bitmap?.close();postMessage({id,ok:false,error:error.message||String(error)});}
};
