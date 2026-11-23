-- Exact model-only bridges. Never grants compatibility to terminal evidence.
begin;
insert into private.long_bot_board_model_source_bindings
 (playing_policy_implementation_id,source_policy_implementation_id,source_runtime_digest,scope)
select 'db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b',
 r.policy_implementation_id,r.runtime_digest,'model-advice-only-with-fresh-dice-comparison'
from private.long_bot_board_model_releases r
where (r.runtime_digest='5a0d17b50bcc9b4900ccd1e7c133f5f85fe23676b010e46f985cc799f5369146'
 and r.policy_implementation_id='2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2')
 or (r.runtime_digest='da5b3fc55b3eb36337bd6d5239a720f30016791e4aa69e157387843db4be7e69'
 and r.policy_implementation_id='7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7')
on conflict do nothing;
commit;
