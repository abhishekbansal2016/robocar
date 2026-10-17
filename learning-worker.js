import {trainPolicy,predict,validatePolicy} from './learning.js';
let cancelled=false;
self.onmessage=async({data})=>{
 if(data.type==='cancel'){cancelled=true;return;}
 try{
  if(data.type==='train'){
   cancelled=false;const result=await trainPolicy(data.samples,{epochs:data.epochs||60,cancelled:()=>cancelled,onEpoch:metrics=>postMessage({id:data.id,type:'progress',metrics})});postMessage({id:data.id,ok:true,result});
  }else if(data.type==='predict'){const policy=validatePolicy(data.policy);postMessage({id:data.id,ok:true,result:predict(policy,data.x)});}
 }catch(e){postMessage({id:data.id,ok:false,error:e.message});}
};
