#!/usr/bin/env node
'use strict';

// Plays complete new guest games through the published UI and real backend.
// No injected patterns, dice, board positions, winners or learning evidence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ORIGIN = 'https://volzay.github.io/online-backgammon';

function options(argv) {
  if (!argv.includes('--production')) throw new Error('Real games require explicit --production');
  const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const games = Number(option('--games') || 2);
  if (!Number.isInteger(games) || games < 1 || games > 4) throw new Error('--games must be 1 to 4');
  const output = path.resolve(option('--output') || fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-real-games-')));
  fs.mkdirSync(output, { recursive: true });
  return { games, output };
}

async function verify({ games, output }) {
  const modulePath = process.env.NARDY_PLAYWRIGHT_MODULE || path.join(os.homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const { chromium } = require(modulePath);
  const results = [], errors = [];
  const save = () => fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), realProductionGames: true,
    patternsInjected: false, diceOverridden: false, stateInjected: false, results, errors,
  }, null, 2) + '\n');
  const browser = await chromium.launch({
    executablePath: process.env.NARDY_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    // Reach the same production API over its existing IPv6 route. HTTPS,
    // origin, authentication and the unmodified published app are preserved.
    args: ['--disable-quic', '--host-resolver-rules=MAP api.201-51-7-193.sslip.io [2a03:6f00:a::ae1e],'
      + 'MAP api.201-51-7-193.2a03-6f00-a--ae1e.sslip.io [2a03:6f00:a::ae1e]'],
  });
  async function play(number) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
    const page = await context.newPage();
    let serverPatterns = [];
    page.setDefaultTimeout(30000);
    const row = { number, status: 'starting', createdAt: new Date().toISOString(),
      botDecisions: 0, decisionsWithExperience: 0, adjustedCandidates: 0, humanMoves: 0 };
    results.push(row); save();
    page.on('response', async response => {
      if (!response.url().endsWith('/rest/v1/rpc/get_long_bot_experience_patterns')) return;
      try {
        const body = await response.json();
        serverPatterns = Array.isArray(body) ? body.filter(p => p.creditVersion === 9
          && p.evidenceSchema === 'long-server-causal-pattern-v1') : [];
        row.rpcExperience = { status: response.status(), patterns: serverPatterns.length,
          aggregateIds: serverPatterns.map(p => p.aggregateId) };
        save();
      } catch { row.rpcExperience = { status: response.status(), unreadable: true }; save(); }
    });
    page.on('pageerror', error => { errors.push({ number, type: 'page', message: error.message }); save(); });
    page.on('requestfailed', request => {
      errors.push({ number, type: 'network', host: new URL(request.url()).host,
        message: request.failure()?.errorText }); save();
    });
    try {
      await page.goto(`${ORIGIN}/login.html`);
      await page.locator('#guest-btn').click();
      await page.waitForURL('**/index.html');
      await page.locator('[data-action=bot]').click();
      await page.locator('[data-create-option=variant][data-value=long]').click();
      await page.locator('[data-create-option=difficulty][data-value=hard]').click();
      await page.locator('#create-game-form button[type=submit]').click();
      await page.waitForURL('**/room.html**');
      row.roomCode = new URL(page.url()).searchParams.get('game');
      row.status = 'playing'; save();
      const deadline = Date.now() + 70 * 60 * 1000;
      while (Date.now() < deadline) {
        const state = await page.evaluate(patterns => {
          const s = window.NarduController?.getState();
          if (!s) return null;
          const memory = s.analysis?.botMemory;
          return { phase: s.phase, turn: s.turn, winner: s.winner, off: s.off,
            policyImplementationId: window.NarduLongBotEngine?.policyImplementationId || null,
            load: memory?.experienceLoad, coverage: memory?.coverage,
            decisions: (memory?.decisions || []).map(d => ({
              size: Number(d.experienceSize) || 0, frozen: d.experienceFrozen === true,
              policyImplementationId: d.policyImplementationId || null,
              openingSupportObserved: Object.hasOwn(d.selected?.features || {}, 'openingSupportAdjustment'),
              openingSupportAdjustment: Number(d.selected?.features?.openingSupportAdjustment) || 0,
              fallback: Number(d.selected?.features?.fallback) || 0,
              adjustments: [d.selected, ...(d.alternatives || [])]
                .filter(Boolean).map(c => Number(c.experienceAdjustment) || 0),
              matchingPublishedLessons: [d.selected, ...(d.alternatives || [])].filter(Boolean)
                .filter(c => Number(c.experienceAdjustment) < 0).flatMap(c => patterns
                  .filter(p => p.contextKey === c.experience?.contextKey && p.actionKey === c.experience?.actionKey)
                  .map(p => ({ decisionId: d.id, aggregateId: p.aggregateId,
                    adjustment: Number(c.experienceAdjustment),
                    selected: c === d.selected, frozen: d.experienceFrozen === true,
                    policyImplementationId: p.policyImplementationId, runtimeDigest: p.runtimeDigest }))),
            })) };
        }, serverPatterns);
        if (!state) { await page.waitForTimeout(1000); continue; }
        row.experienceLoad = state.load ?? row.experienceLoad;
        row.policyImplementationId = state.policyImplementationId ?? row.policyImplementationId;
        row.coverage = state.coverage ?? row.coverage;
        row.botDecisions = state.decisions.length;
        row.decisionPolicyImplementationIds = [...new Set(state.decisions.map(d => d.policyImplementationId))];
        row.openingSupportDecisions = state.decisions.filter(d => d.openingSupportObserved).length;
        row.openingSupportSelectedNonzero = state.decisions.filter(d => d.openingSupportAdjustment !== 0).length;
        row.fallbackDecisions = state.decisions.filter(d => d.fallback !== 0).length;
        row.decisionsWithExperience = state.decisions.filter(d => d.size > 0 && d.frozen).length;
        row.adjustedCandidates = state.decisions.reduce((n, d) => n + d.adjustments.filter(x => x !== 0).length, 0);
        row.matchingPublishedLessons = state.decisions.flatMap(d => d.matchingPublishedLessons);
        row.off = state.off;
        if (state.winner) {
          row.status = 'finished'; row.winner = state.winner; row.completedAt = new Date().toISOString(); save();
          await page.waitForTimeout(8000); // Let the normal archive request finish.
          await page.screenshot({ path: path.join(output, `game-${number}-finished.png`) });
          break;
        }
        if (state.turn === 'white' && state.phase === 'move'
          && await page.locator('#resign-btn').isEnabled()) {
          const move = await page.evaluate(() => {
            const s = NarduController.getState();
            return NarduGame.bestMoveSequences(s, s.turn)[0]?.[0] || null;
          });
          if (move) {
            await page.locator(`[data-point="${move.from}"]`).click();
            await page.waitForTimeout(220);
            await page.locator(move.to ? `[data-point="${move.to}"]` : '#bear-btn').click();
            await page.waitForTimeout(650);
            row.humanMoves++;
          }
          // Retry unchanged positions: a click during an animation can be
          // ignored. A fingerprint must never prevent all subsequent input.
        }
        save();
        await page.waitForTimeout(800);
      }
      if (row.status !== 'finished') throw new Error('Real game exceeded the observation window');
    } catch (error) {
      row.status = 'error'; row.error = error.message; save();
      await page.screenshot({ path: path.join(output, `game-${number}-error.png`), fullPage: true }).catch(() => {});
    } finally { await context.close(); }
  }
  try { await Promise.all(Array.from({ length: games }, (_, index) => play(index + 1))); }
  finally { await browser.close(); save(); }
  return { output, results, errors, complete: results.every(row => row.status === 'finished') };
}

if (require.main === module) {
  (async () => {
    const result = await verify(options(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.complete) process.exitCode = 1;
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { options, verify };
