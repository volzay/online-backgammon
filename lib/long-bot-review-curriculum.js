'use strict';

// Scheduling only. The next archived board locates the preceding decision;
// neither a loss, a static score nor this hint can create learning credit.
const worker = require('../scripts/long-bot-causal-worker');

function headPressure(game, decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)
    || (game?.engine_version || game?.engineVersion) !== worker.ENGINE_VERSION
    || !worker.botDecision(decision, game) || decision.source !== 'engine'
    || decision.engineVersion !== worker.ENGINE_VERSION
    || worker.archivedOutsideCount(game, decision) === null) return null;
  const { points } = decision.stateSnapshotV2;
  const color = decision.color;
  const opponent = color === 'white' ? 'dark' : 'white';
  const head = color === 'white' ? 24 : 12;
  let maximumBlocked = 0;
  let checkers = 0;
  for (let offset = 0; offset < 6; offset += 1) {
    const point = head - offset;
    if (points[point]?.color !== color) continue;
    checkers += points[point].count;
    let blocked = 0;
    for (let die = 1; die <= 6; die += 1) {
      if (points[point - die]?.color === opponent) blocked += 1;
    }
    maximumBlocked = Math.max(maximumBlocked, blocked);
  }
  return { maximumBlocked, checkers };
}

function preThreatDecisionHints(game) {
  const decisions = worker.trainingDecisions(game);
  if (decisions.length > 320) throw new Error('review-selection-ledger-cap');
  const hints = [];
  let previous = null;
  for (const [index, decision] of decisions.entries()) {
    if (!worker.botDecision(decision, game)) continue;
    const pressure = headPressure(game, decision);
    if (pressure && previous?.pressure
      && previous.pressure.checkers > 0 && pressure.checkers > 0
      && Number.isSafeInteger(previous.decision.choiceCount) && previous.decision.choiceCount > 1
      && pressure.maximumBlocked >= 3
      && pressure.maximumBlocked > previous.pressure.maximumBlocked) {
      hints.push({ index: previous.index, triggerIndex: index,
        blockedBefore: previous.pressure.maximumBlocked, blockedAfter: pressure.maximumBlocked,
        signal: pressure.maximumBlocked === 6 ? 'before-closed-head-fence' : 'before-developing-head-fence' });
    }
    // An invalid/recovery bot row breaks adjacency. Never leap across it and
    // falsely identify an older action as the immediate predecessor.
    previous = { index, decision, pressure };
  }
  return hints;
}

module.exports = { headPressure, preThreatDecisionHints };
