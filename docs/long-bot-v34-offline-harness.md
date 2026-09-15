# Long hard-bot v34 offline harness

The harness trains an experience snapshot on one deterministic seed split,
checks it on a separate validation split, and opens the holdout split only if
validation qualifies.

Inspect the frozen defaults without running games:

```sh
npm run train:long-bot-v34 -- --dry-run
```

Run the complete default suite:

```sh
npm run train:long-bot-v34 -- \
  --output reports/long-bot-v34-offline.json \
  --jobs 4
```

The companion experience artifact is written next to the report as
`reports/long-bot-v34-offline.experience.json`.

## Release checks

The default suite uses disjoint deterministic splits:

- 120 train games;
- 80 validation games;
- 400 holdout games in 200 crossed-color pairs.

Each pair reuses the physical white and dark dice streams while the candidate
and control swap colors. The holdout gate requires all of the following:

- validation passed before holdout was opened;
- configured win-rate target, default `0.68`;
- paired Wilson 95% lower bound at or above the target;
- severe-loss rate at or below `0.10`;
- at least 200 holdout pairs;
- exactly `long-analytic-v34`, experience credit version 8, one runtime
  fingerprint, and one experience fingerprint.

The v34 engine and credit generation are fixed, not CLI-overridable. The report
includes aggregate and per-result ordinary/Mars/Koks match points using weights
1/2/3. The copied experience artifact is fingerprinted again before the report
is published. Volatile wall-clock update labels are omitted from offline
experience exports so identical inputs produce identical bytes. Derived
dice-stream seeds are collision-checked across all three
splits, not only inside each simulator process. Changing any split changes the
suite fingerprint, and duplicate seeds across splits are rejected before play.

## Scope and limitations

Training currently delegates credit assignment to `NarduStrongBot.learnFromGame`.
The harness provides isolation and honest measurement; it is not itself a
counterfactual teacher. A future teacher can emit the same experience artifact
format without changing certification.

The existing long simulator's control is a profile in the current runtime, not
a frozen historical engine or a representative human population. Therefore a
passing report describes performance against that configured control only. It
must not be presented as a 68% win rate against all players.

At the default 200 pairs, a measured 68-70% result will normally not have a
Wilson lower bound of 68%. This is intentional. Increase the independent
holdout sample before making a narrow 68% population claim.

The paired Wilson diagnostic treats a split pair as `0.5` success and uses the
pair, not an individual game, as the sampling unit. Both the ordinary game-level
Wilson interval and this more conservative paired diagnostic remain in the
report.

The default holdout seeds are reproducible and source-visible. Once their result
has influenced a policy change, they are no longer an untouched holdout; advance
the suite namespace and derive a new split before the next release decision.

Evaluation seeds can run in parallel, but adaptive training is deliberately
sequential. A stopped training run currently restarts from its initial artifact;
there is no partial-chain resume because a safe resume format must also prove the
ordered input/output fingerprint chain.
