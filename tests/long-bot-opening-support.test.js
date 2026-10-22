'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const baseline='591aad85a9a1acb6ade78a8069cf3f1f6c3370ca';
const options={strategyProfile:'v25',maxCandidates:64,analysisNodeBudget:480};
const plain=v=>JSON.parse(JSON.stringify(v));
const metrics=import('../bot-engine/long/metrics.ts');
function runtime(old=false){
 const context=vm.createContext({window:{},console,Date,Math});
 for(const file of ['game.js','long-bot-engine.js']){
  const source=old?execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,maxBuffer:4000000}):fs.readFileSync(path.join(root,file));
  vm.runInContext(source.toString(),context);
 }
 return{game:context.window.NarduGame,engine:context.window.NarduLongBotEngine};
}
const current=runtime(),previous=runtime(true);
function position(color='white',anchors=[2,6,8],head=12){
 const own=color==='white'?[24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]:[12,11,10,9,8,7,6,5,4,3,2,1,24,23,22,21,20,19,18,17,16,15,14,13];
 const opponent=color==='white'?'dark':'white',opponentHead=color==='white'?12:24;
 const s=current.game.initialState('long');Object.assign(s,{turn:color,phase:'move',dice:[2,3],rolled:[2,3],
  points:{[own[0]]:{color,count:head},[opponentHead]:{color:opponent,count:15}},firstMoveDone:{white:true,dark:true}});
 anchors.forEach((offset,index)=>{s.points[own[offset]]={color,count:index===anchors.length-1?15-head-anchors.length+1:1};});
 return s;
}
const ranked=(engine,s,profile='v25')=>plain(engine.rank(plain(s),{...options,strategyProfile:profile}));
const behavior=rows=>rows.map(c=>({sequence:c.sequence,score:c.score,baseScore:c.baseScore,features:c.features,tactical:c.tactical,experience:c.experience,experienceAdjustment:c.experienceAdjustment}));

test('both video skeletons cover every die face with three forward support stations, for either color',async()=>{
 const {openingSupportProfile}=await metrics;
 for(const color of ['white','dark'])for(const anchors of [[1,4,6],[2,5,6]]){
  const p=openingSupportProfile(position(color,anchors),color);
  assert.equal(p.mask,63);assert.equal(p.faceCount,6);assert.equal(p.anchorCount,3);assert.equal(p.efficient,1);assert.equal(p.active,true);
 }
});
test('among all three-station layouts in the first six steps only the two demonstrated layouts cover all faces',async()=>{
 const {openingSupportProfile}=await metrics,all=[];
 for(let a=1;a<=4;a++)for(let b=a+1;b<=5;b++)for(let c=b+1;c<=6;c++){
  if(openingSupportProfile(position('white',[a,b,c]),'white').faceCount===6)all.push([a,b,c]);
 }
 assert.deepEqual(all,[[1,4,6],[2,5,6]]);
 assert.equal(openingSupportProfile(position('white',[1,2,3]),'white').faceCount,3);
});
test('stack height does not manufacture extra face coverage or minimal support',async()=>{
 const {openingSupportProfile}=await metrics,s=position('white',[1,4,6]);
 const before=openingSupportProfile(s,'white');s.points[24].count--;s.points[23].count++;
 assert.deepEqual(openingSupportProfile(s,'white'),before);
 const redundant=openingSupportProfile(position('white',[1,2,4,6],11),'white');
 assert.equal(redundant.faceCount,6);assert.equal(redundant.efficient,0);
});
test('the real native hard plan can complete 2-5-6 instead of leaving one value unsupported',()=>{
 for(const color of ['white','dark']){
  const s=position(color),old=ranked(previous.engine,s),now=ranked(current.engine,s);
  assert.equal(old[0].features.openingSupportAdjustment,undefined);
  if (color==='white') assert.notDeepEqual(now[0].sequence,old[0].sequence);
  assert.equal(now[0].features.openingSupportFacesBefore,3);
  assert.equal(now[0].features.openingSupportFacesAfter,6);
  assert.equal(now[0].features.openingSupportEfficientAfter,1);
  assert.equal(now[0].features.openingSupportAdjustment,600000);
  const played=plain(s);let headMoves=0;
  for(const move of now[0].sequence){headMoves+=move.from===current.game.headPoint(color,played)?1:0;
   assert.equal(current.game.applyMove(played,move.from,move.die,{autoEnd:false}),true);}
  assert.equal(headMoves,1);assert.equal(current.game.hasAnyMoves(played),false);
 }
});
test('the 1-4-6 alternative gets the same bounded support credit',()=>{
 const s=position('white',[1,6,8]);s.dice=s.rolled=[1,3];
 const choice=ranked(current.engine,s)[0];
 assert.equal(choice.features.openingSupportFacesAfter,6);assert.equal(choice.features.openingSupportEfficientAfter,1);
 assert.equal(choice.features.openingSupportAdjustment,600000);
});
test('support is counted across the seventh-to-sixth head-checker boundary',()=>{
 const s=position('white',[2,6,8],7),rows=ranked(current.engine,s);
 const candidate=rows.find(c=>c.after.points[24]?.count===6&&c.features.openingSupportFacesAfter===6);
 assert.ok(candidate);assert.equal(candidate.features.openingSupportMaskAfter,63);
});
test('the control profile and positions outside the opening retain their frozen behavior',()=>{
 const opening=position();
 assert.deepEqual(behavior(ranked(current.engine,opening,'v19')),behavior(ranked(previous.engine,opening,'v19')));
 const later=position('white',[2,6,8],6);
 assert.deepEqual(behavior(ranked(current.engine,later)),behavior(ranked(previous.engine,later)));
 const danger=position();danger.points[12].count=14;danger.off.dark=1;
 assert.deepEqual(behavior(ranked(current.engine,danger)),behavior(ranked(previous.engine,danger)));
});
test('an opening support pattern cannot override an existing three-point blockade',()=>{
 const s=position();s.points[12].count=12;
 for(const point of [21,20,19])s.points[point]={color:'dark',count:1};
 const now=ranked(current.engine,s),old=ranked(previous.engine,s);
 assert.ok(now.length);assert.ok(now.every(c=>c.features.openingSupportAdjustment===0));
 assert.deepEqual(now[0].sequence,old[0].sequence);
});
test('a complete support skeleton receives no bonus when it increases a prospective blockade',()=>{
 const s=position('white',[1,6,8]);s.dice=s.rolled=[3,4];
 const rows=ranked(current.engine,s),skeleton=rows.find(c=>c.features.openingSupportFacesAfter===6);
 assert.ok(skeleton);assert.ok(skeleton.features.prospectiveFenceExtensionDelta<0);
 assert.equal(skeleton.features.openingSupportAdjustment,0);
 assert.notDeepEqual(rows[0].sequence,skeleton.sequence);
 assert.deepEqual(rows[0].sequence,ranked(previous.engine,s)[0].sequence);
});
test('opponent already home disables opening preferences before the first bear-off',()=>{
 const s=position();delete s.points[12];s.points[13]={color:'dark',count:15};
 const now=ranked(current.engine,s);
 assert.ok(now.length);assert.ok(now.every(c=>c.features.openingSupportAdjustment===undefined));
 assert.deepEqual(behavior(now),behavior(ranked(previous.engine,s)));
});
