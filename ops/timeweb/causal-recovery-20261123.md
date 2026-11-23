# Historical review recovery

The campaign contains 43 original failed executions. Retry grants retain their
original database snapshots, source fingerprints and completed review prefixes.
Ordinary queue jobs keep their original retry limit. Recovery changes transport,
lease renewal and scheduling; it never lowers confidence or coverage criteria.

The oldest runtime (`430a0f4e…`) cannot persist a position inside a terminal
rollout. Jobs 11 and 13 had exhausted ten slices without finishing the next
endpoint. A wire-format conversion alone cannot repair that computational stall.

`prepare-legacy-causal-resume.cjs` copies only the original 17-file executable
closure into a new immutable root and applies the existing per-ply checkpoint
patch from commit `ac943a4657fc16b4833283c1da5642075f6297e4`. The patch and its
source hashes are locked. Fourteen files, including all rules, engine sources,
weights and the built engine, remain byte-identical. The legacy cache's audited
policy binding is retained. Statistical defaults are compared exactly.

The new reviewer runtime is
`009d62ab33510b5d644afd667fc935827dfacedd89a9cc524898224d6a83a3d9`.
Its playing-policy identity remains
`fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1`.
It is review-only and does not serve advice for the current playing policy.

`verify-legacy-resume-parity.cjs` uses synthetic positions and genuine private
authenticated checkpoint files. It compares uninterrupted original execution
against forced interruptions and resumes, requiring the same winner and total
plies. Its output is explicitly non-production and cannot become a lesson.

After stopping the recovery services, apply
`supersede-legacy-recovery-20261123.sql`. It preserves the old three executions
and their journals with the explicit status `superseded`; it creates three new
same-policy executions and records the mappings in the private recovery-target
table. Old outcomes are neither relabelled nor copied into a new manifest. The
new executions recompute their own complete evidence. There are still 43 logical
targets; historical rows are not falsely marked complete.

Regenerate the private supervisor plan by joining recovery targets to their
effective jobs and live grants. Run under `nardy-worker`, with shared native
`flock`, `StateDirectoryMode=0700`, `UMask=0077` and the existing environment file.
The service-role key and all journal keys remain private on the server.

Check campaign counts through `private.long_bot_causal_recovery_targets` and
its effective jobs. Audit original sources and prefixes through the original
grants and original jobs, including superseded executions. These are separate
questions; a replacement being queued is not a completed analysis.
