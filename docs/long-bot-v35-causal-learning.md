# v35 trusted causal learning

The browser archives telemetry but cannot ingest a regret or a learned pattern.
`scripts/long-bot-causal-worker.js` claims one game through service-role-only
RPC, verifies the exact executed action (including move order), reproduces the
CURRENT frozen cold policy's selection of the exact archived ordered action,
after-state and descriptor context/action, and enumerates every legal resulting
board. Static evaluation is legality/diagnostic data only. This replay does not
attest the historical source build: old telemetry has engine/options identities,
not an original build SHA. Results and evidence explicitly label the policy role
`current-frozen-cold-re-review` and `historicalImplementationAttested: false`.
The evidence SHA and conditional terminal-outcome label belong to the current
frozen implementation, not an inferred original implementation. Historical
telemetry bytes are left unchanged; any nonmatching action fails closed.

Production jobs accept only the server-owned v25/64-candidate/480-node policy
with all nine stable production weight overrides. Reproducibility alone does
not authorize a client-selected budget or weight vector. Offline army reviews
can use an explicitly supplied `trustedTrainingPolicy` API option; row metadata
such as `provenance.trainingOnly` never grants this trust. Production claim
mode rejects that offline option. Offline weights may be omitted (the current
engine defaults equal those nine overrides) or supplied as the exact canonical
nine-field object; partial, custom or drifting weights are not accepted.

For each legal resulting board the worker plays 32 terminal continuations with
the same color-bound future dice streams and frozen policies. A censored,
illegal, incomplete, time-limited, or ply-limited continuation rejects the
whole decision cohort. The current rollout policy is v35 at 64 analysis nodes
and 24 candidates, so evidence estimates that policy's conditional terminal
win probability, not an unconditional production win-rate promise.
The default 32 samples detect only large action defects: a moderate 0.5 versus
0.7 difference will normally remain diagnostic under these conservative
bounds. Resource caps must not be used to weaken the confidence gate.

One-sided Hoeffding bounds receive `alpha/(2 * candidateCount)` each. Only a
recommended lower bound above the executed action's upper bound by more than
0.08 can create evidence. The original game's result is a loss-cohort selector,
never a decision label or an evidence weight.

State, exact action and evidence identities use SHA-256. Repeated exports of
the same exact position/action are one observation. The private ledger rejects
mixed engine generations, archive repairs invalidate old evidence, and worker
runtime digests cannot be mixed without explicit release activation.
For a known v29-v34/v35 resumed mixed ledger, exact final-game identity and
numeric coverage still have to pass. Completion preserves the finished room
but quarantines its explicit training payload (`trainingArchived: false`,
`trainingQuarantined: true`); malformed ledgers still reject. An independently
valid homogeneous ledger embedded in the final room may be automatically
archived separately. The quarantine response describes the explicit payload,
not an absolute promise about contradictory client-supplied metadata pairs.
The digest covers the full application executable closure, including the
simulator dice stream and build-binding helper, plus Node/V8 semantic versions.
Mutable imported sources or cached VM bytes cannot be labelled with newer
on-disk hashes, and a supplied frozen digest must equal the actual closure.

The builder injects a noncircular SHA-256 implementation identity over every
policy TS source, game rules, and production dispatch/weights. The worker
recomputes that identity and verifies the exact canonical generated bundle;
a retained header on a modified body is not proof. Public patterns carry this
identity and the browser requires exact equality with its own built policy.
Unbuilt modules and mismatched old tabs fail closed. Rebuild the bundle after
any policy/rules/dispatch change; no manual version bump can be forgotten.

## Consumption and limits

The public read-only RPC serves bounded credit-version 9 aggregates, with no
positive outcome reward and no Mars/Koks weighting. The browser accepts them
only from the live RPC, never from local experience or local server caches.
An immutable server-fed session snapshot is kept solely to resume the same
game policy. It is not proof of server provenance.

Until signed server experience snapshots are implemented, only games with
canonical empty frozen experience can train. Games that already used learned
patterns remain diagnostic, preventing client-controlled recursive memory from
poisoning the server. The playing engine's cold tactical safety envelope still
limits learned corrections. Corrections are exact descriptor-context/action
scope; these descriptors are bucketed, not a learned whole-game strategy.
Family, phase and wildcard transfer is disabled for the new causal format.

