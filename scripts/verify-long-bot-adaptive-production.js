#!/usr/bin/env node
'use strict';

// Observe unmodified published assets and complete real UI games. Never inject
// boards, dice, policies, experience, outcomes or controller/worker functions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CURRENT_LONG_BOT_POLICY } = require('./verify-long-bot-learning-compatibility');
const ORIGIN = 'https://volzay.github.io/online-backgammon';

function observeAdaptiveGame() {
  const state = window.NarduController?.getState();
  if (!state) return null;
  const moves = values => JSON.stringify((values || []).map(move => ({
    from: Number(move.from), die: Number(move.die), to: move.bearOff ? 0 : Number(move.to),
  })));
  const board = value => value && JSON.stringify({
    points: Object.entries(value.points || {}).filter(([, stack]) => Number(stack?.count) > 0)
      .sort(([a], [b]) => Number(a) - Number(b)).map(([p, s]) => [Number(p), s.color, Number(s.count)]),
    off: [Number(value.off?.white) || 0, Number(value.off?.dark) || 0],
    bar: [Number(value.bar?.white) || 0, Number(value.bar?.dark) || 0],
  });
  const memory = state.analysis?.botMemory;
  return {
    phase: state.phase, turn: state.turn, winner: state.winner, off: state.off,
    playerColor: state.analysis?.playerColor || 'white',
    policyImplementationId: window.NarduLongBotEngine?.policyImplementationId,
    experienceLoad: memory?.experienceLoad, coverage: memory?.coverage,
    decisions: (memory?.decisions || []).map(decision => {
      const tactic = decision.selected?.tactical;
      const features = decision.selected?.features || {};
      const execution = decision.execution;
      const executedMoves = execution?.executedMoves || execution?.executed?.moves;
      const executedAfter = execution?.after || execution?.executed?.after;
      const exact = execution?.complete === true && execution.fallback === false
        && execution.substituted === false && execution.selectedMatchesExecuted === true
        && !(execution.substitutions || []).length
        && Array.isArray(executedMoves) && executedMoves.length > 0
        && moves(executedMoves) === moves(decision.selected?.moves)
        && Boolean(board(executedAfter)) && board(executedAfter) === board(decision.selected?.after);
      return {
        id: decision.id, source: decision.source, policyImplementationId: decision.policyImplementationId,
        profile: decision.replayInput?.runtime?.strategyProfile,
        mode: features.decisionMode, comebackPressure: features.comebackPressure,
        counterplayReserved: Number(features.counterplayTacticalReservation) === 1,
        counterplaySelected: Object.hasOwn(features, 'adaptiveDecisionAdjustment'),
        complete: execution?.complete === true, exact,
        decisionModel: tactic?.decisionModel,
        diceComplete: tactic?.distributionComplete === true && tactic.rolls === 21
          && tactic.distributionWeight === 36,
        finiteEvaluations: ['selfEvaluation', 'opponentEvaluation', 'expectedSelfEvaluation',
          'expectedOpponentEvaluation', 'expectedEquity', 'lowerTailEquity', 'upperTailEquity',
          'adaptiveUtility'].every(key => Number.isFinite(tactic?.[key])),
        analysisNodesUsed: features.analysisNodesUsed, analysisNodeBudget: features.analysisNodeBudget,
      };
    }),
  };
}

