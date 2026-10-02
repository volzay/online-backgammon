# Long-bot final-race audit — 2026-10-02

This audit concerns the hard bot in long backgammon, not the separate short-game
bot. It is a diagnosis of archived positions and the current causal-learning
queue, not a claim of a 65% win rate.

## Named-room outcomes and review status

All 15 rooms used `long-analytic-v35` with the bot playing dark. The bot lost
14 games and won `53BD-ABWA`. The 14 losses contain 619 archived bot decisions.
Of these, 593 have native `engine` decision telemetry; 26 were reconstructed
from history only (18 in EGP9, seven in EU5L, one in MAAG), so feature-based
diagnosis cannot treat those 26 as fully observed decisions.

| Room | Bot result | Current-release loss review |
| --- | --- | --- |
| QXKM-SV6C | loss | complete |
| EU5L-7YEV | loss | complete |
| 52HK-8NS9 | loss | complete |
| VNCR-VSNT | loss | complete |
| F92F-Q6PZ | loss | complete |
| 53BD-ABWA | win | no loss-review job |
| NVHM-4R45 | loss | complete |
| HMKT-RHKK | loss | failed: `fetch failed` |
| E4TS-MA3P | loss | complete |
| EGP9-YKKB | loss | complete |
| MAAG-9R8W | loss | failed: `fetch failed` |
| ATPW-MEUV | loss | failed: `fetch failed` |
| D3VV-N2AM | loss | failed: `fetch failed` |
| P7ZF-UP4M | loss | complete |
| KUM4-8W6T | loss | complete |

The four failed jobs retained 25, 25, 25 and 14 finished reviews respectively
(in ATPW, MAAG, HMKT, D3VV order), with in-progress journal checkpoints for
two of them. These are not evidence of zero mistakes or successful learning.
The active release has **zero confirmed causal-learning evidence records**.

In the ten completed loss-review jobs, 437 bot-decision rows were recorded.
The four-slot strategic work budget skipped 372. Of the 65 attempted rows,
25 failed the decision envelope, 19 hit the rollout-position limit, four had
no archived alternatives, and one hit the legal-sequence limit. Sixteen
complete paired cohorts finished all 5,600 required terminal outcomes, but
each concluded `no-regret` under the conservative confidence criterion.
Thus a stored loss, a complete queue job, and an actual usable learned lesson
are three different states; currently only the first two have occurred.

The local worker now gives pre-connection RPC failures two bounded retries,
sets a per-RPC timeout, and does not mark a claimed job failed when a lost
response leaves its database commit uncertain. It does **not** automatically
revive the four already failed jobs: they need an identity- and
checkpoint-preserving operator recovery after the transport failure is
understood. This worker change has not been activated on production and would
require a new approved executable/runtime digest.

## Exact missed final-race decisions

- `QXKM-SV6C`, decision 37 / game roll 243, dice 6:3: bot played
  `22→19` (3), `19→13` (6), moving the last outside checker through the home
  board without taking a checker off. Its legal archived alternative was
  `22→16` (6), then `15→off` (3): same one checker brought home plus one
  immediate bear-off. The old score preferred the selected move by about
  13.85 million, largely because its obsolete blockade proxy credited the
  selected line, even though the opponent already had all checkers home.
  The production curriculum marked this decision
  `production-strategic-risk-budget-skip`, so no counterfactual review or
  lesson was produced for it.
- `F92F-Q6PZ`, decision 43, dice 1:4: bot played `20→19→15`.
  `20→16` (4), `13→off` (1) was legal and brought the same last checker home
  while bearing one off. Again the old blockade proxy dominated the better
  race action.

Across 58 late turns with 1–6 outside bot checkers, no head checker and zero
archived trap score, seven had a more race-progressive stored alternative:
three entered more checkers, two bore off more, and two avoided unnecessary
in-home movement. That broad filter alone does not prove all seven were
errors: the opponent could still interfere with five. In the 15 turns meeting
the stronger **provably contact-free** condition, the two missed bear-offs
above were the only such archive mismatches.

Other structural risk signals remain outside the proven final-race fix.
Among the 593 native decisions, 17 active-prime reductions with positive
blocking pressure occurred in 11 rooms; eight distinct decisions had a stored
alternative retaining the old prime. There were 13 head-support reductions,
four with a stored no-break alternative. `VNCR-VSNT` had a particularly severe
head bottleneck: on 17 bot turns at least four of six immediate head landings
were blocked, and on 12 turns five were blocked while 1–4 head checkers
remained. These are diagnostic risk indicators, not terminal counterfactual
proofs that a particular alternative wins.

