'use strict';const test=require('node:test'),assert=require('node:assert/strict');
const {auditCohorts}=require('../scripts/audit-long-bot-statistical-power');
const {logPairedEValue}=require('../lib/long-bot-paired-confidence');
test('optimistic audit cannot manufacture statistical confirmation from sparse existing outcomes',()=>{
 const r=auditCohorts([{samples:32,candidates:11,regret:9/32,regretLcb:-.3355,count:1}]);
 assert.equal(r.evenBestPossiblePairingInsufficient,true);assert.equal(r.productionEvidence,false);
 assert.ok(r.maximumOptimisticPairedEvidenceRatio<1);assert.equal(r.completeCohorts,1);
});
test('the optimistic upper bound dominates every feasible real pairing',()=>{
 for(const n of [32,64,128])for(let diff=0;diff<=n;diff++){
  const upper=logPairedEValue({betterOnly:diff,worseOnly:0,equal:n-diff},.08);
  for(let worse=0;2*worse+diff<=n;worse++)assert.ok(logPairedEValue({betterOnly:diff+worse,worseOnly:worse,equal:n-diff-2*worse},.08)<=upper+1e-10);
 }
});
test('the audit distinguishes sufficient possible power from actual verified evidence',()=>{
 const r=auditCohorts([{samples:128,candidates:2,regret:.5}]);assert.equal(r.evenBestPossiblePairingInsufficient,false);assert.equal(r.productionEvidence,false);
 assert.throws(()=>auditCohorts([{samples:32,candidates:11,regret:.123}]));
});
