-- Stop the timer and let its current worker checkpoint/exit first.
-- Reuse verified INPUT positions with their original classifier identity.
-- No old model receipt, lesson, cursor or terminal proof is re-labelled.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='40s';
do $$ begin
 if not exists(select 1 from private.long_bot_training_library_releases where enabled
  and runtime_digest='3834ce78002a7c31edb9f45bcd371116ef4273153f16aacad17c4917dbd2781c')
  or exists(select 1 from private.long_bot_training_library where runtime_digest='3834ce78002a7c31edb9f45bcd371116ef4273153f16aacad17c4917dbd2781c'and lease_until>now())
 then raise exception 'Previous library worker must checkpoint and exit';end if;
end $$;
insert into private.long_bot_board_model_releases(runtime_digest,policy_implementation_id,max_root_positions)
 values('f10fda9564e1a428f24963c71277a0ab4a0b7f72065cfbd4b5ebb09ff028a8a1',
 'db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b',256);
insert into private.long_bot_training_library_releases values('f10fda9564e1a428f24963c71277a0ab4a0b7f72065cfbd4b5ebb09ff028a8a1',false);
insert into private.long_bot_training_library(game_id,fingerprint,runtime_digest,classification_status,classification,turns)
select q.game_id,q.fingerprint,'f10fda9564e1a428f24963c71277a0ab4a0b7f72065cfbd4b5ebb09ff028a8a1',
 q.classification_status,q.classification||jsonb_build_object('reusedClassificationRuntime',q.runtime_digest),q.turns
from private.long_bot_training_library q join private.long_bot_training_source_heads h
 on h.game_id=q.game_id and h.fingerprint=q.fingerprint
where q.runtime_digest='3834ce78002a7c31edb9f45bcd371116ef4273153f16aacad17c4917dbd2781c'
 and q.classification_status<>'pending' and coalesce(q.classification->>'reason','')<>'source-result-mismatch';
update private.long_bot_training_library_releases set enabled=false where enabled;
update private.long_bot_training_library_releases set enabled=true
 where runtime_digest='f10fda9564e1a428f24963c71277a0ab4a0b7f72065cfbd4b5ebb09ff028a8a1';
do $$ declare g public.bot_training_games;begin
 for g in select * from public.bot_training_games where difficulty='hard' and final_state->>'variant'='long'
 loop perform private.sync_long_bot_training_library(g);end loop;
end $$;
commit;
