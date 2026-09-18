'use strict';
const path = require('node:path');
const { buildSync } = require('esbuild');
module.exports = function buildFairDiceCrypto() {
  const root = path.join(__dirname, '..');
  buildSync({ entryPoints: [path.join(root, 'lib/fair-dice-crypto-entry.mjs')],
    outfile: path.join(root, 'fair-dice-crypto.js'), bundle: true, format: 'iife',
    globalName: 'NarduFairDiceCrypto', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'eof' });
};
if (require.main === module) module.exports();
