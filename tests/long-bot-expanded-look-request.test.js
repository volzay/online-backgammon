'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
test('a later look requires the exact completed previous report and cannot rerun a closed case',()=>{
 const src=path.join(__dirname,'../ops/terminal-expansion'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'long-look-request-'));
 try{
  fs.mkdirSync(path.join(dir,'look-reports'));
  for(const f of ['plan-matrix.cjs','protocol.json','input-lock.json'])fs.copyFileSync(path.join(src,f),path.join(dir,f));
  const report=fs.readFileSync(path.join(src,'look-reports/8JPN-KUD8-d19-n128.json'));
  fs.writeFileSync(path.join(dir,'look-reports/previous.json'),report);
  const request={look:512,cohorts:['8JPN-KUD8-d19'],previousLookReportPath:'look-reports/previous.json',previousLookReportSha256:crypto.createHash('sha256').update(report).digest('hex')};
  const run=patch=>{fs.writeFileSync(path.join(dir,'run-request.json'),JSON.stringify({...request,...patch}));return spawnSync(process.execPath,[path.join(dir,'plan-matrix.cjs')],{encoding:'utf8',env:{...process.env,GITHUB_OUTPUT:path.join(dir,'output')}});};
  const ok=run({});assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/"fragments":12/);
  for(const patch of [{previousLookReportSha256:'0'.repeat(64)},{cohorts:['8JPN-KUD8-d33']},{look:1024},{previousLookReportPath:'../private.json'}])assert.notEqual(run(patch).status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
