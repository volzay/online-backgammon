-- Only after the immutable VPS closure has returned both exact identities.
\set ON_ERROR_STOP on
begin;
insert into private.long_bot_board_model_releases(runtime_digest,policy_implementation_id,max_root_positions)
 values('3834ce78002a7c31edb9f45bcd371116ef4273153f16aacad17c4917dbd2781c',
 'db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b',256);
insert into private.long_bot_training_library_releases(runtime_digest,enabled)
 values('3834ce78002a7c31edb9f45bcd371116ef4273153f16aacad17c4917dbd2781c',true);
do $$ declare g public.bot_training_games;begin
 for g in select * from public.bot_training_games where difficulty='hard' and final_state->>'variant'='long'
 loop perform private.sync_long_bot_training_library(g);end loop;
end $$;
commit;
