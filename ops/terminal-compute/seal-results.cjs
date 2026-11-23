'use strict';
const crypto=require('node:crypto');
function seal(result,publicKey){
 const header={schema:'long-requested-sealed-native-results-v1',id:result.id,sourceCommit:result.sourceCommit,inputSha256:result.inputSha256};
 const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),aad=Buffer.from(JSON.stringify(header));
 const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(result)),cipher.final()]);
 const wrapped=crypto.publicEncrypt({key:publicKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
 return{...header,wrappedKey:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
}
function unseal(envelope,privateKey){
 const {schema,id,sourceCommit,inputSha256}=envelope;if(schema!=='long-requested-sealed-native-results-v1')throw Error('Invalid sealed result');
 const key=crypto.privateDecrypt({key:privateKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAAD(Buffer.from(JSON.stringify({schema,id,sourceCommit,inputSha256})));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
 const result=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]));
 if(result.id!==id||result.sourceCommit!==sourceCommit||result.inputSha256!==inputSha256)throw Error('Sealed identity mismatch');return result;
}
module.exports={seal,unseal};
