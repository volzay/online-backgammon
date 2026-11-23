\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create temporary table recovery_expected(job_id bigint,runtime_digest text,fingerprint text,worker_id text)on commit drop;
insert into recovery_expected values
(11,'430a0f4ea942c2282b8529fcf39fe9347194d1124432b3dc8b4d0fad25594a2a','346d91ca9a6df58bb8d1f46bcc764b9d14349ac4ad906922be05607273b2387b','long-recovery-11-22034581-bc95-4599-a2fb-a7dbee3db2e4'),
(12,'430a0f4ea942c2282b8529fcf39fe9347194d1124432b3dc8b4d0fad25594a2a','44214cb7b0b774b92f39e291a067e459d9d203637e3b955e351a701378d9b215','long-recovery-12-0e570711-765d-4319-8059-212a5ff1a992'),
(13,'430a0f4ea942c2282b8529fcf39fe9347194d1124432b3dc8b4d0fad25594a2a','f07d82766faf99af6d62943987d00491573c480d30b39210637e49e66df22a6a','long-recovery-13-f4df1ddc-6ca5-4d2c-8b8b-6d883f1b2548'),
(15,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','f07d82766faf99af6d62943987d00491573c480d30b39210637e49e66df22a6a','long-recovery-15-859cc7da-2d23-4f38-9a31-01749d2f31ac'),
(16,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','346d91ca9a6df58bb8d1f46bcc764b9d14349ac4ad906922be05607273b2387b','long-recovery-16-437e65a6-971b-4c4d-9989-4c71e65549f4'),
(22,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','44214cb7b0b774b92f39e291a067e459d9d203637e3b955e351a701378d9b215','long-recovery-22-cdd51143-1a74-48ff-a0d9-66d046091876'),
(23,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','86a7e6d50fa56e819a40a4e0441c9c42b7bd6b629788e3e533f75df1179fcee4','long-recovery-23-1b96f05e-f8d2-4773-9be8-0ea7a1e78314'),
(26,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','a1170572a1a59586305311fb5b77b7008a3ac25c5def541f1735ca2327e5a029','long-recovery-26-646ed9f7-ee26-4509-a7fd-11f1c5dc1222'),
(28,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','fdac47eccd144429b68517f132d58b0fb325a0acd8969ff18c4e15062379cdbf','long-recovery-28-4846105b-ac91-44d8-9c78-676f9ba2be2e'),
(29,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','bd1ab9b2bd394982deabca88913f0c7cedcb5cc5c1ada2b5acfb94aa2d730c32','long-recovery-29-943fa6ba-af86-4d6e-81df-41debeff7f8b'),
(30,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','4dfb5d258c8561fbc5865c8f60704d391d1a24093ccb5767d1ec6eabffd7ad76','long-recovery-30-b7faac1f-6252-47e5-ac19-4935531d51ca'),
(31,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','61b22652f5e9ca277dda27c400e3a6f4037ebb20d6bb7f38d9374d57ef37d903','long-recovery-31-a48722c6-736f-42de-9ed5-4a50037271af'),
(39,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','e137ffdad171386a567efad264d1e896574e75b88aed386978f4f1d7fffa6f41','long-recovery-39-4b72c31c-a966-4c55-8757-46096df0f08a'),
(40,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','08d503a29fbd2e2fc7f7853cc8a19bb66f3c5baf830ccd3553d265fe83ebd55f','long-recovery-40-c3ec3c99-c08a-49aa-8e1d-0a6d2af49f73'),
(42,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','441028fd78f7aa46bf40f97f440c2a87f770cf9f8c96c42389784e3b17861fb8','long-recovery-42-959f644e-b27d-4caf-9f09-599bb77e7e2f'),
(43,'3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7','8a378bb0d747074d52dc7c8c2ae347cad61032f0ffc5e672e3284fb7c7c62182','long-recovery-43-d996cca3-dd28-4fc0-86f2-54d1b94819dd'),
(122,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','346d91ca9a6df58bb8d1f46bcc764b9d14349ac4ad906922be05607273b2387b','long-recovery-122-3f071f10-1015-4435-befa-2db70177969d'),
(124,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','8a378bb0d747074d52dc7c8c2ae347cad61032f0ffc5e672e3284fb7c7c62182','long-recovery-124-84ac9bd7-d270-485c-8059-05191eef89d8'),
(129,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','29c6e4fe9741f836b1793795230ff3063dab96b7c7b1b611561e112b6f7d3060','long-recovery-129-b10a393d-5d09-4db4-8fc7-12e556ddc0be'),
(133,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','fdac47eccd144429b68517f132d58b0fb325a0acd8969ff18c4e15062379cdbf','long-recovery-133-3fd304f4-7d97-4bee-92c8-8f374be58a76'),
(139,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','61b22652f5e9ca277dda27c400e3a6f4037ebb20d6bb7f38d9374d57ef37d903','long-recovery-139-60121b22-ed6d-4127-aaa6-81c2458ebc64'),
(146,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','44214cb7b0b774b92f39e291a067e459d9d203637e3b955e351a701378d9b215','long-recovery-146-db5502fd-e3d9-4671-aa78-62ef1d379322'),
(177,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','229612d1ef1d25957c07b8d0b27577807a526cb4845fb41a91c07b8c2058afc1','long-recovery-177-df3de36d-a21d-4e9f-bcdb-2698fd19c885'),
(178,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','6584a18c767dc12c8a498cfcaeefc3da5789e37641c04a99aea7c47bea038f33','long-recovery-178-8b442342-f25f-4f3c-9f65-61065225b99e'),
(179,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','5996f512c21c51129421bd4971af79d66c5ae57a9ec181b7e398ed7b043ddc94','long-recovery-179-10189048-d111-4796-b9d9-f9c0013bd30a'),
(185,'434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162','e6e0f27182d76d66ab10b9720fc9546fa374c48d4d781938f41a78840c2a0950','long-recovery-185-84b4098e-93e5-462e-8dff-84226a00bb09'),
(201,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','346d91ca9a6df58bb8d1f46bcc764b9d14349ac4ad906922be05607273b2387b','long-recovery-201-79182d2c-b06e-4fd5-a0e8-9d17cb11b7cb'),
(202,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','f07d82766faf99af6d62943987d00491573c480d30b39210637e49e66df22a6a','long-recovery-202-183e92dc-d360-41e4-b129-b7ef21ab9b53'),
(204,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','229612d1ef1d25957c07b8d0b27577807a526cb4845fb41a91c07b8c2058afc1','long-recovery-204-f99319c9-8351-4418-b1d7-834071c492ce'),
(210,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','e6e0f27182d76d66ab10b9720fc9546fa374c48d4d781938f41a78840c2a0950','long-recovery-210-56ace0bd-05ab-4db2-b79e-543b66ccb02d'),
(212,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','29c6e4fe9741f836b1793795230ff3063dab96b7c7b1b611561e112b6f7d3060','long-recovery-212-15a9e391-da34-4b65-97b8-e8dbc1369acb'),
(215,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','fdac47eccd144429b68517f132d58b0fb325a0acd8969ff18c4e15062379cdbf','long-recovery-215-cf02cda1-cf5f-4a4f-bd66-929c2dfa16ce'),
(218,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','5321c099c2b508cf70a24333be3e421f7eecfdaa1aa1a5eb444ebe7ce08fe55a','long-recovery-218-7dca466d-6390-4749-a529-9adab5d7af0d'),
(222,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','b1629d0ed8621f891c064261345fa4660097f55056cc4e75edbf153b3ad1d1fc','long-recovery-222-d75d856f-57b4-4e20-a20b-ca2dac5b7832'),
(231,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','44214cb7b0b774b92f39e291a067e459d9d203637e3b955e351a701378d9b215','long-recovery-231-ad094ffc-178a-4fb3-8bd4-06a2c855874e'),
(235,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','61b22652f5e9ca277dda27c400e3a6f4037ebb20d6bb7f38d9374d57ef37d903','long-recovery-235-e0417e1d-2559-41ac-bff4-aecf63500ac5'),
(236,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','8a378bb0d747074d52dc7c8c2ae347cad61032f0ffc5e672e3284fb7c7c62182','long-recovery-236-c899197e-7926-421b-918b-77943398e3c5'),
(244,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','0e2354d41bc31626085b4ce1d2c69e3432f335e58484b93ecdad713431f1a6ce','long-recovery-244-8bc37fe6-1cd8-42b4-8868-66099406c313'),
(245,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','795b979e8c4eaaf47997e7e8b6487eb07748866d29b3f04ef1b9e612f0c2bf29','long-recovery-245-faafb8ae-5f06-4fe5-b11b-8c4a71ec66a8'),
(253,'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb','0f9619a97a951c67992dd708d71530f6ee9b3609c18d2e5814d6bfde4772656b','long-recovery-253-b60e6328-ba12-4468-80ab-92fae98bbb5a'),
(282,'e1d4fe1bfc0fd04dbbad797ef2f4c7eb05509d0923d9d8449f9d313941d6e967','101f5a0a3157b8d496a604d54d66de6b9f795de51d4928bee43cdee062348390','long-recovery-282-adc863b0-23a9-42a5-9176-30ad59ac6bc4'),
(292,'e1d4fe1bfc0fd04dbbad797ef2f4c7eb05509d0923d9d8449f9d313941d6e967','bd1ab9b2bd394982deabca88913f0c7cedcb5cc5c1ada2b5acfb94aa2d730c32','long-recovery-292-31b5dc5f-d1ff-43c8-8be4-18c0f1e6d7a3'),
(295,'e1d4fe1bfc0fd04dbbad797ef2f4c7eb05509d0923d9d8449f9d313941d6e967','5321c099c2b508cf70a24333be3e421f7eecfdaa1aa1a5eb444ebe7ce08fe55a','long-recovery-295-00edb00c-eedb-451c-8072-e672030a00d6');
do $$declare recovery_row record;active_before text;begin
 select runtime_digest into active_before from private.long_bot_causal_serving_runtime();
 if(select count(*)from recovery_expected)<>43 then raise exception 'Exactly the requested 43 jobs required';end if;
 for recovery_row in select e.*,j.status,j.invalidated_at,j.archive_fingerprint,j.runtime_digest actual_runtime,
  private.long_bot_causal_archive_fingerprint(g)actual_fingerprint from recovery_expected e
  join private.long_bot_causal_review_jobs j on j.id=e.job_id join public.bot_training_games g on g.id=j.training_game_id
 loop
  if recovery_row.status<>'failed' or recovery_row.invalidated_at is not null or recovery_row.archive_fingerprint<>recovery_row.fingerprint
   or recovery_row.actual_fingerprint<>recovery_row.fingerprint or recovery_row.actual_runtime<>recovery_row.runtime_digest
  then raise exception 'Recovery source or status changed for %',recovery_row.job_id;end if;
 end loop;
 insert into private.long_bot_causal_recovery_grants(job_id,worker_id,runtime_digest,archive_fingerprint,before_snapshot,expires_at)
 select j.id,e.worker_id,j.runtime_digest,j.archive_fingerprint,to_jsonb(j),now()+interval '14 days'
 from recovery_expected e join private.long_bot_causal_review_jobs j on j.id=e.job_id;
 insert into private.long_bot_causal_policy_routes(runtime_digest,policy_implementation_id,reviewer_version,
  enabled,serves_patterns,accept_completed_since,accept_completed_before,require_explicit_policy_identity)
 select r.runtime_digest,r.policy_implementation_id,r.reviewer_version,true,false,
  min(g.completed_at)-interval '1 second',max(g.completed_at)+interval '1 second',false
 from private.long_bot_causal_releases r join recovery_expected e on e.runtime_digest=r.runtime_digest
 join private.long_bot_causal_review_jobs j on j.id=e.job_id join public.bot_training_games g on g.id=j.training_game_id
 group by r.runtime_digest,r.policy_implementation_id,r.reviewer_version;
 insert into private.long_bot_requested_review_scopes(worker_id,runtime_digest,job_id)
 select worker_id,runtime_digest,job_id from private.long_bot_causal_recovery_grants;
 update private.long_bot_causal_review_jobs j set status='pending',available_at=now(),lease_owner=null,lease_until=null,
  -- Only the operational stall counter receives one audited recovery epoch.
  -- Full reviews, slice totals, outcome counters and checkpoint hashes stay original.
  progress=case when j.progress->>'stalledSlices'='10' then jsonb_set(j.progress,'{stalledSlices}','0')else j.progress end,
  last_error=null,updated_at=now()
 from recovery_expected e where j.id=e.job_id;
 if(select runtime_digest from private.long_bot_causal_serving_runtime())is distinct from active_before
 then raise exception 'Serving policy changed during historical recovery';end if;
end$$;
commit;
