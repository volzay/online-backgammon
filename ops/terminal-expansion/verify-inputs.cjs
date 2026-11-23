'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const BASE=__dirname,lock=JSON.parse(fs.readFileSync(BASE+'/input-lock.json'));
if(sha(fs.readFileSync(BASE+'/protocol.json'))!==lock.protocolFileSha256)throw Error('Prespecified protocol changed');
for(const [file,digest]of Object.entries(lock.capsules))if(sha(fs.readFileSync(path.join(BASE,'../terminal-compute/capsules',file)))!==digest)throw Error('Native capsule changed');
const allowed=new Set(['schema','id','runtimeDigest','policyImplementationId','gameBytesDigest','runtimeBytesDigest','node','v8','botColor','seedsBySample','limits','candidates','originalInputSha256','originalManifestId','sampleCount','stages','seedOffset','state','controlId','sourceRoom','legalScope']);
for(const [id,expected]of Object.entries(lock.workloads)){
 const bytes=fs.readFileSync(BASE+'/workloads/'+id+'.json'),input=JSON.parse(bytes);
 if(sha(bytes)!==expected.sha256||input.id!==id||Object.keys(input).some(k=>!allowed.has(k)))throw Error('Workload binding/privacy envelope differs');
 const states=[input.state,...input.candidates.map(c=>c.afterState)];
 for(const s of states){if(!Array.isArray(s.history)||s.history.length)throw Error('Original game history must stay private');}
 const text=bytes.toString();if(/"(?:playerName|player_name|player_user_id|nickname|email|password|messages|privateKey|SUPABASE_SERVICE_ROLE_KEY)"/.test(text))throw Error('Identity or secret in anonymous input');
}
console.log(JSON.stringify({protocolLocked:true,anonymousDatasets:Object.keys(lock.workloads).length}));
