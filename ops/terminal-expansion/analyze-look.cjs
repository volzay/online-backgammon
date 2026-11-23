'use strict';
// Only private, fully signature-verified fragments may enter a completed look.
const fs=require('fs'),path=require('path');
const {sha,validate}=require('./validate-fragment.cjs');
const {evaluateCase}=require('../../lib/long-bot-expanded-study-confidence');
const [directory,requestFile,output]=process.argv.slice(2);
if(process.platform!=='linux'||process.getuid()!==0)throw Error('Private operator required');
require('./verify-inputs.cjs');
const lock=JSON.parse(fs.readFileSync(__dirname+'/input-lock.json'));
const protocol=JSON.parse(fs.readFileSync(__dirname+'/protocol.json')),request=JSON.parse(fs.readFileSync(requestFile));
if(!protocol.stages.includes(request.look)||!Array.isArray(request.cohorts)||!request.cohorts.length
 ||new Set(request.cohorts).size!==request.cohorts.length)throw Error('Invalid look');
const results=[];
for(const id of request.cohorts){
 const inputBytes=fs.readFileSync(__dirname+'/workloads/'+id+'.json'),input=JSON.parse(inputBytes),rows=[],provenance=[];
 for(let start=0;start<request.look;start+=32){
  const bytes=fs.readFileSync(path.join(directory,id+'-s'+start+'.json')),record=JSON.parse(bytes);
  if(!record.provenance?.signatureVerified||!/^[0-9a-f]{40}$/.test(record.provenance.sourceCommit)
   ||record.result.start!==start||record.result.cohort!==id)throw Error('Missing verified fixed range');
  validate(record.result,input,{commit:record.provenance.sourceCommit,inputSha256:sha(inputBytes),capsules:lock.capsules,
   executorSha256:sha(fs.readFileSync(__dirname+'/native-child.cjs')),managerSha256:sha(fs.readFileSync(__dirname+'/run-fragment.cjs'))});
  rows.push(...record.result.outcomes);provenance.push({start,sourceCommit:record.provenance.sourceCommit,
   verifiedFragmentSha256:sha(bytes),sealedSha256:record.provenance.sealedSha256});
 }
 results.push({id,...evaluateCase(input,rows,protocol,request.look),provenance});
}
const report={schema:'long-expanded-authenticated-look-report-v1',createdAt:new Date().toISOString(),
 protocolFileSha256:lock.protocolFileSha256,look:request.look,results,
 continue:results.filter(x=>!x.studyComplete).map(x=>x.id),
 confirmed:results.filter(x=>x.conclusion==='confirmed').map(x=>x.id),
 sourcePoliciesRetained:true,productionTerminalEvidencePublished:false};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({look:request.look,completeCases:results.length,continue:report.continue,confirmed:report.confirmed,reportSha256:sha(fs.readFileSync(output))}));
