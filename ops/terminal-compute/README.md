# Requested fixed terminal computations

The 15 fixed inputs stay private on the operator's host. Only their hashes,
native executable code and a result-encryption PUBLIC key are published.
`input-lock.json` commits all 3,104 endpoints before parallel computation.
Each hosted job creates a one-time RSA key and publishes only the PUBLIC key
with a GitHub build attestation. The operator verifies the exact source
commit, workflow, branch and hosted-runner attestation before encrypting a
fixed workload to that key. Only ciphertext is published on a separate input
branch. The recipient authenticates it against its one-time private key,
exact run/attempt/source identity and the precommitted input hash. No original game
archives, player metadata, production credentials or production journal
signing keys leave the operator's host.

The two code capsules are exact copies of the independently registered Linux
native executable closures, not alternate or injected outcome providers. Both
use Node 24.15.0, native v25 continuation with 24 candidate / 2 tactical / 66 node
limits, 320 plies and the original fixed 32 seed pairs. Each case uses four
processes partitioning the same 32 sample indexes. Every candidate of every
sample is still required. Computation uses the original authenticated local
checkpoint journal under an actual Linux kernel flock and root-owned code.

GitHub-hosted standard Linux runners encrypt their results using AES-256-GCM
and RSA-OAEP-SHA256 with the operator's public key. Only ciphertext and a
Sigstore build attestation are uploaded; the private decryption key remains
on the operator's host. No additional production service, route, shared
credential or write capability is installed.
The operator must verify the exact source commit, workflow and ciphertext digest
with `gh attestation verify --bundle ... --repo volzay/online-backgammon
--signer-workflow volzay/online-backgammon/.github/workflows/requested-full-rollouts.yml
--source-digest COMMIT --deny-self-hosted-runners` before decrypting or importing anything.

The private import plan remains on the production host. Import requires the
unchanged fixed manifest, the verified input and executor hashes, all 32 unique
sample indexes for every candidate, the original exact Linux native runtime,
and agreement with every already finished production endpoint. Import writes
only authenticated terminal slots under the original native journal lock.
The regular server worker must then independently replay the archive and
compute its own completion, confidence bounds and learning evidence. An
attestation or a partial result cannot by itself create a confirmed lesson.

Original jobs and archives are retained. The historical d33a reviewer remains
distinct from the currently served 7a policy. LEM uses seven proposals selected
before terminal outcomes, not fabricated historical decision telemetry.

The four expensive remaining historical cohorts can also be distributed over
the four fixed ranges [0,8), [8,16), [16,24), [24,32). The original workload,
native runtime, 32 seed pairs, candidates and private manifest stay identical.
Each range is a fragment and cannot produce confidence or enter a production
journal by itself. The operator verifies all four signed fragments and their
exact disjoint union before importing the complete original cohort. A native
server worker then computes the original full-sample result. The fragment
workflow cancels only the older duplicate compute run after all ranges succeed;
the completed artifacts and original source histories remain available.
