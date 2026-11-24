# Expanded terminal study

This is an operator workflow, separate from the playing engine. The 15 anonymous
positions are the previously authorised inputs from LEM5-RES8, 8JPN-KUD8 and
CTNM-E43Z. No private archive histories or journal keys are published.

## Completed result: 24 November 2026

All 15 cases reached their prespecified stopping rule. The machine-readable
[study result](study-result.json) references all 37 authenticated aggregate
reports by SHA-256. Thirteen cases reached 1024 paired streams; the two earlier
futility stops reached 128 and 512. This gives 13,952 paired case-seeds and
80,768 complete native outcomes in 436 unique verified fragments.

There are **0 confirmed lessons**, **5 cases excluding the required improvement**
and **10 inconclusive cases**. Both positive lower bounds still must exceed
0.08, with the original familywise error budget and fixed looks. Inconclusive
cases remain unresolved. No expanded lesson was published as production
terminal evidence, and source policy identities remain unchanged.

Two unsigned artifact copies were excluded and replaced by signed reruns of
the same fixed ranges. A disconnected runner produced no artifact; its exact
range was also rerun. Every accepted fragment passed provenance and native
slot validation. All public aggregate report bytes match the private operator
copies, and the final confidence bounds were recomputed from their counts.

`protocol.json` and `input-lock.json` freeze the cases, controls, alternatives,
native kernels, 1024 fresh paired dice streams and fixed looks at 128, 512 and
1024 pairs **before** the new outcomes are generated. The original 32-pair
experiments remain separate. Each 32-pair fragment evaluates every prespecified
candidate using the unchanged original native rollout kernel and a private
authenticated native journal. A complete fragment is not a complete study.

Positive conclusions require both the original simultaneous Hoeffding lower
bound and paired exact lower bound to exceed 0.08. The 0.05 familywise error
budget is allocated across cases/comparisons, three looks and positive/negative
conclusions. No partial look, outcome-selected alternative, duplicate pair or
censored game can enter the analysis. A case stops negatively only when every
alternative's exact upper bound is at most 0.08. Otherwise it proceeds to the
next frozen look; the final result can honestly be inconclusive.

The push workflow on `codex/expanded-statistics-runs` reads `run-request.json`.
After the first look, requests must identify the previous completed report by
SHA-256 and contain only cases that require another look. New stage commits
change the request; the scientific protocol and workload locks stay unchanged.

Results are encrypted to the existing operator public key. On the private Linux
host, `verify-and-decrypt.cjs` requires GitHub-hosted provenance for the exact
workflow, branch and commit, then checks every native slot, runtime, fence,
seed and process receipt. `collect-artifacts.py` accepts temporary download links
from the connected GitHub app and verifies the connector's ZIP digest first.
`analyze-look.cjs` accepts only complete, verified ranges. Neither importing a
fragment nor evaluating the report publishes production evidence.

Historical proofs retain their original policy/runtime identity. Applying any
result to a different playing policy requires a separate validation; historical
results must never be relabelled as proof for the current policy.
