#!/usr/bin/env node
'use strict';
// A/B replay of real archived positions with unmodified PUBLISHED scripts and
// lessons fetched through the REAL public attested loader. No live room board,
// dice or result is changed; this is explicitly a historical-board replay.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const fixture=require('../tests/fixtures/long-bot-board-learning-rooms.json');
const {CURRENT_LONG_BOT_POLICY}=require('./verify-long-bot-learning-compatibility');
const ORIGIN='https://volzay.github.io/online-backgammon';
async function verify(output){
 const {chromium}=require(process.env.NARDY_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
 const browser=await chromium.launch({headless:true,executablePath:process.env.NARDY_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-quic','--host-resolver-rules=MAP api.201-51-7-193.sslip.io [2a03:6f00:a::ae1e],MAP api.201-51-7-193.2a03-6f00-a--ae1e.sslip.io [2a03:6f00:a::ae1e]']});
 const report={checkedAt:new Date().toISOString(),historicalBoardReplay:true,liveRoomBoardModified:false,
  fabricatedLessons:false,terminalWinProbabilityClaim:false,expectedPolicy:CURRENT_LONG_BOT_POLICY,assets:{},results:[],complete:false};
 try{
  const page=await browser.newPage();await page.goto(`${ORIGIN}/login.html`);
  for(const file of ['game.js','long-bot-engine.js','rooms-client.js']){
   const res=await page.request.get(`${ORIGIN}/${file}?board-learning-proof=${Date.now()}`);
   const hash=createHash('sha256').update(await res.body()).digest('hex');
   if(!res.ok()||hash!==createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',file))).digest('hex'))throw Error(`Published ${file} differs`);
   report.assets[file]=hash;await page.addScriptTag({url:`${ORIGIN}/${file}?proof=${Date.now()}`});
  }
  for(const p of fixture.positions){
   const row=await page.evaluate(async({p,expected})=>{
    const e=window.NarduLongBotEngine,g=window.NarduGame;
    if(e.policyImplementationId!==expected)throw Error('Unexpected published policy');
    const options={strategyProfile:'v26',weights:{opponentHeadFreedom:48000,headLandingExposure:62000,headRelease:9800,foothold:4300,homeEntry:145000,rushPenalty:12500,trapRisk:62000,escapeGatewayRisk:800000,distribution:780},...(p.state.dice.length===4?{maxCandidates:16,initialSequenceLimit:16,maxTacticalCandidates:2,analysisNodeBudget:58}:{maxCandidates:64,analysisNodeBudget:480})};
    const key=s=>JSON.stringify(s.map(m=>[m.from,m.to||0,m.die]));
    e.beginExperienceSession(`public-cold-control-${p.room}`);e.setExperience([],'server');
    e.plan(p.state,options);const cold=e.consumeLastDecision();
    e.beginExperienceSession(`public-server-lessons-${p.room}`);
    const patterns=await window.NarduRooms.loadLongBotExperience({refresh:true});
    const real=patterns.filter(x=>x.creditVersion===10&&x.sourceRoom===p.room);
    if(!real.length)throw Error(`No served real lesson for ${p.room}`);
    e.freezeExperience();e.plan(p.state,options);const learned=e.consumeLastDecision();
    const applied=learned?.selected?.boardModelLesson;
    if(!applied||!real.some(x=>x.aggregateId===applied.aggregateId)||key(cold.selected.moves)===key(learned.selected.moves))throw Error(`No real choice effect for ${p.room}`);
    const legal=g.bestMoveSequences(p.state,p.state.turn).some(s=>key(s)===key(learned.selected.moves));
    if(!legal||!learned.experienceFrozen)throw Error('Unfrozen or illegal learned move');
    const fp=e.experienceSnapshot().fingerprint;e.setExperience([],'server');
    if(e.experienceSnapshot().fingerprint!==fp)throw Error('Mid-game experience changed');
    return {room:p.room,turnIndex:p.turnIndex,loadedPatterns:patterns.length,roomLessons:real.length,
     policyImplementationId:e.policyImplementationId,aggregateId:applied.aggregateId,
     coldMoves:cold.selected.moves,learnedMoves:learned.selected.moves,
     frozen:true,legal:true,choiceChanged:true,evaluation:applied.evaluation,
     diceOutcomes:applied.diceOutcomes,diceWeight:applied.diceWeight,
     terminalOutcomeConfirmed:applied.terminalOutcomeConfirmed};
   },{p,expected:CURRENT_LONG_BOT_POLICY});
   report.results.push(row);
  }
  report.complete=report.results.length===3;
 }finally{await browser.close();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
 return report;
}
if(require.main===module){if(!process.argv.includes('--production'))throw Error('Use --production --output FILE');const i=process.argv.indexOf('--output');if(i<0||!process.argv[i+1])throw Error('Output required');verify(path.resolve(process.argv[i+1])).then(r=>console.log(JSON.stringify({complete:r.complete,results:r.results.map(x=>({room:x.room,choiceChanged:x.choiceChanged,loadedPatterns:x.loadedPatterns}))}))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={verify};
