#!/usr/bin/env node
'use strict';

/**
 * Offline, fail-closed review of long-bot training exports.
 *
 * Old telemetry is never guessed or reconstructed. For new telemetry, the
 * script can build a bounded replay from the exact archived state/runtime and
 * frozen experience snapshot. A review is accepted only when the input has:
 *   - stateSnapshotV2 and matching engine/experience identity;
 *   - an explicit, complete executed-action record;
 *   - a complete counterfactual replay of every legal candidate.
 *
 * Supported inputs are JSON or JSONL. A document can be a training-game row
 * with `decisions`, an array / `{ games: [...] }`, or an envelope shaped as:
 *
 *   { decision, replay: { ...identity, coverage, candidates: [...] } }
 *
 * Attached replay evidence is client-controlled and is diagnostics-only. By
 * default the script regenerates a bounded replay from stateSnapshotV2 +
 * replayInput + final_state replayExperience even when an attachment exists.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  DEFAULT_LIMITS: DEFAULT_SHADOW_LIMITS,
  generateLongBotShadowReplay,
} = require('./generate-long-bot-shadow-replay');

const REPORT_SCHEMA = 'long-bot-loss-review-report-v1';
const REVIEWER_PATH = path.join(__dirname, '..', 'bot-engine', 'long', 'reviewer.ts');

let reviewerPromise = null;

function loadReviewer() {
  reviewerPromise ||= import(pathToFileURL(REVIEWER_PATH).href);
  return reviewerPromise;
}

function parseTrainingText(text, source = '<input>') {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '');
  if (!normalized.trim()) return { format: 'empty', documents: [] };

  try {
    return { format: 'json', documents: [JSON.parse(normalized)] };
  } catch (jsonError) {
    const documents = [];
    const lines = normalized.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        documents.push(JSON.parse(line));
      } catch (lineError) {
        const error = new Error(`${source}:${index + 1}: invalid JSONL: ${lineError.message}`);
        error.cause = lineError;
        throw error;
      }
    }
    if (!documents.length) throw jsonError;
    return { format: 'jsonl', documents };
  }
}

function collectGames(documents) {
  const games = [];
  for (const document of Array.isArray(documents) ? documents : [documents]) {
    collectDocumentGames(document, games);
  }
  return games;
}

function collectDocumentGames(value, games) {
  if (Array.isArray(value)) {
    value.forEach(item => collectDocumentGames(item, games));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const key of ['games', 'trainingGames']) {
    if (Array.isArray(value[key])) {
      value[key].forEach(item => collectDocumentGames(item, games));
      return;
    }
  }

  if (value.decision && typeof value.decision === 'object') {
    games.push({
      ...gameMetadata(value),
      decisions: [value.decision],
      __envelopeReplay: value.replay || value.counterfactualReplay || null,
    });
    return;
  }

  if (Array.isArray(value.decisions)) {
    games.push(value);
    return;
  }

  if (value.selected && (value.source || value.engineVersion)) {
    games.push({ decisions: [value] });
  }
}

function gameMetadata(value) {
  const game = value.game && typeof value.game === 'object' ? value.game : value;
  return {
    id: game.id || game.gameId || game.game_id || '',
    roomCode: game.roomCode || game.room_code || '',
    winner: game.winner || '',
    resultType: game.resultType || game.result_type || '',
    botColor: game.botColor || game.bot_color || '',
  };
}

function classifyGameOutcome(game) {
  const winner = normalizedColor(game?.winner);
  const botColor = normalizedColor(game?.botColor || game?.bot_color);
  if (!winner || !botColor) return 'unknown';
  return winner === botColor ? 'win' : 'loss';
}

function normalizedColor(value) {
  const color = String(value || '').trim().toLowerCase();
  return color === 'white' || color === 'dark' ? color : '';
}

function replayForDecision(game, decision) {
  const direct = decision?.counterfactualReplay
    || decision?.shadowReplay
    || decision?.replay
    || null;
  if (direct && typeof direct === 'object') return direct;

  const id = String(decision?.id || '');
  for (const collection of [
    game?.counterfactualReplays,
    game?.shadowReplays,
    game?.replays,
  ]) {
    if (!collection) continue;
    if (!Array.isArray(collection) && typeof collection === 'object' && collection[id]) {
      return collection[id];
    }
    if (Array.isArray(collection)) {
      const found = collection.find(item => (
        String(item?.decisionId || item?.decision_id || '') === id
      ));
      if (found) return found;
    }
  }
  return game?.__envelopeReplay || null;
}

function canonicalMoves(moves) {
  if (!Array.isArray(moves) || moves.length === 0) return '';
  const parts = [];
  for (const move of moves) {
    if (!move || typeof move !== 'object') return '';
    const from = finiteInteger(move.from);
    const die = finiteInteger(move.die);
    const to = finiteInteger(move.to);
    if (from === null || die === null) return '';
    parts.push(`${from}>${to === null ? '?' : to}@${die}`);
  }
  return parts.join(';');
}

function finiteInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function actionKey(candidate) {
  return String(
    candidate?.experience?.actionKey
    || candidate?.actionKey
    || canonicalMoves(candidate?.moves)
    || '',
  );
}

function executionIdentity(decision, afterPositionKey) {
  const selectedPositionKey = afterPositionKey(decision?.selected);
  const selectedActionKey = actionKey(decision?.selected)
    || String(decision?.experience?.actionKey || '');
  const execution = decision?.execution;
  const base = {
    status: 'insufficient-evidence',
    reason: 'execution-completion-missing',
    selectedPositionKey,
    executedPositionKey: '',
    selectedActionKey,
    executedActionKey: '',
  };

  if (!execution || typeof execution !== 'object' || execution.complete !== true) return base;

  const executedCandidate = execution.executed
    || (execution.after ? { after: execution.after, moves: execution.moves } : null)
    || (execution.executedAfter
      ? { after: execution.executedAfter, moves: execution.executedMoves }
      : null);
  const executedPositionKey = afterPositionKey(executedCandidate);
  const executedMoves = execution.executedMoves
    || execution.actualMoves
    || execution.moves
    || execution.executed?.moves;
  const executedActionKey = String(
    execution.executedActionKey
    || execution.actionKey
    || actionKey(execution.executed)
    || '',
  );

  const identity = {
    ...base,
    executedPositionKey,
    executedActionKey,
  };

  if (
    execution.fallback === true
    || execution.substituted === true
    || (Array.isArray(execution.substitutions) && execution.substitutions.length > 0)
  ) {
    return { ...identity, status: 'diverged', reason: 'execution-substitution' };
  }

  if (!selectedPositionKey || !executedPositionKey) {
    return {
      ...identity,
      reason: selectedPositionKey ? 'executed-position-missing' : 'selected-position-missing',
    };
  }
  if (selectedPositionKey !== executedPositionKey) {
    return { ...identity, status: 'diverged', reason: 'executed-position-differs-from-selected' };
  }

  const selectedMoves = canonicalMoves(decision?.selected?.moves);
  const actualMoves = canonicalMoves(executedMoves);
  if (!selectedMoves || !actualMoves) {
    return { ...identity, reason: 'execution-moves-missing' };
  }
  if (selectedMoves !== actualMoves) {
    return { ...identity, status: 'diverged', reason: 'executed-action-differs-from-selected' };
  }
  const explicitExecutedActionKey = String(
    execution.executedActionKey
    || execution.executed?.experience?.actionKey
    || execution.executed?.actionKey
    || '',
  );
  if (!selectedActionKey || !explicitExecutedActionKey) {
    return { ...identity, reason: 'execution-action-identity-missing' };
  }
  if (selectedActionKey !== explicitExecutedActionKey) {
    return {
      ...identity,
      executedActionKey: explicitExecutedActionKey,
      status: 'diverged',
      reason: 'executed-action-identity-differs-from-selected',
    };
  }

  return { ...identity, executedActionKey: explicitExecutedActionKey, status: 'matched', reason: '' };
}

function missingReplayEvidence(decision, replay) {
  const missing = [];
  if (!decision?.stateSnapshotV2) missing.push('state-snapshot-v2-missing');
  if (!String(decision?.stateFingerprintV2 || '')) missing.push('state-fingerprint-v2-missing');
  if (!replay || typeof replay !== 'object') {
    missing.push('complete-counterfactual-replay-missing');
    return missing;
  }
  if (!Array.isArray(replay.candidates) || replay.candidates.length === 0) {
    missing.push('candidates-missing');
  }
  if (replay.outcomeUsed !== false) missing.push('replay-outcome-provenance-invalid');
  if (
    !String(replay.stateFingerprintV2 || '')
    || String(replay.stateFingerprintV2) !== String(decision?.stateFingerprintV2 || '')
  ) {
    missing.push('state-fingerprint-v2-mismatch');
  }
  const expected = Number(replay.coverage?.expectedCandidates);
  const evaluated = Number(replay.coverage?.evaluatedCandidates);
  if (
    replay.coverage?.complete !== true
    || !Number.isFinite(expected)
    || !Number.isFinite(evaluated)
    || expected < 1
    || expected !== evaluated
    || evaluated !== replay.candidates?.length
  ) {
    missing.push('candidate-coverage-incomplete');
  }
  const candidates = Array.isArray(replay.candidates) ? replay.candidates : [];
  const usesRawScore = candidates.length > 0
    && candidates.every(candidate => Number.isFinite(Number(candidate?.score)))
    && !candidates.every(candidate => Number.isFinite(Number(candidate?.policyScore)))
    && !candidates.every(candidate => Number.isFinite(Number(candidate?.equity)));
  if (usesRawScore) {
    const semantics = String(replay.scoreSemantics || '');
    if (
      !semantics
      || candidates.some(candidate => String(candidate?.scoreSemantics || '') !== semantics)
    ) {
      missing.push('candidate-score-semantics-missing');
    }
  }
  return missing;
}

function publicOutcome(game, classification) {
  return {
    classification,
    winner: String(game?.winner || ''),
    resultType: String(game?.resultType || game?.result_type || ''),
    botColor: String(game?.botColor || game?.bot_color || ''),
    role: 'cohort-filter-only',
    usedAsDecisionLabel: false,
  };
}

function isBotDecision(game, decision) {
  if (!decision || typeof decision !== 'object') return false;
  const botColor = normalizedColor(game?.botColor || game?.bot_color);
  const decisionColor = normalizedColor(decision.color);
  if (botColor && decisionColor) return botColor === decisionColor;
  if (String(decision.actor || '').toLowerCase() === 'bot') return true;
  return ['engine', 'fallback', 'history-recovery'].includes(String(decision.source || ''));
}

function reviewMetadata(game, decision, outcome, execution) {
  return {
    gameId: String(game?.id || game?.gameId || game?.game_id || ''),
    roomCode: String(game?.roomCode || game?.room_code || ''),
    decisionId: String(decision?.id || ''),
    positionId: String(decision?.positionId || ''),
    stateFingerprintV2: String(decision?.stateFingerprintV2 || ''),
    outcome,
    execution,
  };
}

function insufficientReview(metadata, reason, missing = []) {
  return {
    ...metadata,
    status: 'insufficient-evidence',
    reason,
    missingEvidence: [...new Set(missing)],
    counterfactual: null,
    records: [],
    outcomeUsed: false,
  };
}

async function reviewDecision(game, decision, outcome, reviewer, options = {}) {
  const execution = executionIdentity(decision, reviewer.afterPositionKey);
  const metadata = reviewMetadata(game, decision, outcome, execution);
  const attachedReplay = replayForDecision(game, decision);
  let replayEnvelope = null;
  let replaySource = '';
  let replayGenerationFailure = null;
  const allowAttachedReplayForTests = options.allowAttachedReplayForTests === true;
  if (allowAttachedReplayForTests && attachedReplay) {
    replayEnvelope = attachedReplay;
    replaySource = 'attached-test-only';
  } else if (options.generateShadowReplay !== false) {
    const generator = options.shadowReplayGenerator || generateLongBotShadowReplay;
    const generated = await generator(game, decision, options.shadowReplayOptions || {});
    if (generated?.ok && generated.replay) {
      replayEnvelope = generated.replay;
      replaySource = 'bounded-shadow-replay';
    } else {
      replayGenerationFailure = generated || {
        reason: 'complete-counterfactual-replay-missing',
        missingEvidence: ['complete-counterfactual-replay-missing'],
      };
    }
  }
  if (!replayEnvelope && attachedReplay) {
    // An attached replay is client-controlled telemetry. It can help offline
    // diagnosis when regeneration is unavailable, but it must not carry a
    // trust declaration into learning evidence.
    replayEnvelope = {
      ...structuredClone(attachedReplay),
      learningEvidence: undefined,
      diagnosticOnly: true,
      learningEligible: false,
    };
    replaySource = 'attached-diagnostic-only';
  }
  let missing = missingReplayEvidence(decision, replayEnvelope);
  if (execution.status !== 'matched') {
    return insufficientReview(metadata, execution.reason, [execution.reason, ...missing]);
  }
  if (!replayEnvelope) {
    return insufficientReview(
      metadata,
      replayGenerationFailure?.reason || 'complete-counterfactual-replay-missing',
      replayGenerationFailure?.missingEvidence
        || [replayGenerationFailure?.reason || 'complete-counterfactual-replay-missing'],
    );
  }

  if (missing.length > 0) return insufficientReview(metadata, missing[0], missing);

  const { candidates, ...replay } = replayEnvelope;
  const result = reviewer.reviewLongBotDecision(decision, candidates, replay);
  if (!result.accepted) {
    return insufficientReview(metadata, result.reason, [result.reason]);
  }

  const scoreSemantics = String(
    replay.scoreSemantics
    || (result.scoreField === 'policyScore' ? 'policy-score' : `${result.scoreField || 'unknown'}-score`),
  );
  const trustedRecordSource = replaySource !== 'attached-diagnostic-only'
    && result.learningEligible === true;
  const records = (trustedRecordSource ? result.records : []).map(record => {
    const {
      selectedPolicyScore,
      recommendedPolicyScore,
      ...rest
    } = record;
    return {
      ...rest,
      ...(result.scoreField === 'policyScore' ? {
        selectedPolicyScore,
        recommendedPolicyScore,
      } : {}),
      selectedScore: selectedPolicyScore,
      recommendedScore: recommendedPolicyScore,
      scoreField: result.scoreField,
      scoreSemantics,
      gameId: metadata.gameId,
      roomCode: metadata.roomCode,
      executedPositionKey: execution.executedPositionKey,
      reviewComplete: true,
      candidateCoverageComplete: true,
      executionStatus: execution.status,
      candidateCount: result.candidateCount,
      uniquePositionCount: result.uniquePositionCount,
      evidenceNature: 'decision-local-counterfactual-regret',
      learningEligible: true,
      outcomeUsed: false,
    };
  });
  return {
    ...metadata,
    status: result.status,
    reason: '',
    missingEvidence: [],
    counterfactual: {
      reviewerVersion: result.reviewerVersion,
      engineVersion: result.engineVersion,
      experienceFingerprint: result.experienceFingerprint,
      stateFingerprintV2: result.stateFingerprintV2,
      scoreField: result.scoreField,
      scoreSemantics,
      replaySource,
      candidateCount: result.candidateCount,
      uniquePositionCount: result.uniquePositionCount,
      selectedPositionKey: result.selectedPositionKey,
      recommendedPositionKey: result.recommendedPositionKey,
      selectedScore: result.selectedPolicyScore,
      recommendedScore: result.recommendedPolicyScore,
      ...(result.scoreField === 'policyScore' ? {
        selectedPolicyScore: result.selectedPolicyScore,
        recommendedPolicyScore: result.recommendedPolicyScore,
      } : {}),
      regret: result.regret,
      regretLcb: result.regretLcb,
      categories: result.categories,
      learningEligible: result.learningEligible === true && trustedRecordSource,
      learningIneligibleReason: trustedRecordSource
        ? ''
        : result.learningIneligibleReason || 'untrusted-replay-source',
      diagnosticOnly: !trustedRecordSource,
      replayGenerationFailure: replayGenerationFailure?.reason || '',
    },
    records,
    outcomeUsed: false,
  };
}

async function analyzeTrainingDocuments(documents, options = {}) {
  const reviewer = options.reviewer || await loadReviewer();
  const lossesOnly = options.lossesOnly !== false;
  const games = collectGames(documents);
  const reviews = [];
  const causalRecords = [];
  const summary = {
    gamesSeen: games.length,
    lossGamesSeen: 0,
    winGamesSkipped: 0,
    unknownOutcomeGames: 0,
    decisionsSeen: 0,
    botDecisionsSeen: 0,
    nonBotDecisionsSkipped: 0,
    decisionsReviewed: 0,
    confirmedRegret: 0,
    diagnosticRegret: 0,
    noRegret: 0,
    insufficientEvidence: 0,
    causalRecords: 0,
  };

  for (const game of games) {
    const classification = classifyGameOutcome(game);
    if (classification === 'loss') summary.lossGamesSeen += 1;
    else if (classification === 'win' && lossesOnly) {
      summary.winGamesSkipped += 1;
      continue;
    } else if (classification === 'unknown') summary.unknownOutcomeGames += 1;

    const outcome = publicOutcome(game, classification);
    for (const decision of game.decisions || []) {
      summary.decisionsSeen += 1;
      if (!isBotDecision(game, decision)) {
        summary.nonBotDecisionsSkipped += 1;
        continue;
      }
      summary.botDecisionsSeen += 1;
      const review = await reviewDecision(game, decision, outcome, reviewer, options);
      reviews.push(review);
      if (review.status === 'insufficient-evidence') summary.insufficientEvidence += 1;
      else {
        summary.decisionsReviewed += 1;
        if (review.status === 'confirmed-regret') summary.confirmedRegret += 1;
        else if (review.status === 'diagnostic-regret') summary.diagnosticRegret += 1;
        else summary.noRegret += 1;
      }
      causalRecords.push(...review.records);
    }
  }
  summary.causalRecords = causalRecords.length;

  return {
    schema: REPORT_SCHEMA,
    reviewerVersion: reviewer.LONG_BOT_REVIEWER_VERSION,
    selection: {
      lossesOnly,
      outcomeRole: 'cohort-filter-only',
      note: 'Game outcome is never used as causal credit or blame for a decision.',
    },
    summary,
    outcomeUsed: false,
    reviews,
    records: causalRecords,
  };
}

function parseCli(argv) {
  const options = {
    input: '',
    output: '',
    lossesOnly: true,
    pretty: false,
    generateShadowReplay: true,
    shadowReplayOptions: { limits: { ...DEFAULT_SHADOW_LIMITS } },
  };
  const valueOptions = new Map([
    ['--input', 'input'],
    ['-i', 'input'],
    ['--output', 'output'],
    ['-o', 'output'],
    ['--shadow-runtime', 'runtimePath'],
    ['--shadow-max-sequences', 'maxLegalSequences'],
    ['--shadow-max-positions', 'maxUniquePositions'],
    ['--shadow-max-nodes', 'maxNodes'],
    ['--shadow-max-ms', 'maxElapsedMs'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--all-games') options.lossesOnly = false;
    else if (token === '--pretty') options.pretty = true;
    else if (token === '--no-shadow-replay') options.generateShadowReplay = false;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (valueOptions.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      index += 1;
      const target = valueOptions.get(token);
      if (target === 'input' || target === 'output') options[target] = value;
      else if (target === 'runtimePath') options.shadowReplayOptions.runtimePath = value;
      else {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) {
          throw new Error(`${token} requires a positive integer`);
        }
        options.shadowReplayOptions.limits[target] = number;
      }
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return options;
}

function helpText() {
  return [
    'Usage: node scripts/review-long-bot-losses.js --input <file|-> [options]',
    '',
    'Options:',
    '  -i, --input FILE   Training JSON/JSONL; use - for stdin',
    '  -o, --output FILE  Write report to FILE (stdout by default)',
    '      --all-games    Review wins too; outcome still is not a decision label',
    '      --no-shadow-replay       Do not regenerate; attachments stay diagnostic-only',
    '      --shadow-runtime FILE    Explicit generated long-bot runtime bundle',
    `      --shadow-max-sequences N Legal-sequence limit (default ${DEFAULT_SHADOW_LIMITS.maxLegalSequences})`,
    `      --shadow-max-positions N Unique-position limit (default ${DEFAULT_SHADOW_LIMITS.maxUniquePositions})`,
    `      --shadow-max-nodes N     Static-evaluation limit (default ${DEFAULT_SHADOW_LIMITS.maxNodes})`,
    `      --shadow-max-ms N        Per-decision elapsed limit (default ${DEFAULT_SHADOW_LIMITS.maxElapsedMs})`,
    '      --pretty       Pretty-print JSON report',
    '  -h, --help         Show this help',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (!options.input) throw new Error('--input is required');
  const text = options.input === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(path.resolve(options.input), 'utf8');
  const parsed = parseTrainingText(text, options.input);
  const report = await analyzeTrainingDocuments(parsed.documents, {
    lossesOnly: options.lossesOnly,
    generateShadowReplay: options.generateShadowReplay,
    shadowReplayOptions: options.shadowReplayOptions,
  });
  report.input = { format: parsed.format, documentCount: parsed.documents.length };
  const json = JSON.stringify(report, null, options.pretty ? 2 : 0);
  if (options.output) fs.writeFileSync(path.resolve(options.output), `${json}\n`);
  else process.stdout.write(`${json}\n`);
  return 0;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`long-bot loss review failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REPORT_SCHEMA,
  actionKey,
  analyzeTrainingDocuments,
  canonicalMoves,
  classifyGameOutcome,
  collectGames,
  executionIdentity,
  isBotDecision,
  main,
  missingReplayEvidence,
  parseCli,
  parseTrainingText,
  replayForDecision,
  reviewDecision,
};
