'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {validateFragment,sha}=require('./validate-native-results.cjs'),{unseal}=require('./seal-results.cjs');
function main(){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('Original operator host required');
 const [sealedFile,bundleFile,commit]=process.argv.slice(2);if(!/^[0-9a-f]{40}$/.test(commit||''))throw Error('Exact source commit required');
 const bytes=fs.readFileSync(sealedFile),box=JSON.parse(bytes),base='/var/lib/online-backgammon-requested-compute-plan-20261123';
 const plan=JSON.parse(fs.readFileSync(base+'/private-import-plan.json')).plans.find(p=>p.id===box.id);
 if(!plan||!['8JPN-KUD8-d7','CTNM-E43Z-d5','CTNM-E43Z-d9','CTNM-E43Z-d13'].includes(plan.id)||box.sourceCommit!==commit)throw Error('Unrequested fragment');
 const inputBytes=fs.readFileSync(base+'/public/'+plan.id+'.json'),input=JSON.parse(inputBytes),expected={commit,inputSha256:sha(inputBytes),executorSha256:sha(fs.readFileSync(path.join(__dirname,'native-child.cjs'))),managerSha256:sha(fs.readFileSync(path.join(__dirname,'run-native-workload.cjs')))};
 if(expected.inputSha256!==plan.workloadSha256||box.inputSha256!==expected.inputSha256)throw Error('Original input differs');
 const verified=execFileSync('/opt/online-backgammon-operator-gh-v2.105.0/bin/gh',['attestation','verify',sealedFile,'--bundle',bundleFile,'--repo','volzay/online-backgammon','--signer-workflow','volzay/online-backgammon/.github/workflows/requested-terminal-shards.yml','--source-digest',commit,'--signer-digest',commit,'--source-ref','refs/heads/codex/finish-full-rollouts','--deny-self-hosted-runners','--format','json'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
 if(!JSON.parse(verified).length)throw Error('Signature unavailable');
 const result=unseal(box,fs.readFileSync('/var/lib/online-backgammon-requested-result-keys-20261123/private.pem'));validateFragment(result,input,expected);
 const provenance={signatureVerified:true,sourceCommit:commit,workflow:'volzay/online-backgammon/.github/workflows/requested-terminal-shards.yml',sealedArtifactSha256:sha(bytes),signatureBundleSha256:sha(fs.readFileSync(bundleFile)),verificationSha256:sha(verified),runId:result.runId,runAttempt:result.runAttempt};
 const dir='/var/lib/online-backgammon-requested-attested-fragments-20261123';if(!fs.existsSync(dir)){fs.mkdirSync(dir,{mode:0o700});execFileSync('chown',['nardy-worker:nardy-worker',dir]);}
 const target=path.join(dir,plan.id+'-s'+result.fragment.sampleStart+'.json');
 fs.writeFileSync(target,JSON.stringify({plan,input,result,expected,provenance},null,2)+'\n',{mode:0o400,flag:'wx'});execFileSync('chown',['nardy-worker:nardy-worker',target]);
 console.log(JSON.stringify({verified:true,id:plan.id,sampleStart:result.fragment.sampleStart,endpoints:result.outcomes.length,cohortComplete:false,learningEvidenceCreated:false}));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
