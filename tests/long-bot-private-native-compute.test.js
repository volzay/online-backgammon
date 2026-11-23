'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {encrypt,decrypt,sha}=require('../ops/terminal-compute/private-workload-envelope.cjs');
const {seal,unseal}=require('../ops/terminal-compute/seal-results.cjs');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const plain=Buffer.from(JSON.stringify({board:{point:15},privateFixedSeeds:[123,456]}));
const identity={id:'fixed-case',sourceCommit:'a'.repeat(40),runId:'12345',runAttempt:'1'};
function fixture(){return encrypt(plain,pair.publicKey,identity);}
test('private workload decrypts only for the declared one-time recipient and fixed input',()=>{
 const box=fixture();assert.deepEqual(decrypt(box,pair.privateKey,pair.publicKey,identity,sha(plain)),plain);
 assert.ok(!JSON.stringify(box).includes('privateFixedSeeds'));assert.notDeepEqual(fixture(),box);
});
for(const [field,value]of Object.entries({id:'other',sourceCommit:'b'.repeat(40),runId:'other',runAttempt:'2'}))test('private workload rejects another '+field,()=>assert.throws(()=>decrypt(fixture(),pair.privateKey,pair.publicKey,{...identity,[field]:value},sha(plain))));
test('private workload rejects a different input digest',()=>assert.throws(()=>decrypt(fixture(),pair.privateKey,pair.publicKey,identity,sha('other'))));
test('private workload rejects a different recipient',()=>{
 const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 assert.throws(()=>decrypt(fixture(),other.privateKey,other.publicKey,identity,sha(plain)));
 assert.throws(()=>decrypt(fixture(),other.privateKey,pair.publicKey,identity,sha(plain)));
});
for(const field of ['ciphertext','tag','wrappedKey','iv'])test('private workload rejects tampered '+field,()=>{const box=fixture(),data=Buffer.from(box[field],'base64');data[0]^=1;box[field]=data.toString('base64');assert.throws(()=>decrypt(box,pair.privateKey,pair.publicKey,identity,sha(plain)));});
test('results encrypt and authenticate without exposing terminal data',()=>{
 const r={id:'case',sourceCommit:identity.sourceCommit,inputSha256:'hash',outcomes:[{winner:'dark',plies:100}],complete:true};const box=seal(r,pair.publicKey);
 assert.deepEqual(unseal(box,pair.privateKey),r);assert.ok(!JSON.stringify(box).includes('winner'));assert.notDeepEqual(seal(r,pair.publicKey),box);
 assert.throws(()=>unseal({...box,sourceCommit:'another'},pair.privateKey));assert.throws(()=>unseal({...box,ciphertext:Buffer.from('tampered').toString('base64')},pair.privateKey));
});