Resource caps are 24 unique resulting boards, 32 samples, 320 future turns and
five minutes per future-outcome processing invocation by default. Without
resume this is the entire cohort's processing window; an explicit offline or
verified server-queue journal resume gets another bounded window for the same original fixed slots.
The cumulative cohort may therefore take longer than five minutes. It never
gets new seeds, extra samples or relaxed CI/turn caps. There is no automatic
unbounded resume loop. This is not the complete child-process budget. Exceeding
a cap produces no evidence.
The trusted server's shadow replay has a separate 120-second cap, wired at the
actual replay call; the standalone diagnostic shadow CLI still defaults to
five seconds. An explicitly lower server replay cap remains enforceable. This
prevents a normal full 480/64 replay from inheriting an unusable diagnostic
deadline without relaxing the terminal-outcome or statistical gates.
The future-rollout default `cacheMode: native-cold-v1` is an optimization, not a
new outcome model. A private bounded plan LRU and terminal-suffix cache accept
only the exact audited native core/rules/bundle and a canonical empty experience
snapshot. Ordered playing-relevant native state identifies a plan; audited
irrelevant history, score, clocks, match/opening and analysis metadata are
intentionally excluded from the key. Exact color seeds and roll cursors
additionally identify a terminal suffix. Exact canonical bytes are
checked after a hash lookup. Native identity/experience drift clears the cache;
unknown future cores and injected adapters/runners bypass it. Deadline and
remaining-turn caps are checked before reuse. Every legal K × fixed N outcome
slot and the original CI gates remain required. Reused common-stream outcomes
are not additional independent samples, and future `lastDecision`/history/clock
telemetry equivalence is not claimed. `cacheMode: off` is available for parity
diagnostics and changes the worker's bound rollout configuration. Failed cohorts
now retain honest completed/required slot counts and cache diagnostics, never
partial evidence. On the exact audited cache-enabled native path, future
write-only history is projected out before each turn; only terminal winner and
total-plies parity is promised, not future telemetry/history equivalence.

## Offline durable progress

The native worker/CLI path can resume one original decision using a private
terminal journal:

```sh
node scripts/long-bot-causal-worker.js --input original-game.json --decision-index N --terminal-journal-dir /absolute/physical/private-directory --output review.json
```

Both journal flags require offline `--input`, not `--once`. The entire original
game and ledger are validated again on every run. The current cold policy must
again reproduce the exact archived ordered action/after/descriptors, and the
complete native legal set is regenerated before any saved result is used.
Bindings include exact whole-game/ledger/execution canonical bytes, original
decision index, actual C/D/full executable closure/Node/V8, selection policy,
empty XP, continuation policy/caps, ordered legal boards/actions and all fixed
color-bound seeds. The original archive is not relabelled as current-source
historical evidence. Low-level exported journal/rollout helpers alone do not
authenticate a source game; this guarantee belongs to the native worker path.

Only actually completed native terminal endpoints are committed. Each slot has
SHA-256 and a private HMAC, no-overwrite atomic commit, fsync and single-writer
fencing. Missing, conflicting or modified records fail closed. Directory and
file ownership/modes, symlink/hard-link exclusions and exact manifest preimages
are checked. The local signing key is never a browser pattern or public API
output. Reused slots are the same observations, not new independent samples.
Every original K × N slot and the unchanged confidence gates are still needed
for evidence; unfinished trajectories, timeouts and partial cohorts create no
learning credit. Source/manifest drift creates a separate cohort, not a mixed
continuation of the old one.

Normal returns/time limits release the writer lock in `finally`. A process
crash/SIGKILL may leave a stale lock: this standalone offline API has no
automatic takeover. It fails closed rather than allowing a
second writer. Existing diagnostic-only partial counts from older runs contain
no authenticated endpoint records and cannot be imported into this journal.

Production rejects offline options before queue RPCs. Its separate
`--once --production-journal-dir STATE_DIR/terminal-journal` path requires a
real Linux exclusive inherited `flock --no-fork`, immutable root-owned
executables, and the verified service-only archive claim. Exported offline
options cannot mint the worker's private production-scope capability.

## Resumable production queue v1

Apply `supabase/long-bot-causal-resume-v35.sql` after both earlier v35
migrations. `claim_long_bot_causal_review_slices` returns the exact original
archive payload-text SHA and the persisted six-field progress contract. Each
slice reviews only the next original bot-ledger index, after validating the
full original envelope and native color/actor selector types again.

