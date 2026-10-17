const APP='robotbot-app-v5',MODELS='robotbot-models-v1';
const CORE=['./','./index.html','./style.css','./app.js','./core.js','./learning.js','./demonstrations.js','./learning-worker.js','./teaching.js','./setup.js','./robot.js','./voice.js','./sample.js','./inference-worker.js','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(APP).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  // NEVER intercept, cache or replay ESP32 motor commands/photos. Only same-origin static app/model assets.
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  event.respondWith((async()=>{
    // Release manifests and hosted model downloads must be fresh, never duplicated in the app cache.
    if(url.pathname.endsWith('/deployment.json')||url.pathname.includes('/models/'))return fetch(request);
    const selected=url.searchParams.get('cache');
    const modelCache=selected&&/^robotbot-models-[a-zA-Z0-9-]+$/.test(selected)?selected:MODELS;
    const modelRequest=new URL(url);modelRequest.search='';
    const models=await caches.open(modelCache),model=await models.match(modelRequest.href);if(model)return model;
    const app=await caches.open(APP),cached=await app.match(request,{ignoreSearch:true});if(cached)return cached;
    try{const response=await fetch(request);if(response.ok&&url.pathname.startsWith(new URL('./',self.location).pathname))await app.put(request,response.clone());return response;}
    catch(error){if(request.mode==='navigate'){const index=await app.match(new URL('./index.html',self.location));if(index)return index;}throw error;}
  })());
});
