#!/usr/bin/env node
'use strict';

// Approved root-only deployment step. Never print or rotate the persistent seed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const KEY_DIRECTORY = '/etc/online-backgammon';
const KEY_FILE = `${KEY_DIRECTORY}/fair-dice-signing.key`;
const BACKUP_DIRECTORY = '/var/backups/online-backgammon/fair-dice-v36-20260918';
const BACKUP_FILE = `${BACKUP_DIRECTORY}/fair-dice-signing.key`;

function checkedDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) throw new Error('DIRECTORY');
}

function provision() {
  if (process.getuid?.() !== 0) throw new Error('ROOT_REQUIRED');
  checkedDirectory(KEY_DIRECTORY);
  checkedDirectory(BACKUP_DIRECTORY);
  let created = false;
  try {
    fs.writeFileSync(KEY_FILE, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    fs.chownSync(KEY_FILE, 10001, 10001);
    created = true;
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(KEY_FILE);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 10001 || stat.gid !== 10001 || (stat.mode & 0o077) || stat.size > 256) throw new Error('KEY_METADATA');
  const fd = fs.openSync(KEY_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let encoded;
  try { encoded = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  const seed = encoded.trim();
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('KEY_FORMAT');
  try { fs.writeFileSync(BACKUP_FILE, encoded, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const backupStat = fs.lstatSync(BACKUP_FILE);
    if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.uid !== 0 || (backupStat.mode & 0o077)
      || fs.readFileSync(BACKUP_FILE, 'utf8') !== encoded) throw new Error('BACKUP_MISMATCH');
  }
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  console.log(JSON.stringify({ publicKey, created, backupVerified: true, keyOwner: 10001 }));
}

if (require.main === module) {
  try { provision(); }
  catch { console.error('Protected signing-key provisioning failed. No secret values are logged.'); process.exitCode = 1; }
}
module.exports = { provision };