The private terminal manifest additionally binds the authoritative PostgreSQL
eight-field archive text/fingerprint and immutable job ID. Separate durable
job partitions bind job/archive/release/policy identity. All legal K × fixed N
slots, cold policy reproduction, exact execution, terminal completeness and
the original CI gates remain mandatory. No old diagnostic counts are imported.

`checkpoint_long_bot_causal_review_slice` locks active release, archive and job
in that order. Finished reviews are an immutable original-index prefix. A
normal rollout timeout with authenticated nondecreasing saved-slot counts
returns to `pending`, not `complete`, and restores the successful slice's
attempt budget. It produces no evidence. Even a fully saved raw slot set
remains pending until the official statistics/CI are reconstructed. Finished
review evidence is persisted privately with progress and inserted into the
public pattern ledger only at atomic whole-original-ledger completion.
The old complete RPC is guarded against incomplete/timeout results.

Slices have a 15-minute lease and an eight-minute service hard cap. Three
crash/failure attempts, ten stalled slices or 10,240 total slices end in honest
`failed` status, not invented evidence. Runtime/journal failures never become
finished reviews. A killed service normally becomes reclaimable after its
lease expires, not immediately; successful slices are rescheduled by the
one-minute inactivity timer. Every RPC is preceded by a kernel-fence check.

Production stale-lock recovery requires the current real kernel FLOCK,
matching device/inode/PID and inherited FD/fdinfo. It validates the exact
canonical cohort manifest/lock and atomically quarantines only the old writer
lock with inode/byte verification and fsync. Keys and endpoint bytes are
preserved; HMAC validation occurs again on native journal reopen. PID-only
takeover, injected proc/fs authority, live current-owner recovery and
cross-partition reuse are rejected. A crash before manifest publication still
fails closed and requires operator investigation; it is not silently repaired.
Completed unrelated historical partitions do not exhaust the recovery scan.
Signed recursive XP remains unimplemented.

## Training orchestration

The separate training-army command freezes all policies/runtime bytes and
exports telemetry and review reports; it does not alter A/B evaluation memory.
The durable total ledger cap is 320; only bot decisions consume the 160-decision
review cap. Expired leases after the third attempt are swept to terminal
`failed` status rather than remaining falsely leased forever.

Offline army review has a separate work cap: `--review-work-decisions` defaults
to 2 and accepts 1–8. `--review-selection last` is the compatible default: it
selects the last N original bot-ledger indexes in reverse order, before any
rollout result is known. `--review-decisions` remains the
160-bot-decision validation cap; neither option truncates the original ledger.
Every selected index is reviewed in its own immutable child with the full game
envelope. The child hard cap includes the separate 120-second server shadow
replay allowance, `--review-ms` per future-outcome cohort, and 15 seconds of
orchestration/output grace: 435000ms with default rollout limits. This prevents
the outer timer from budgeting only the rollout while replay consumes part of
that time. Native work between deadline checks may still hit the finite hard
cap; this allowance is not a promise that every midgame cohort can finish.
A later hard kill cannot discard earlier completed cohorts. An incomplete
cohort is never exported as evidence.

The explicit offline curriculum `--review-selection strategic-risk` instead
prioritizes prime loss with native multiple choices (prime before ≥5 and
shrinking, or exactly four shrinking with finite positive native prime/blocking
pressure and strictly negative opponent-move-block gain; cosmetic four-point
formations do not get this extra tier). Multiple boards do not prove
preservation was optional. The four-point case fixes a measured curriculum
omission: late tier3 hints used to displace an active4→2 collapse. Next come
head-support/latent-fence/fence/gateway deterioration, then
home shuffling with outside checkers and no outside reduction, then missing or
incomplete analysis on a meaningful multiple-choice position. It uses only
archived current-generation native finite numeric features and canonical
original snapshot checker counts (white home 1–6, dark home 13–18); it does not
call an evaluator or look at future dice/outcomes. Invalid numeric fields are
ignored, never coerced; invalid snapshot counts/identity disable home-shuffle
risk. Reverse original-index ties and zero-risk positions fall back to stable
last-N order. Archived static scores, client regrets, Mars/Koks severity and
the original game's result cannot alter this decision ordering. Risk tiers
select work only: they are neither error labels nor evidence weights, and even
a suspicious forced move needs the unchanged complete paired-cohort/CI gates
before any evidence can be exported. The full original ledger is preserved.
`--workers` changes only orchestration parallelism, not the 480-node/64-candidate
playing resources, paired seeds or confidence gates. The historical four-game
strategic-risk batch used two workers to avoid oversubscribing its still-running
control checks; it did not weaken either policy's search budget and keeps its
original generator/source identities.

