// Clearly marked synthetic preview data for UI inspection; never used for navigation.
export async function drawDemo({addPhoto,updatePhoto}){
  for(let i=0;i<2;i++){
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const c=canvas.getContext('2d');
    c.fillStyle='#cbd8c3';c.fillRect(0,0,640,480);c.fillStyle='#e7e5d4';c.fillRect(0,0,640,290);c.fillStyle='#b4aa89';c.fillRect(0,290,640,190);
    c.fillStyle='#6e8b73';c.beginPath();c.roundRect(390+i*5,190,80,190,17);c.fill();c.fillStyle='#375d4d';c.fillRect(412+i*5,154,36,40);c.fillStyle='#e9e4c6';c.fillRect(393+i*5,250,74,55);
    c.fillStyle='#596659';c.fillRect(110,225,180,13);c.fillRect(123,239,12,145);c.fillRect(265,239,12,145);c.fillStyle='#415543';c.fillRect(118,115,160,110);
    c.fillStyle='#173f3a';c.font='16px system-ui';c.fillText('SAMPLE ILLUSTRATION · not a camera photo',18,32);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg')),at=performance.now()/1000;
    const frame={blob,capturedAt:at,capturedUnix:Date.now()/1000},photo=addPhoto(frame);
    const objects=[{name:'bottle',box:[388+i*5,151,474+i*5,382],x:.674,y:.55,location:'RIGHT',rawConfidence:.83+i*.04,confidence:.83+i*.02,hits:i+1,samples:i+1,width:640,height:480}];
    await updatePhoto(photo,objects,{bottle:.83+i*.02},.45+i*.07,{sample:true});
  }
}