For example, the current policy still reproduces archived `E4TS-MA3P` bot
decision 21 (`5→3` on 2, `7→3` on 4), reducing a five-point prime to four.
A legal stored prime-preserving line (`5→3`, `5→1`) exists, but it leaves a
checker in the start zone and worsens the bounded recovery estimates and
anti-Koks result-safety metric. Forcing that alternative from the prime signal
alone would be unjustified; this position needs a properly bounded terminal
comparison before receiving a new rule or a learning label.

The per-room diagnostic counts below use only the native decisions (the
second number in `native+recovered` has no feature telemetry). `P` means
active prime reduction / a stored prime-preserving preview; `H` means
head-support reduction / a stored no-break preview; `G` is gateway
deterioration; `R` is an outside-checker home shuffle with a stored
faster-progress preview. These categories overlap and are **not counts of
proven mistakes**.

| Room | Native+recovered | P | H | G | R |
| --- | ---: | ---: | ---: | ---: | ---: |
| QXKM-SV6C | 41+0 | 2/1 | 1/1 | 5 | 0 |
| EU5L-7YEV | 34+7 | 1/0 | 0/0 | 12 | 3 |
| 52HK-8NS9 | 48+0 | 2/1 | 1/0 | 7 | 0 |
| VNCR-VSNT | 43+0 | 0/0 | 4/1 | 12 | 2 |
| F92F-Q6PZ | 45+0 | 0/0 | 0/0 | 9 | 0 |
| NVHM-4R45 | 45+0 | 1/0 | 0/0 | 9 | 1 |
| HMKT-RHKK | 46+0 | 2/1 | 1/0 | 17 | 0 |
| E4TS-MA3P | 42+0 | 2/1 | 1/0 | 5 | 1 |
| EGP9-YKKB | 27+18 | 1/1 | 0/0 | 5 | 0 |
| MAAG-9R8W | 46+1 | 2/2 | 2/1 | 11 | 0 |
| ATPW-MEUV | 45+0 | 0/0 | 0/0 | 14 | 0 |
| D3VV-N2AM | 44+0 | 2/1 | 2/0 | 21 | 1 |
| P7ZF-UP4M | 46+0 | 1/0 | 0/0 | 3 | 2 |
| KUM4-8W6T | 41+0 | 1/0 | 1/1 | 9 | 2 |

## Code correction and limits

The new policy enforces a lexicographic final-race priority only when all
opponent checkers are in the opponent's home or off, all 15 bot checkers are
accounted for, the bot has no head checker, at most six bot checkers remain
outside its home, and the bot's rearmost checker has passed the opponent's
entire home-zone frontier. In that condition, no future opponent move can
block the bot's remaining route. Complete legal turns are ordered by maximum
home entries, then maximum immediate bear-offs, then minimum home-only
shuffles, then outside pip progress. Candidate prefiltering reserves a legal
entry/bear-off before analysis budget truncation. Contact positions retain
the existing tactical and defensive evaluation.

Exact archived QXKM and F92F states, mirrored colors, multi-checker entry,
and a contact counterexample are permanent regression cases in
`tests/long-bot-final-race-priority.test.js`. This is a deterministic policy
fix and teaching example, not evidence that the causal learning queue has
absorbed these losses. Since the move policy changed, its implementation SHA
must not claim compatibility with lessons from the previous policy.

## Why short-game success does not transfer automatically

The long and short bots use distinct evaluators and position rules. The long
bot's broad static blockade/prime signals can remain positive after contact
has disappeared, and its bounded tactical search and risk-selected review
budget do not cover every useful late position. Historical losses are archived,
but archive storage alone is not training. The trusted v35 mechanism publishes
a correction only after exact cold-policy replay, complete paired terminal
outcomes and a conservative confidence gate. It currently has no confirmed
published lessons for the active release, so describing it as a continuously
self-improving long-game model would be inaccurate.

Before any 65% claim, run a frozen, color-swapped, disjoint-seed benchmark at
production move budgets with enough games for a lower confidence bound above
65%, and measure performance against human opponents separately. A few named
rooms or a small diagnostic league cannot establish that threshold.

A first diagnostic screen against the immutable previous v35 release
(`31c8f3e`) used six color-swapped seed pairs, equal `v25` search budgets of
64 nodes/24 candidates, and a 320-ply cap. All 12 games completed without
integrity errors: the candidate won six and lost six (each pair split 1–1).
This is **not** a production-budget benchmark (480 nodes/64 candidates), nor
a comparison with human players. Its paired 95% Hoeffding interval is `[0, 1]`;
it cannot certify or refute a 65% true win rate. A direct v34 comparison was
correctly refused because that frozen release used different `game.js` bytes.
