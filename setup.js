// Hosted onboarding: downloaded bundles are verified before activating a new model cache.
export const APP_CACHE='robotbot-app-v5';
export const activeModelCache=()=>localStorage.getItem('robotbot-model-cache')||'robotbot-models-v1';
export async function fetchChecked(url,expected,onProgress=()=>{}){
 const controller=new AbortController();let timer=setTimeout(()=>controller.abort(),120000);
 try{
  const r=await fetch(url,{cache:'no-store',signal:controller.signal});
  if(!r.ok)throw Error(`Download failed (${r.status}): ${new URL(url,location.href).pathname}. The owner must upload the model release first.`);
  if(!r.body)throw Error('Streaming downloads are unavailable in this browser.');
  const reader=r.body.getReader(),chunks=[];let received=0;
  while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);received+=value.length;clearTimeout(timer);timer=setTimeout(()=>controller.abort(),120000);onProgress(received,expected?.bytes||+r.headers.get('Content-Length')||0);}
  if(expected?.bytes&&received!==expected.bytes)throw Error('Incomplete model download. Reconnect to internet and retry setup.');
  const bytes=new Uint8Array(received);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  if(expected?.sha256){const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');if(hash!==expected.sha256)throw Error('Model checksum mismatch; the release files do not match.');}
  return bytes;
 }finally{clearTimeout(timer);}
}
export async function cacheApp(progress=()=>{}){
 await navigator.serviceWorker.ready;
 const r=await fetch('./assets.json',{cache:'reload'});if(!r.ok)throw Error('Missing app asset manifest.');
 const assets=await r.json(),cache=await caches.open(APP_CACHE);
 for(let i=0;i<assets.length;i++){
  progress(`Saving app files ${i+1}/${assets.length}…`);
  const request=new Request(new URL(assets[i],location.href),{cache:'reload'}),response=await fetch(request);
  if(!response.ok)throw Error('Missing app file '+assets[i]);await cache.put(request,response);
 }
 await cache.put(new URL('./offline-ready',location.href),new Response('yes'));
}
export async function installBundle(progress=()=>{}){
 await navigator.serviceWorker.ready;
 progress('Checking the published model release…');
 const manifest=JSON.parse(new TextDecoder().decode(await fetchChecked('./deployment.json')));
 if(manifest.schema!==1||!manifest.ready||!manifest.metadata||!manifest.yolo)throw Error('The owner has not published the model files yet. See HOSTING.md.');
 const files=[['model.json',manifest.metadata],['model.onnx',manifest.yolo],...(manifest.voice?[['voice.tar.gz',manifest.voice]]:[])];
 for(const [,f]of files)if(!Number.isSafeInteger(f.bytes)||f.bytes<1||!/^\w{64}$/.test(f.sha256)||new URL(f.url,location.href).origin!==location.origin)throw Error('Invalid release manifest. Models must be hosted on the same origin.');
 const name='robotbot-models-'+manifest.yolo.sha256.slice(0,16)+'-'+(manifest.voice?.sha256.slice(0,8)||'text');
 const cache=await caches.open(name);
 // A failed/interrupted setup leaves the previously active model bundle selected.
 for(const [key,file]of files){
  const stored=new URL('./stored/'+key,location.href).href,existing=await cache.match(stored);
  if(existing&&existing.headers.get('X-SHA256')===file.sha256){progress(`${key} already saved.`);continue;}
  const bytes=await fetchChecked(file.url,file,(done,total)=>progress(`Downloading ${key}: ${(done/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`));
  if(key==='model.json'){
   const meta=JSON.parse(new TextDecoder().decode(bytes));if(!Array.isArray(meta.names)||!['raw','end2end'].includes(meta.layout)||!Number.isInteger(meta.size))throw Error('Published model metadata is invalid.');
  }
  await cache.put(stored,new Response(bytes,{headers:{'Content-Type':key.endsWith('.json')?'application/json':'application/octet-stream','X-SHA256':file.sha256}}));
 }
 await cacheApp(progress);
 const meta=await (await cache.match(new URL('./stored/model.json',location.href))).json();
 // Activation happens after all models and shell files are safely saved.
 localStorage.setItem('robotbot-meta',JSON.stringify(meta));
 localStorage.setItem('robotbot-model-cache',name);
 localStorage.setItem('robotbot-release',manifest.version);
 return {meta,cache:name,voice:!!manifest.voice};
}
