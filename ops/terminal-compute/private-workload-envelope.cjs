'use strict';
const crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function encrypt(bytes,publicKey,identity){
 const header={schema:'long-requested-private-workload-envelope-v1',...identity,inputSha256:sha(bytes),publicKeySha256:sha(publicKey)};
 const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));
 const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
 return{header,wrappedKey:crypto.publicEncrypt({key:publicKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
function decrypt(box,privateKey,publicKey,identity,inputSha256){
 const expected={schema:'long-requested-private-workload-envelope-v1',...identity,inputSha256,publicKeySha256:sha(publicKey)};
 if(JSON.stringify(box.header)!==JSON.stringify(expected))throw Error('Private workload recipient/source mismatch');
 const key=crypto.privateDecrypt({key:privateKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(box.wrappedKey,'base64'));
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64'));decipher.setAAD(Buffer.from(JSON.stringify(expected)));decipher.setAuthTag(Buffer.from(box.tag,'base64'));
 const bytes=Buffer.concat([decipher.update(Buffer.from(box.ciphertext,'base64')),decipher.final()]);if(sha(bytes)!==inputSha256)throw Error('Private workload checksum mismatch');return bytes;
}
module.exports={encrypt,decrypt,sha};
