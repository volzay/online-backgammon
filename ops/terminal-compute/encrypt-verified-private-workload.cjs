'use strict';
// Original operator host: authenticate the recipient's exact source commit
// and hosted workflow BEFORE encrypting a private native workload to its key.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {encrypt,sha}=require('./private-workload-envelope.cjs');
function main(){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('Original private operator host required');
 const [keyFile,bundleFile,commit,output]=process.argv.slice(2);if(!/^[0-9a-f]{40}$/.test(commit||''))throw Error('Exact audited commit required');
 const bytes=fs.readFileSync(keyFile),key=JSON.parse(bytes),base='/var/lib/online-backgammon-requested-compute-plan-20261123';
 const plan=JSON.parse(fs.readFileSync(base+'/private-import-plan.json')).plans.find(p=>p.id===key.id);
 if(!plan||key.schema!=='long-requested-compute-public-key-v1'||key.sourceCommit!==commit||key.inputSha256!==plan.workloadSha256||!/^\d+$/.test(key.runId||'')||!/^\d+$/.test(key.runAttempt||''))throw Error('Unrequested recipient/source');
 execFileSync('/opt/online-backgammon-operator-gh-v2.105.0/bin/gh',['attestation','verify',keyFile,'--bundle',bundleFile,'--repo','volzay/online-backgammon',
  '--signer-workflow','volzay/online-backgammon/.github/workflows/requested-full-rollouts.yml','--source-digest',commit,'--signer-digest',commit,
  '--source-ref','refs/heads/codex/finish-full-rollouts','--deny-self-hosted-runners','--format','json'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
 const input=fs.readFileSync(base+'/public/'+key.id+'.json');if(sha(input)!==plan.workloadSha256)throw Error('Private fixed source changed');
 const box=encrypt(input,key.publicKey,{id:key.id,sourceCommit:commit,runId:key.runId,runAttempt:key.runAttempt});
 const dir=path.join(output,'inputs',key.runId+'-'+key.runAttempt);fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,key.id+'.sealed.json'),JSON.stringify(box,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({encrypted:true,id:key.id,inputSha256:plan.workloadSha256,sourceCommit:commit,runId:key.runId,runAttempt:key.runAttempt}));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
