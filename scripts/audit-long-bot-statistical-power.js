#!/usr/bin/env node
'use strict';
// Read-only diagnostic. It cannot create evidence or turn an unpaired marginal
// count into a real paired observation. No production confidence gate changes.
const {logPairedEValue}=require('../lib/long-bot-paired-confidence');
function auditCohorts(cohorts){
 let total=0,complete=0,maxRegret=0,maxLcb=-Infinity,maxOptimisticRatio=0;
 const rows=cohorts.map(c=>{
  const n=Number(c.samples),k=Number(c.candidates),regret=Number(c.regret),count=Number(c.count||1);
  if(!Number.isSafeInteger(n)||n<1||!Number.isSafeInteger(k)||k<2||!Number.isFinite(regret)||regret<0||regret>1||!Number.isSafeInteger(count)||count<1)throw Error('Invalid complete cohort summary');
  const better=Math.round(n*regret);if(Math.abs(better/n-regret)>1e-10)throw Error('Non-native regret count');
  // For fixed d=betterOnly-worseOnly, introducing a +/- discordant pair
  // instead of two ties multiplies each betting capital by
  // ((a+b)(a-b))/a^2 <= 1. Thus worseOnly=0 is the MOST optimistic
  // possible paired evidence consistent with the observed mean difference.
  // It is only an upper bound, never a fabricated pairing or publishable CI.
  const logUpper=logPairedEValue({betterOnly:better,worseOnly:0,equal:n-better},.08);
  const logThreshold=Math.log((k-1)/.05),ratio=Math.exp(logUpper-logThreshold);
  total+=count;complete+=count;maxRegret=Math.max(maxRegret,regret);
  if(Number.isFinite(c.regretLcb))maxLcb=Math.max(maxLcb,c.regretLcb);
  maxOptimisticRatio=Math.max(maxOptimisticRatio,ratio);
  return {...c,optimisticPairedEValueUpper:Math.exp(logUpper),requiredEValue:(k-1)/.05,
   pairedConfirmationPossibleFromTheseMarginals:ratio>1,productionEvidence:false};
 });
 return {schema:'long-bot-terminal-power-audit-v1',completeCohorts:complete,maxObservedRegret:maxRegret,
  greatestReportedRegretLcb:Number.isFinite(maxLcb)?maxLcb:null,maximumOptimisticPairedEvidenceRatio:maxOptimisticRatio,
  evenBestPossiblePairingInsufficient:rows.every(r=>!r.pairedConfirmationPossibleFromTheseMarginals),
  margin:.08,familywiseAlpha:.05,rows,productionEvidence:false,
  limitation:'No new terminal outcomes, real pairings, confirmed lessons or causal-policy aliases are generated.'};
}
module.exports={auditCohorts};
if(require.main===module){const fs=require('node:fs');const file=process.argv[2];if(!file)throw Error('Input JSON required');process.stdout.write(JSON.stringify(auditCohorts(JSON.parse(fs.readFileSync(file,'utf8'))),null,2)+'\n');}
