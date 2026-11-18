'use strict';

// Offline diagnostics only. Deliberately not part of the live evaluator: a
// larger fence coefficient changed unrelated deep race/escape decisions.
// Each threatened stack counts linearly; a safe head cannot mask a forward
// stack, and removing one checker from a tower never saturates at count five.
function routeFenceBurden(state, color) {
  if (!['white', 'dark'].includes(color) || !state?.points
    || typeof state.points !== 'object' || Array.isArray(state.points)) return null;
  const totals = { white: 0, dark: 0 };
  for (const [key, stack] of Object.entries(state.points)) {
    if (!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || !stack || Array.isArray(stack)
      || !['white', 'dark'].includes(stack.color)
      || !Number.isSafeInteger(stack.count) || stack.count < 1 || stack.count > 15) return null;
    totals[stack.color] += stack.count;
  }
  for (const side of ['white', 'dark']) {
    const off = state.off?.[side];
    const bar = state.bar?.[side] ?? 0;
    if (!Number.isSafeInteger(off) || off < 0 || off > 15 || bar !== 0
      || totals[side] + off !== 15) return null;
  }
  const opponent = color === 'white' ? 'dark' : 'white';
  const head = color === 'white' ? 24 : 12;
  const path = Array.from({ length: 24 }, (_, pos) => ((head - 1 - pos + 24) % 24) + 1);
  let burden = 0;
  for (let pos = 0; pos < 18; pos++) {
    const stack = state.points[path[pos]];
    if (stack?.color !== color) continue;
    let blocked = 0;
    for (let next = pos + 1; next <= pos + 6 && next < 18; next++) {
      if (state.points[path[next]]?.color === opponent) blocked++;
    }
    if (blocked >= 2) burden += stack.count * blocked * blocked;
  }
  return burden;
}

module.exports = { routeFenceBurden };
