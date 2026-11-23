'use strict';
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const {unseal}=require('../terminal-compute/seal-results.cjs'),{validate,sha}=require('./validate-fragment.cjs');
if(process.platform!=='linux'||process.getuid()!==0)throw Error('Private operator host required');
const [sealedFile,bundle,commit,output]=process.argv.slice(2);
if(!/^[0-9a-f]{40}$/.test(commit||''))throw Error('Exact hosted source commit required');
const bytes=fs.readFileSync(sealedFile),box=JSON.parse(bytes);
if(box.sourceCommit!==commit||!/^.+-s\d+$/.test(box.id||''))throw Error('Unexpected ciphertext/source');
const verification=execFileSync('/opt/online-backgammon-operator-gh-v2.105.0/bin/gh',['attestation','verify',sealedFile,'--bundle',bundle,
 '--repo','volzay/online-backgammon','--signer-workflow','volzay/online-backgammon/.github/workflows/expanded-terminal-study.yml',
 '--source-digest',commit,'--signer-digest',commit,'--source-ref','refs/heads/codex/expanded-statistics-runs','--deny-self-hosted-runners','--format','json'],
 {encoding:'utf8',timeout:60000,maxBuffer:8388608,stdio:['ignore','pipe','pipe']});
if(!Array.isArray(JSON.parse(verification))||!JSON.parse(verification).length)throw Error('No authenticated hosted provenance');
const result=unseal(box,fs.readFileSync('/var/lib/online-backgammon-requested-result-keys-20261123/private.pem'));
const inputBytes=fs.readFileSync(path.join(__dirname,'workloads',result.cohort+'.json')),input=JSON.parse(inputBytes),lock=JSON.parse(fs.readFileSync(path.join(__dirname,'input-lock.json')));
const expected={commit,inputSha256:sha(inputBytes),executorSha256:sha(fs.readFileSync(path.join(__dirname,'native-child.cjs'))),
 managerSha256:sha(fs.readFileSync(path.join(__dirname,'run-fragment.cjs'))),capsules:lock.capsules};
const checked=validate(result,input,expected);
fs.mkdirSync(output,{recursive:true,mode:0o700});const target=path.join(output,result.id+'.json');
const payload={result,provenance:{signatureVerified:true,sourceCommit:commit,sealedSha256:sha(bytes),bundleSha256:sha(fs.readFileSync(bundle)),verificationSha256:sha(verification)}};
if(fs.existsSync(target)){const old=JSON.parse(fs.readFileSync(target));if(JSON.stringify(old.result.outcomes)!==JSON.stringify(result.outcomes))throw Error('Conflicting repeated outcomes');}
else fs.writeFileSync(target,JSON.stringify(payload)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({id:result.id,...checked,verified:true}));
