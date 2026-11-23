'use strict';
// Root-only operator step. Verification runs before decryption and staging;
// this does not stop services, acquire production locks or write native slots.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {validate,sha}=require('./validate-native-results.cjs'),{unseal}=require('./seal-results.cjs');
function main(){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('Original operator Linux host root required');
 const [sealedFile,bundleFile,commit]=process.argv.slice(2);if(!/^[0-9a-f]{40}$/.test(commit||''))throw Error('Exact audited source commit required');
 const sealed=fs.readFileSync(sealedFile),signature=fs.readFileSync(bundleFile),envelope=JSON.parse(sealed);
 const base='/var/lib/online-backgammon-requested-compute-plan-20261123';
 const plan=JSON.parse(fs.readFileSync(base+'/private-import-plan.json')).plans.find(p=>p.id===envelope.id);if(!plan)throw Error('Unrequested cohort');
 const inputBytes=fs.readFileSync(base+'/public/'+plan.id+'.json'),input=JSON.parse(inputBytes);
 const expected={commit,inputSha256:sha(inputBytes),executorSha256:sha(fs.readFileSync(path.join(__dirname,'native-child.cjs'))),managerSha256:sha(fs.readFileSync(path.join(__dirname,'run-native-workload.cjs')))};
 if(expected.inputSha256!==plan.workloadSha256||envelope.inputSha256!==expected.inputSha256||envelope.sourceCommit!==commit)throw Error('Input/source mismatch before verification');
 const verification=execFileSync('/opt/online-backgammon-operator-gh-v2.105.0/bin/gh',['attestation','verify',sealedFile,'--bundle',bundleFile,'--repo','volzay/online-backgammon',
  '--signer-workflow','volzay/online-backgammon/.github/workflows/requested-full-rollouts.yml','--source-digest',commit,'--signer-digest',commit,
  '--source-ref','refs/heads/codex/finish-full-rollouts','--deny-self-hosted-runners','--format','json'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 if(!Array.isArray(JSON.parse(verification))||!JSON.parse(verification).length)throw Error('No verified signature');
 const key=fs.readFileSync('/var/lib/online-backgammon-requested-result-keys-20261123/private.pem');const result=unseal(envelope,key);validate(result,input,expected);
 const provenance={signatureVerified:true,sourceCommit:commit,workflow:'volzay/online-backgammon/.github/workflows/requested-full-rollouts.yml',
  sealedArtifactSha256:sha(sealed),signatureBundleSha256:sha(signature),verificationSha256:sha(verification),runId:result.runId,runAttempt:result.runAttempt};
 const dir='/var/lib/online-backgammon-requested-attested-import-20261123';if(!fs.existsSync(dir)){fs.mkdirSync(dir,{mode:0o700});execFileSync('chown',['nardy-worker:nardy-worker',dir]);}
 const target=path.join(dir,plan.id+'.json'),payload=Buffer.from(JSON.stringify({plan,input,result,expected,provenance},null,2)+'\n');
 fs.writeFileSync(target,payload,{mode:0o400,flag:'wx'});execFileSync('chown',['nardy-worker:nardy-worker',target]);
 console.log(JSON.stringify({verified:true,id:plan.id,endpoints:result.outcomes.length,stagedFile:target,stagedSha256:sha(payload),stateDirectory:plan.stateDirectory,manifestId:plan.manifestId,learningEvidenceCreated:false}));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
