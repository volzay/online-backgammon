// One pinned implementation is bundled locally for the browser and loaded by
// Node. Relays supply data, never executable JavaScript or public keys.
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
export function hash(value) {
  return bytesToHex(sha256(typeof value === 'string' ? encoder.encode(value) : value));
}
export function verifyBeaconSignature(signature, round, publicKey) {
  try {
    const binaryRound = new Uint8Array(8);
    new DataView(binaryRound.buffer).setBigUint64(0, BigInt(round), false);
    const message = bls12_381.shortSignatures.hash(sha256(binaryRound));
    return bls12_381.shortSignatures.verify(hexToBytes(signature), message, hexToBytes(publicKey));
  } catch { return false; }
}
export function verifyReceipt(signature, requestHash, publicKey) {
  try { return ed25519.verify(hexToBytes(signature), hexToBytes(requestHash), hexToBytes(publicKey)); }
  catch { return false; }
}
export function signReceipt(requestHash, privateKey) {
  return bytesToHex(ed25519.sign(hexToBytes(requestHash), hexToBytes(privateKey)));
}
export function receiptPublicKey(privateKey) { return bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey))); }
export function signatureHash(signature) { return hash(hexToBytes(signature)); }