The trusted offline API is `reviewDecisionIndexes`; production claimed jobs
reject it and review every bot decision through their private server cursor. Full original coverage and
engine generation are validated before selecting work, using native finite
nonnegative integer counts. Only selected decision snapshots/execution are
replayed. `reviewCoverage` distinguishes requested, attempted, finished and
failed indexes, complete outcome cohorts, selection covering the whole ledger,
and all requested reviews finishing. These flags do not claim whole-game
causal confidence or independent evidence from repeated exact positions.

## Deployment

These steps deploy the resumable queue worker. The application filesystem is
read-only; systemd provides a private persistent `StateDirectory`0700 outside
ephemeral `PrivateTmp`. Installing/enabling it is not proof of useful learned
evidence, scalable midgame throughput, or 65% wins. Record actual deployment
and test results separately in `docs/long-bot-v35-audit.md`.

1. For an update, stop the old timer and service first. Do not leave an old
   process claiming work while changing its approved release. Apply
   `supabase/long-bot-strategy-v35.sql`, then
   `supabase/long-bot-causal-learning-v35.sql`, then
   `supabase/long-bot-causal-resume-v35.sql`. A clean install uses the matching
   final block in `supabase/schema.sql`.
2. Install an immutable checkout and generated runtime in
   `/opt/online-backgammon-causal-worker`. Create a non-login `nardy-worker` user
   that can read this checkout. Verify that **`/usr/bin/node`**, the exact binary
   in the service unit, is Node.js 24 or newer; a different `node` from PATH or
   nvm is not a substitute for this check.
3. Place `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
   `/etc/online-backgammon/long-bot-causal-worker.env`, root-owned0600, loaded
   by systemd before changing to the unprivileged service account. The
   root-only installer reads the existing gateway key without displaying it.
   Never copy this file/key to GitHub Pages.
4. Install the service/timer from `ops/timeweb/`, but keep both stopped until
   explicit release activation. From the unit's working directory, compute the
   release identity as the service user with that exact binary:

   ```sh
   cd /opt/online-backgammon-causal-worker
   sudo -u nardy-worker /usr/bin/node -e "const w = require('./scripts/long-bot-causal-worker.js'); console.log(JSON.stringify({node: process.version, v8: process.versions.v8, runtimeDigest: w.runtimeDigest(), policyImplementationId: w.policyImplementationId()}));"
   ```

   Record this output alongside the immutable source manifest. The digest binds
   the actual Node/V8 and source bytes; a digest computed on a development Mac
   is not an approval for a different production installation. This command
   does not need, read, or print the service-role key.
5. Explicitly call the service-only
   `activate_long_bot_causal_release` RPC with reviewer version, runtime digest,
   and policy implementation SHA from step 4. Confirm that the active approved
   pair is exactly that deployment; do not bootstrap approval from a completed
   result or attach a new policy SHA to an old digest. Historical evidence must
   retain its original release identity.
6. Only now enable the timer. It claims one bounded original-decision slice
   at a time under the one global kernel writer lock. Verify queue progress,
   private evidence counts, and the public v9 response
   before publishing the matching frontend. No service-role secret belongs in
   browser code or runtime configuration.

The files alone do not start production learning. Applying the migration and
installing/enabling the trusted worker are required operational steps.

The approved release registry binds a worker digest permanently to its original
reviewer and policy SHA. Claim sends the worker's verified installed digest and
verifies the returned release plus the SHA of the exact eight-field server
archive payload before doing work. Completion carries that archive fingerprint;
repaired archives invalidate prior evidence without overwriting it. Jobs and
evidence are separate for each release/archive revision, so a new release can
review the same game without rebranding old results. Unknown legacy identities
stay quarantined, and rejected results cannot bootstrap release approval.
Public patterns use the original stored policy SHA, never a new label taken
from the active release. Claim, completion, and archive mutation use consistent
archive-before-job locking; this is operational safety, not learning evidence.
Approved claims also repair a missed activation/archive enqueue in bounded
archive-first housekeeping (at most 16 native current-release/current-source
archives, `SHARE/SKIP LOCKED`, `ON CONFLICT DO NOTHING`). This never resets a
completed/rejected/failed job or assigns guessed identities to legacy history.
