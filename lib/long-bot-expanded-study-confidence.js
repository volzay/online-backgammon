'use strict';
const {clopperPearsonLower,pairedMeanLowerBound}=require('./long-bot-paired-exact-confidence');
function evaluateCase(input,rows,protocol,n){
 const studyCase=protocol.cases?.find(c=>c.id===input.id);
 if(protocol.schema!=='long-expanded-fixed-look-terminal-study-v1'
  ||JSON.stringify(protocol.stages)!=='[128,512,1024]'||protocol.familywiseAlpha!==0.05
  ||protocol.cases.length!==15||protocol.comparisons!==protocol.cases.reduce((sum,c)=>sum+c.candidates-1,0)
  ||protocol.positiveCaseAlpha!==0.05/(2*protocol.cases.length*protocol.stages.length)
  ||protocol.pairedComparisonAlpha!==0.05/(2*protocol.comparisons*protocol.stages.length)
  ||protocol.minEffectLowerBound!==0.08||!protocol.noWithinLookOptionalStopping||!protocol.noExtensionAfterFinalLook
  ||protocol.positiveRule!=='original-simultaneous-Hoeffding-and-paired-CP-lower-bounds-both-above-0.08'
  ||!studyCase||studyCase.controlId!==input.controlId||studyCase.candidates!==input.candidates.length
  ||new Set(input.candidates.map(c=>c.candidateId)).size!==input.candidates.length
  ||!input.candidates.some(c=>c.candidateId===input.controlId)||!['white','dark'].includes(input.botColor)
  ||studyCase.runtimeDigest!==input.runtimeDigest||studyCase.policyImplementationId!==input.policyImplementationId)throw Error('Prespecified case/protocol binding differs');
 if(!protocol.stages.includes(n)||!Array.isArray(rows)||rows.length!==n*input.candidates.length)throw Error('Complete prespecified look required');
 const slots=new Map();for(const r of rows){
  if(!Number.isSafeInteger(r.sampleIndex)||r.sampleIndex<0||r.sampleIndex>=n||!input.candidates.some(c=>c.candidateId===r.candidateId)
   ||!['white','dark'].includes(r.winner)||r.complete!==true
   ||JSON.stringify(r.seeds)!==JSON.stringify(input.seedsBySample[r.sampleIndex]))throw Error('Invalid native outcome');
  const key=r.sampleIndex+':'+r.candidateId;if(slots.has(key))throw Error('Duplicate outcome is not independent evidence');slots.set(key,r);
 }
 const control=input.controlId,alpha=protocol.positiveCaseAlpha;
 if(!(alpha>0&&alpha<=0.05)||!(protocol.pairedComparisonAlpha>0&&protocol.pairedComparisonAlpha<=0.05)
  ||protocol.minEffectLowerBound<0.08||protocol.familywiseAlpha>0.05)throw Error('Confidence criteria weakened');
 const epsilon=Math.sqrt(Math.log(2*input.candidates.length/alpha)/(2*n));
 const outcomes=id=>Array.from({length:n},(_,i)=>Number(slots.get(i+':'+id).winner===input.botColor));
 const original=outcomes(control),controlWins=original.reduce((a,b)=>a+b,0),comparisons=[];
 for(const c of input.candidates){if(c.candidateId===control)continue;
  const alt=outcomes(c.candidateId),counts={sweepWins:0,sweepLosses:0,splitPairs:0};
  for(let i=0;i<n;i++){const d=alt[i]-original[i];counts[d>0?'sweepWins':d<0?'sweepLosses':'splitPairs']++;}
  const lower=pairedMeanLowerBound(counts,{declaredPairs:n,alpha:protocol.pairedComparisonAlpha});
  const pairedLower=2*lower.lower-1;
  const componentAlpha=protocol.pairedComparisonAlpha/2;
  const winUpper=1-clopperPearsonLower(n-counts.sweepWins,n,componentAlpha);
  const lossLower=clopperPearsonLower(counts.sweepLosses,n,componentAlpha);
  const pairedUpper=Math.min(1,winUpper-lossLower);
  const wins=alt.reduce((a,b)=>a+b,0);
  const originalHoeffdingLower=Math.max(0,wins/n-epsilon)-Math.min(1,controlWins/n+epsilon);
  comparisons.push({candidateId:c.candidateId,samples:n,counts,observedGain:(wins-controlWins)/n,
   pairedLower,pairedUpper,originalHoeffdingLower,confirmed:pairedLower>protocol.minEffectLowerBound&&originalHoeffdingLower>protocol.minEffectLowerBound});
 }
 const confirmed=comparisons.some(c=>c.confirmed),futile=comparisons.every(c=>c.pairedUpper<=protocol.minEffectLowerBound);
 return {schema:'long-expanded-complete-native-look-v1',samples:n,completeLook:true,controlWins,comparisons,
  conclusion:confirmed?'confirmed':futile?'effect-at-least-eight-points-excluded':n===protocol.stages.at(-1)?'inconclusive':'continue',
  studyComplete:confirmed||futile||n===protocol.stages.at(-1),
  scope:{runtimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,legalScope:input.legalScope},
  terminalEvidenceForOtherPolicies:false};
}
module.exports={evaluateCase};
