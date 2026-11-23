'use strict';
// Operator-only, same-host copy. Original scientific records and secret keys
// never leave this server. The original global flock must be held throughout.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline'),{execFileSync}=require('node:child_process');
const {ROOTS}=require('./run-causal-job-recovery.cjs');
const SOURCE='/var/lib/online-backgammon-causal-worker/terminal-journal',TARGET='/var/lib/online-backgammon-causal-recovery-20261123';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function main(){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('Private Linux operator required');
 const uid=Number(execFileSync('id',['-u','nardy-worker'])),gid=Number(execFileSync('id',['-g','nardy-worker']));
 const F=require(ROOTS['009d62ab33510b5d644afd667fc935827dfacedd89a9cc524898224d6a83a3d9']+'/scripts/long-bot-production-fence');
 const lockStat=fs.lstatSync(path.dirname(SOURCE)+'/worker.flock',{bigint:true});
 const own=fs.readFileSync('/proc/locks','utf8').split('\n').map(F.parseProcLock).filter(l=>F.matchesOwnExclusiveLock(l,process.pid,lockStat));
 if(own.length!==1)throw Error('Original exclusive kernel flock required');
 if(fs.existsSync(TARGET))throw Error('Never overwrite an existing isolated journal root');
 const jobs=[];for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity}))if(line){try{jobs.push(JSON.parse(line));}catch{throw Error('Invalid private source record');}}
 if(jobs.length!==43||new Set(jobs.map(j=>j.jobId)).size!==43)throw Error('Exactly 43 effective recovery jobs required');
 const prepared=[];
 for(const j of jobs){
  const root=ROOTS[j.runtimeDigest];if(!root||!Number.isSafeInteger(j.jobId)||typeof j.archivePayloadText!=='string'||sha(j.archivePayloadText)!==j.archiveFingerprint)throw Error('Authoritative source binding differs');
  const w=require(root+'/scripts/long-bot-causal-worker'),h=require(root+'/scripts/generate-long-bot-shadow-replay');
  if(w.runtimeDigest()!==j.runtimeDigest)throw Error('Immutable source runtime differs');
  const binding=sha(h.stableStringify({jobId:j.jobId,archiveFingerprint:j.archiveFingerprint,archivePayloadText:j.archivePayloadText,runtimeDigest:j.runtimeDigest,policyImplementationId:w.policyImplementationId()}));
  const source=SOURCE+'/'+binding,files=[];
  function inspect(directory,prefix=''){
   const ds=fs.lstatSync(directory);if(!ds.isDirectory()||ds.isSymbolicLink()||(ds.mode&0o777)!==0o700)throw Error('Private source directory required');
   for(const name of fs.readdirSync(directory).sort()){
    const full=path.join(directory,name),relative=prefix+name,s=fs.lstatSync(full);
    if(s.isSymbolicLink())throw Error('No symbolic journal paths');
    if(s.isDirectory()){inspect(full,relative+'/');continue;}
    if(!s.isFile()||s.nlink!==1||s.size>8388608||![0o444,0o600].includes(s.mode&0o777))throw Error('Unexpected journal file');
    const bytes=fs.readFileSync(full);if(name==='manifest.json'&&bytes.includes(Buffer.from(SOURCE)))throw Error('Journal location is cryptographically bound; copying refused');
    files.push({relative,sha:sha(bytes),mode:s.mode&0o777});if(files.length>100000)throw Error('Journal file bound exceeded');
   }
  }
  if(fs.existsSync(source))inspect(source);
  else if(j.terminalOutcomes>0||j.hasCheckpoint)throw Error('A persisted native cursor has no authenticated source journal');
  prepared.push({jobId:j.jobId,binding,source,files});
 }
 fs.mkdirSync(TARGET,{mode:0o700});fs.chownSync(TARGET,uid,gid);
 fs.mkdirSync(TARGET+'/terminal-journal',{mode:0o700});fs.chownSync(TARGET+'/terminal-journal',uid,gid);
 const descriptor=fs.openSync(TARGET+'/worker.flock','wx',0o600);fs.closeSync(descriptor);fs.chownSync(TARGET+'/worker.flock',uid,gid);
 let copied=0,totalFiles=0;
 for(const j of prepared){if(!j.files.length)continue;copied++;
  const destination=TARGET+'/terminal-journal/'+j.binding;fs.mkdirSync(destination,{mode:0o700});fs.chownSync(destination,uid,gid);
  for(const f of j.files){const target=path.join(destination,f.relative),parent=path.dirname(target);
   fs.mkdirSync(parent,{recursive:true,mode:0o700});fs.chownSync(parent,uid,gid);fs.chmodSync(parent,0o700);
   fs.copyFileSync(path.join(j.source,f.relative),target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,f.mode);fs.chownSync(target,uid,gid);
   if(sha(fs.readFileSync(target))!==f.sha||sha(fs.readFileSync(path.join(j.source,f.relative)))!==f.sha)throw Error('Journal copy is not byte-identical');totalFiles++;
  }
 }
 const receipt={schema:'same-host-isolated-authenticated-recovery-copy-v1',logicalJobs:43,copiedJobNamespaces:copied,copiedFiles:totalFiles,
  allFileBytesVerified:true,originalJournalsRetained:true,privateKeysExported:false,sourceRuntimeIdentitiesChanged:false,targetStateDirectory:TARGET};
 fs.writeFileSync(process.argv[2],JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
