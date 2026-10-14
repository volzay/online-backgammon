const test = require('node:test');
const assert = require('node:assert/strict');

test('start-zone escape reservation receives deep analysis at engine priority 2.5', async () => {
  const { selectDeepCandidates, MAX_TACTICAL_CANDIDATES } = await import(
    '../bot-engine/long/analysis.ts'
  );
  const accumulator = (id, score, reservationKey) => ({
    candidate: {
      id,
      score,
      features: reservationKey ? { [reservationKey]: 1 } : {},
      tactical: { worstImpact: 0 },
    },
  });
  const ranked = [
    accumulator('leader', 100),
    accumulator('runner-up', 90),
    accumulator('fence', 80, 'fenceEscapeTacticalReservation'),
    accumulator('start-zone', 70, 'startZoneEscapeTacticalReservation'),
    accumulator('route', 60, 'routeContinuityTacticalReservation'),
  ];

  assert.equal(MAX_TACTICAL_CANDIDATES, 4);
  assert.deepEqual(
    selectDeepCandidates(ranked).map(item => item.candidate.id),
    ['route', 'start-zone', 'fence', 'leader'],
  );
  assert.deepEqual(ranked.map(item => item.candidate.id),
    ['leader', 'runner-up', 'fence', 'start-zone', 'route']);
});
