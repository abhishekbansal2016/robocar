// Label by exposure time, not request completion. Motor acknowledgements use ESP clock mapping.
export function recordedLabel(capturedAt,uncertainty,inputs,motors,observedUntil){
 const margin=Math.max(0,uncertainty)+.04,lo=capturedAt-margin,hi=capturedAt+margin;
 if(!Number.isFinite(capturedAt)||hi>observedUntil)return null;
 const intent=[...inputs].sort((a,b)=>a.at-b.at),actual=[...motors].sort((a,b)=>a.at-b.at);
 const inputAt=t=>{let found=null;for(const e of intent){if(e.at>t)break;found=e.command;}return found;};
 const motorAt=t=>{let found=null;for(const e of actual){if(e.at>t)break;found=e;}if(!found)return null;if(found.command==='S')return 'S';return t<=found.at+found.lease?found.command:'S';};
 const points=[lo,capturedAt,hi];
 for(const e of intent)if(e.at>=lo&&e.at<=hi)points.push(e.at-.00001,e.at+.00001);
 for(const e of actual){if(e.at>=lo&&e.at<=hi)points.push(e.at-.00001,e.at+.00001);const expiry=e.at+e.lease;if(e.command!=='S'&&expiry>=lo&&expiry<=hi)points.push(expiry+.00001);}
 const label=inputAt(capturedAt);if(!['F','L','R','S','B'].includes(label))return null;
 return points.filter(t=>t>=lo&&t<=hi).every(t=>inputAt(t)===label&&motorAt(t)===label)?label:null;
}
