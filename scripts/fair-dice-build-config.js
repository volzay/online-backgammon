'use strict';

// A partial or unsafe production configuration must fail the build, rather
// than publish a client unable to finish protected games. A key-only build is
// useful for the independent offline proof viewer and does not enable dice.
module.exports = function fairDiceBuildConfig(env = process.env) {
  const publicKey = env.FAIR_DICE_PUBLIC_KEY || '';
  const configuredUrl = env.FAIR_DICE_URL || '';
  if (publicKey && !/^[0-9a-f]{64}$/.test(publicKey)) throw new Error('Invalid fair dice public key.');
  if (!configuredUrl) return { fairDiceUrl: '', fairDicePublicKey: publicKey };
  if (!publicKey) throw new Error('A fair dice service URL requires its pinned public key.');
  let url;
  try { url = new URL(configuredUrl); }
  catch { throw new Error('Invalid fair dice service URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, '') !== '/fair-dice/v1') {
    throw new Error('Fair dice requires HTTPS and the /fair-dice/v1 base path.');
  }
  return { fairDiceUrl: url.href.replace(/\/$/, ''), fairDicePublicKey: publicKey };
};
