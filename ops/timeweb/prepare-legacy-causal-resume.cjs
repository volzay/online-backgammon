'use strict';
// A new, honestly identified reviewer runtime. The old executable closure and
// journals remain intact. Only the already-reviewed per-ply resume patch is
// backported; rules, playing engine, weights and statistical limits are fixed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const OLD='/opt/online-backgammon-causal-worker.pre-ac943a4-20260919T0630Z';
const NEW='/opt/online-backgammon-causal-recovery-fcdc-v2-20261123';
function main(){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('Private Linux preparation required');
 const [lockFile,patchFile,receiptFile]=process.argv.slice(2),lock=JSON.parse(fs.readFileSync(lockFile));
 const old=require(OLD+'/scripts/long-bot-causal-worker');
 if(old.runtimeDigest()!==lock.originalRuntimeDigest||old.policyImplementationId()!==lock.policyImplementationId)throw Error('Original frozen identity differs');
 const names=old.runtimeClosureFiles().map(x=>x[0]).sort();
 if(JSON.stringify(names)!==JSON.stringify(Object.keys(lock.sourceParentFiles).sort()))throw Error('Original closure differs');
 if(fs.existsSync(NEW))throw Error('Never overwrite an immutable replacement runtime');
 const originalFiles=Object.fromEntries(names.map(name=>[name,sha(fs.readFileSync(OLD+'/'+name))]));
 for(const name of lock.exactParentFilesRequired)if(originalFiles[name]!==lock.sourceParentFiles[name])throw Error('Worker/journal is not the exact patch parent: '+name);
 if(sha(fs.readFileSync(patchFile))!==lock.patchSha256)throw Error('Resume source patch differs');
 fs.mkdirSync(NEW,{mode:0o755});
 for(const name of names){const source=OLD+'/'+name;
  const target=NEW+'/'+name;fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o444);
 }
 // No fuzz, three-way merging or policy replacement. Context mismatch aborts.
 execFileSync('/usr/bin/git',['apply','--check',patchFile],{cwd:NEW,stdio:'pipe'});
 execFileSync('/usr/bin/git',['apply',patchFile],{cwd:NEW,stdio:'pipe'});
 const replacementFiles=Object.fromEntries(names.map(name=>{fs.chmodSync(NEW+'/'+name,0o444);return [name,sha(fs.readFileSync(NEW+'/'+name))];}));
 for(const name of names)if(!lock.patchedFiles.includes(name)&&replacementFiles[name]!==originalFiles[name])throw Error('Non-resume source changed');
 for(const name of lock.exactParentFilesRequired)if(replacementFiles[name]!==lock.sourceTargetFiles[name])throw Error('Reviewed checkpoint patch changed');
 const next=require(NEW+'/scripts/long-bot-causal-worker');
 const oldLimits=require(OLD+'/scripts/long-bot-paired-rollout').DEFAULT_ROLLOUT_LIMITS,newLimits=require(NEW+'/scripts/long-bot-paired-rollout').DEFAULT_ROLLOUT_LIMITS;
 if(next.policyImplementationId()!==old.policyImplementationId()||JSON.stringify(oldLimits)!==JSON.stringify(newLimits))throw Error('Policy or statistical criteria changed');
 const before=require(OLD+'/scripts/generate-long-bot-shadow-replay').loadRuntime(),after=require(NEW+'/scripts/generate-long-bot-shadow-replay').loadRuntime();
 if(before.gameBytesDigest!==after.gameBytesDigest||before.runtimeBytesDigest!==after.runtimeBytesDigest)throw Error('Game/engine bytes changed');
 const receipt={schema:lock.schema,sourceCommit:lock.sourceCommit,parentCommit:lock.parentCommit,oldRoot:OLD,newRoot:NEW,
  originalRuntimeDigest:old.runtimeDigest(),newRuntimeDigest:next.runtimeDigest(),policyImplementationId:next.policyImplementationId(),
  gameBytesDigest:after.gameBytesDigest,runtimeBytesDigest:after.runtimeBytesDigest,statisticalLimitsUnchanged:true,originalFilesPreserved:true,
  originalFiles,replacementFiles,patchSha256:lock.patchSha256};
 if(receipt.newRuntimeDigest===receipt.originalRuntimeDigest)throw Error('New reviewer needs its own identity');
 fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));
}
main();
