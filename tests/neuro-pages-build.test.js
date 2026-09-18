'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

test('Pages build ships the frozen neural assets in dependency order without private training artifacts', () => {
  const version = 'neuro448test';
  execFileSync(process.execPath, [path.join(root, 'scripts/build-github-pages.js')], {
    cwd: root, env: { ...process.env, GITHUB_SHA: version }, stdio: 'pipe',
  });
  const html = fs.readFileSync(path.join(root, 'dist/room.html'), 'utf8');
  const files = ['game.js', 'lib/long-bot-neural.js', 'vendor/long-neural/model.js', 'long-neural-bot.js', 'bot.js', 'game-controller.js'];
  let previous = -1;
  for (const file of files) {
    const index = html.indexOf(`src="${file}?v=${version}"`);
    assert.ok(index > previous, `${file} ships after its dependencies and is versioned`);
    previous = index;
    assert.equal(fs.readFileSync(path.join(root, 'dist', file), 'utf8'), fs.readFileSync(path.join(root, file), 'utf8'));
  }
  assert.match(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8'), /data-value="hard-neuro"|data-value='hard-neuro'/);
  for (const file of ['data/long-neural', 'experiments/long-neural', 'scripts/train-long-bot-neural.js', 'lib/long-neural-artifact.js']) {
    assert.equal(fs.existsSync(path.join(root, 'dist', file)), false, `${file} stays out of the public site`);
  }
});
