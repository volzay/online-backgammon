'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {encrypt,sha}=require('./private-workload-envelope.cjs');
const CASES=new Set(['8JPN-KUD8-d7','CTNM-E43Z-d5','CTNM-E43Z-d9','CTNM-E43Z-d13']);
function main(){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('Original operator host required');
 const [keyFile,bundle,commit,output]=process.argv.slice(2),key=JSON.parse(fs.readFileSync(keyFile));
 if(!/^[0-9a-f]{40}$/.test(commit||'')||key.schema!=='long-requested-compute-fragment-public-key-v1'||!CASES.has(key.id)
  ||key.sourceCommit!==commit||![0,8,16,24].includes(key.sampleStart)||key.sampleEnd!==key.sampleStart+8||!/^\d+$/.test(key.runId||'')||!/^\d+$/.test(key.runAttempt||''))throw Error('Invalid fixed recipient range');
 const base='/var/lib/online-backgammon-requested-compute-plan-20261123',plan=JSON.parse(fs.readFileSync(base+'/private-import-plan.json')).plans.find(p=>p.id===key.id);
 if(!plan||key.inputSha256!==plan.workloadSha256)throw Error('Fixed original input differs');
 execFileSync('/opt/online-backgammon-operator-gh-v2.105.0/bin/gh',['attestation','verify',keyFile,'--bundle',bundle,'--repo','volzay/online-backgammon','--signer-workflow','volzay/online-backgammon/.github/workflows/requested-terminal-shards.yml','--source-digest',commit,'--signer-digest',commit,'--source-ref','refs/heads/codex/finish-full-rollouts','--deny-self-hosted-runners','--format','json'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
 const bytes=fs.readFileSync(base+'/public/'+key.id+'.json');if(sha(bytes)!==plan.workloadSha256)throw Error('Original fixed workload changed');
 const box=encrypt(bytes,key.publicKey,{id:key.id,sourceCommit:commit,runId:key.runId,runAttempt:key.runAttempt,sampleStart:key.sampleStart,sampleEnd:key.sampleEnd});
 const dir=path.join(output,'inputs',key.runId+'-'+key.runAttempt);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(dir,key.id+'-'+sha(key.publicKey)+'.sealed.json'),JSON.stringify(box,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({id:key.id,sampleStart:key.sampleStart,sampleEnd:key.sampleEnd,declaredCohortSamples:32,inputSha256:plan.workloadSha256,recipientVerified:true}));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
