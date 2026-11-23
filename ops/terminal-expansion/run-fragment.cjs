'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn,execFileSync}=require('child_process');
const {seal}=require('../terminal-compute/seal-results.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const [cohort,startText]=process.argv.slice(2),start=Number(startText),BASE='/opt/online-backgammon-expanded-compute-v1';
if(!Number.isSafeInteger(start)||start<0||start>992||start%32)throw Error('Invalid fragment range');
const bytes=fs.readFileSync(BASE+'/workloads/'+cohort+'.json'),input=JSON.parse(bytes),lock=JSON.parse(fs.readFileSync(BASE+'/input-lock.json'));
if(sha(bytes)!==lock.workloads[cohort]?.sha256)throw Error('Input changed');
const result={schema:'long-expanded-attested-native-fragment-v1',id:cohort+'-s'+start,cohort,start,end:start+32,
 inputSha256:sha(bytes),sourceCommit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,
 runtimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,managerSha256:sha(fs.readFileSync(__filename)),
 executorSha256:sha(fs.readFileSync(BASE+'/native-child.cjs')),capsules:lock.capsules,identities:[],outcomes:[],workers:[],fragmentComplete:false,studyComplete:false};
const output=path.resolve('expanded-results');fs.mkdirSync(output,{recursive:true});
const key=fs.readFileSync(path.join(__dirname,'../terminal-compute/result-public-key.pem'));
function save(){const file=path.join(output,result.id+'.sealed.json');fs.writeFileSync(file+'.next',JSON.stringify(seal(result,key))+'\n');fs.renameSync(file+'.next',file);}
let lastReport=0;
async function run(part){return new Promise((resolve,reject)=>{
 const state='/var/lib/online-backgammon-expanded-'+cohort+'-'+start+'-'+part;
 execFileSync('sudo',['install','-d','-m','0700','-o','nardy-worker','-g','nardy-worker',state]);
 execFileSync('sudo',['install','-m','0600','-o','nardy-worker','-g','nardy-worker','/dev/null',state+'/worker.flock']);
 const child=spawn('sudo',['-u','nardy-worker','env','-i','PATH=/opt/online-backgammon-compute-node:/usr/bin:/bin','LANG=C.UTF-8','TZ=UTC',
  '/usr/bin/flock','--exclusive','--nonblock','--no-fork',state+'/worker.flock','/opt/online-backgammon-compute-node/node',BASE+'/native-child.cjs',cohort,String(part),String(start)],{stdio:['ignore','pipe','pipe']});
 let pending='',failure='';child.stderr.on('data',b=>{failure=(failure+b).slice(-12000);});
 child.stdout.on('data',b=>{pending+=b;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);let row;
  try{row=JSON.parse(line);}catch{child.kill();reject(Error('Invalid native output'));return;}
  if(row.type==='identity')result.identities.push(row);
  else if(row.type==='outcome'){delete row.type;result.outcomes.push(row);save();}
  else if(row.type==='complete')result.workers.push(row);
  if(Date.now()-lastReport>60000){lastReport=Date.now();console.log(JSON.stringify({cohort,start,received:result.outcomes.length,required:32*input.candidates.length,part,sample:row.sample,plies:row.plies}));}
 }});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Native fragment '+part+' failed: '+failure)));
 });}
save();Promise.all([0,1,2,3].map(run)).then(()=>{
 const slots=new Set(result.outcomes.map(r=>r.sampleIndex+':'+r.candidateId));
 if(result.identities.length!==4||result.workers.length!==4||slots.size!==32*input.candidates.length||result.outcomes.length!==slots.size)throw Error('Partial fragment cannot complete');
 for(let s=start;s<start+32;s++)for(const c of input.candidates)if(!slots.has(s+':'+c.candidateId))throw Error('Missing native slot');
 result.fragmentComplete=true;save();console.log(JSON.stringify({cohort,start,fragmentComplete:true,endpoints:slots.size,studyComplete:false}));
}).catch(e=>{result.error=e.message;save();console.error(e.message);process.exitCode=1;});