async function verify({ output, games = 2 }) {
  fs.mkdirSync(output, { recursive: true });
  const { chromium } = require(process.env.NARDY_PLAYWRIGHT_MODULE || path.join(os.homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  const report = { expectedPolicy: CURRENT_LONG_BOT_POLICY, injectedState: false,
    injectedDice: false, injectedPolicy: false, results: [], complete: false };
  const save = () => fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.NARDY_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--disable-quic', '--host-resolver-rules=MAP api.201-51-7-193.sslip.io [2a03:6f00:a::ae1e],'
      + 'MAP api.201-51-7-193.2a03-6f00-a--ae1e.sslip.io [2a03:6f00:a::ae1e]'],
  });
  async function dismissGuide(page) {
    const skip = page.locator('#onboarding-dialog[open] .onboarding-skip');
    try {
      await skip.waitFor({ state: 'visible', timeout: 5000 });
    } catch (error) {
      if (error.name === 'TimeoutError') return;
      throw error;
    }
    await skip.click();
  }
  async function play(number) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const row = { number, status: 'starting', startedAt: new Date().toISOString(), pageErrors: [] };
    report.results.push(row); save();
    page.on('pageerror', error => { row.pageErrors.push(error.message); save(); });
    try {
      const asset = await page.request.get(`${ORIGIN}/long-bot-engine.js?verify=${Date.now()}`);
      const publishedHash = createHash('sha256').update(await asset.body()).digest('hex');
      const expectedHash = createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../long-bot-engine.js'))).digest('hex');
      row.bundleSha256 = publishedHash;
      if (!asset.ok() || publishedHash !== expectedHash) throw Error('Published engine bytes differ from the release');
      await page.goto(`${ORIGIN}/login.html`);
      await page.locator('#guest-btn').click();
      await page.waitForURL('**/index.html');
      await dismissGuide(page);
      await page.locator('[data-action=bot]').click();
      await page.locator('[data-create-option=variant][data-value=long]').click();
      await page.locator('[data-create-option=difficulty][data-value=hard]').click();
      await page.locator('#create-game-form button[type=submit]').click();
      await page.waitForURL('**/room.html**');
      await dismissGuide(page);
      row.roomCode = new URL(page.url()).searchParams.get('game'); row.status = 'playing'; save();
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        const observed = await page.evaluate(observeAdaptiveGame);
        if (!observed) { await page.waitForTimeout(500); continue; }
        if (observed.policyImplementationId !== CURRENT_LONG_BOT_POLICY) throw Error('The live engine has the wrong policy identity');
        Object.assign(row, { policyImplementationId: observed.policyImplementationId,
          experienceLoad: observed.experienceLoad, coverage: observed.coverage,
          decisions: observed.decisions, off: observed.off });
        const completed = observed.decisions.filter(d => d.complete);
        if (completed.some(d => d.source !== 'engine' || d.policyImplementationId !== CURRENT_LONG_BOT_POLICY
          || d.profile !== 'v26' || d.decisionModel !== 'heuristic-turn-equity-v1'
          || !d.diceComplete || !d.finiteEvaluations || !d.exact
          || ![58, 480].includes(d.analysisNodeBudget) || d.analysisNodesUsed > d.analysisNodeBudget)) {
          throw Error('A completed live turn did not execute the new analytical policy exactly');
        }
        row.verifiedBotTurns = completed.length;
        row.counterplayTurns = completed.filter(d => d.mode === 'counterplay').length;
        row.changedCounterplayPlans = completed.filter(d => d.counterplaySelected).length;
        save();
        if (observed.winner) {
          if (!completed.length || completed.length !== observed.decisions.length
            || observed.experienceLoad?.status !== 'ready') throw Error('Incomplete terminal verification or experience startup');
          row.status = 'finished'; row.winner = observed.winner; row.finishedAt = new Date().toISOString();
          await page.waitForTimeout(8000);
          await page.screenshot({ path: path.join(output, `game-${number}-finished.png`) });
          save(); break;
        }
        if (observed.phase === 'move' && observed.turn === observed.playerColor
          && await page.locator('#resign-btn').isEnabled()) {
          const move = await page.evaluate(() => {
            const state = NarduController.getState();
            return NarduGame.bestMoveSequences(state, state.turn)[0]?.[0] || null;
          });
          if (move) {
            await page.locator(`[data-point="${move.from}"]`).click();
            await page.waitForTimeout(220);
            await page.locator(move.to ? `[data-point="${move.to}"]` : '#bear-btn').click();
            await page.waitForTimeout(650);
          }
        }
        await page.waitForTimeout(650);
      }
      if (row.status !== 'finished') throw Error('Live game observation exceeded its deadline');
    } catch (error) {
      row.status = 'error'; row.error = error.message; save();
      await page.screenshot({ path: path.join(output, `game-${number}-error.png`), fullPage: true }).catch(() => {});
    } finally { await context.close(); }
  }
  try { await Promise.all(Array.from({ length: games }, (_, i) => play(i + 1))); }
  finally { await browser.close(); }
  report.complete = report.results.length === games && report.results.every(row => row.status === 'finished');
  save(); return report;
}

if (require.main === module) {
  if (!process.argv.includes('--production')) throw Error('Explicit --production is required');
  const i = process.argv.indexOf('--output');
  if (i < 0 || !process.argv[i + 1]) throw Error('--output directory is required');
  verify({ output: path.resolve(process.argv[i + 1]) }).then(report => {
    console.log(JSON.stringify({ complete: report.complete, results: report.results.map(({ decisions, ...row }) => row) }));
    if (!report.complete) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { observeAdaptiveGame, verify };
