'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const protocol=JSON.parse(fs.readFileSync(path.join(__dirname,'protocol.json')));
const request=JSON.parse(fs.readFileSync(path.join(__dirname,'run-request.json')));
const index=protocol.stages.indexOf(request.look);
if(index<0||!Array.isArray(request.cohorts)||!request.cohorts.length||new Set(request.cohorts).size!==request.cohorts.length
 ||request.cohorts.some(id=>!protocol.cases.some(c=>c.id===id))||index>0&&!/^[0-9a-f]{64}$/.test(request.previousLookReportSha256||''))throw Error('Invalid prespecified look request');
if(index>0){
 if(!/^look-reports\/[A-Za-z0-9-]+\.json$/.test(request.previousLookReportPath||''))throw Error('Bound previous look report required');
 const bytes=fs.readFileSync(path.join(__dirname,request.previousLookReportPath)),previous=JSON.parse(bytes);
 const lock=JSON.parse(fs.readFileSync(path.join(__dirname,'input-lock.json')));
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==request.previousLookReportSha256
  ||previous.schema!=='long-expanded-authenticated-look-report-v1'||previous.look!==protocol.stages[index-1]
  ||previous.protocolFileSha256!==lock.protocolFileSha256||request.cohorts.some(id=>!previous.continue.includes(id)))throw Error('Request differs from completed previous look');
}
const start=index?protocol.stages[index-1]:0,include=[];
for(const cohort of request.cohorts)for(let s=start;s<request.look;s+=32)include.push({cohort,start:s});
if(include.length>256)throw Error('GitHub matrix bound');
fs.appendFileSync(process.env.GITHUB_OUTPUT,'matrix='+JSON.stringify({include})+'\n');
console.log(JSON.stringify({look:request.look,fragments:include.length}));
