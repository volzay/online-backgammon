const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUILDERS = [
  {
    name: 'long',
    file: path.join(ROOT, 'scripts', 'build-long-bot-engine.js'),
  },
  {
    name: 'short',
    file: path.join(ROOT, 'scripts', 'build-short-bot-engine.js'),
  },
];

for (const fixture of BUILDERS) {
  test(`${fixture.name} bot builder atomically publishes a complete bundle`, () => {
    const source = fs.readFileSync(fixture.file, 'utf8');
    assert.doesNotMatch(source, /writeFileSync\(\s*OUTPUT\s*,/);
    assert.match(source, /writeOutputAtomically\(\s*OUTPUT\s*,/);

    const { writeOutputAtomically } = require(fixture.file);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${fixture.name}-bot-build-`));
    const target = path.join(directory, `${fixture.name}-bot-engine.js`);
    const previous = 'previous complete bundle';
    const next = 'next complete bundle';
    fs.writeFileSync(target, previous);
    let temporary = '';
    let publications = 0;
    const fileSystem = {
      writeFileSync(file, contents) {
        assert.notEqual(file, target);
        assert.equal(path.dirname(file), path.dirname(target));
        temporary = file;
        fs.writeFileSync(file, contents);
      },
      renameSync(from, to) {
        publications += 1;
        assert.equal(from, temporary);
        assert.equal(to, target);
        assert.equal(fs.readFileSync(target, 'utf8'), previous);
        assert.equal(fs.readFileSync(from, 'utf8'), next);
        fs.renameSync(from, to);
      },
      unlinkSync(file) {
        fs.unlinkSync(file);
      },
    };

    try {
      writeOutputAtomically(target, next, fileSystem);
      assert.equal(publications, 1);
      assert.equal(fs.readFileSync(target, 'utf8'), next);
      assert.equal(fs.existsSync(temporary), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
