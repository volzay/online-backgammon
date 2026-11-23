'use strict';
const fs=require('node:fs'),path=require('node:path');
const {decrypt}=require('./private-workload-envelope.cjs');
async function main(){
 const id=process.argv[2],lock=JSON.parse(fs.readFileSync(path.join(__dirname,'input-lock.json')));
 if(!lock.workloads[id])throw Error('Unknown fixed cohort');
 const publicRecord=JSON.parse(fs.readFileSync('terminal-key-exchange/'+id+'.json'));
 const identity={id,sourceCommit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT};
 const privateKey=fs.readFileSync('private-compute-keys/'+id+'.pem');
 const url='https://raw.githubusercontent.com/volzay/online-backgammon/refs/heads/codex/requested-compute-inputs-20261123/inputs/'+identity.runId+'-'+identity.runAttempt+'/'+id+'.sealed.json';
 const deadline=Date.now()+30*60000;let lastReport=0;
 while(Date.now()<deadline){
  const r=await fetch(url+'?check='+Date.now(),{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(r.ok){const text=await r.text();if(text.length>2097152)throw Error('Encrypted workload size limit');
   const bytes=decrypt(JSON.parse(text),privateKey,publicRecord.publicKey,identity,lock.workloads[id].sha256);
   fs.mkdirSync('private-compute-input',{mode:0o700});fs.writeFileSync('private-compute-input/'+id+'.json',bytes,{mode:0o600,flag:'wx'});fs.rmSync('private-compute-keys/'+id+'.pem');
   console.log('Decrypted verified fixed private input '+id);return;
  }
  if(r.status!==404)throw Error('Encrypted input fetch failed ('+r.status+')');
  if(Date.now()-lastReport>60000){lastReport=Date.now();console.log('Waiting for encrypted fixed input '+id);}
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
 throw Error('No encrypted input before fixed admission deadline');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
