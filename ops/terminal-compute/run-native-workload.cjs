'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const {seal}=require('./seal-results.cjs');
const resultEncryptionKey=fs.readFileSync(path.join(__dirname,'result-public-key.pem'));
const BASE='/opt/online-backgammon-requested-compute-v1',id=process.argv[2];
const bytes=fs.readFileSync(BASE+'/workloads/'+id+'.json'),input=JSON.parse(bytes),lock=JSON.parse(fs.readFileSync(BASE+'/input-lock.json'));
if(!lock.workloads[id]||sha(bytes)!==lock.workloads[id].sha256)throw Error('Input lock mismatch');
const output=path.resolve('terminal-results');fs.mkdirSync(output,{recursive:true});
const result={schema:'long-requested-attested-native-endpoints-v1',id,inputSha256:sha(bytes),manifestId:input.manifestId,runtimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,
 sourceCommit:process.env.GITHUB_SHA,workflow:process.env.GITHUB_WORKFLOW,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,
 managerSha256:sha(fs.readFileSync(__filename)),executorSha256:sha(fs.readFileSync(BASE+'/native-child.cjs')),capsules:lock.capsules,identities:[],outcomes:[],workers:[],complete:false};
const save=()=>{const file=path.join(output,id+'.sealed.json');fs.writeFileSync(file+'.next',JSON.stringify(seal(result,resultEncryptionKey),null,2)+'\n');fs.renameSync(file+'.next',file);};
let lastReport=0;
async function run(part){return new Promise((resolve,reject)=>{
 const state='/var/lib/online-backgammon-requested-compute-'+id+'-'+part;
 execFileSync('sudo',['install','-d','-o','nardy-worker','-g','nardy-worker','-m','0700',state]);
 execFileSync('sudo',['install','-o','nardy-worker','-g','nardy-worker','-m','0600','/dev/null',state+'/worker.flock']);
 const child=spawn('sudo',['-u','nardy-worker','env','-i','PATH=/opt/online-backgammon-compute-node:/usr/bin:/bin','LANG=C.UTF-8','TZ=UTC','/usr/bin/flock','--exclusive','--nonblock','--no-fork',state+'/worker.flock','/opt/online-backgammon-compute-node/node',BASE+'/native-child.cjs',id,String(part)],{stdio:['ignore','pipe','pipe']});
 let pending='',failure='';child.stderr.on('data',b=>{failure+=b.toString();if(failure.length>16000)failure=failure.slice(-16000);});
 child.stdout.on('data',buffer=>{pending+=buffer;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);let row;
  try{row=JSON.parse(line);}catch{reject(Error('Invalid native output'));child.kill();return;}
  if(row.type==='identity'){result.identities.push(row);save();}
  else if(row.type==='outcome'){delete row.type;result.outcomes.push(row);save();}
  else if(row.type==='complete'){result.workers.push(row);save();}
  if(Date.now()-lastReport>60000){lastReport=Date.now();console.log(JSON.stringify({id,outcomes:result.outcomes.length,required:input.candidates.length*32,part,sample:row.sample,plies:row.plies}));}
 }});
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Native child '+part+' failed: '+failure)));
 });}
Promise.all([0,1,2,3].map(run)).then(()=>{
 const slots=new Set(result.outcomes.map(x=>x.sampleIndex+':'+x.candidateId));
 if(result.identities.length!==4||result.workers.length!==4||slots.size!==32*input.candidates.length||result.outcomes.length!==slots.size)throw Error('Incomplete native cohort');
 for(let i=0;i<32;i++)for(const c of input.candidates)if(!slots.has(i+':'+c.candidateId))throw Error('Missing prespecified endpoint');
 result.complete=true;result.outcomes.sort((a,b)=>a.sampleIndex-b.sampleIndex||a.candidateId.localeCompare(b.candidateId));save();console.log(JSON.stringify({id,complete:true,endpoints:slots.size}));
}).catch(e=>{result.error=e.message;save();console.error(e.stack);process.exitCode=1;});
