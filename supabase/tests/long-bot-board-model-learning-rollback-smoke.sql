-- Production regression: run inside BEGIN/ROLLBACK after the migration.
-- Reads the retained LEM5 board ledger; changes only isolated fixture rows.
insert into private.long_bot_board_model_releases(runtime_digest,policy_implementation_id)
values(repeat('1',64),repeat('2',64));
do $$ declare s jsonb;r jsonb; rejected boolean:=false; lessons_before bigint; patterns_before integer;begin
 select count(*)into lessons_before from private.long_bot_board_lessons;
 patterns_before:=jsonb_array_length(public.get_long_bot_experience_patterns(null));
 if has_function_privilege('anon','public.checkpoint_long_bot_board_review(uuid,text,text,text,integer,integer,jsonb)','execute')
  or has_function_privilege('authenticated','public.next_long_bot_board_review(text,text,text[])','execute')then raise exception 'Public worker access';end if;
 s:=public.next_long_bot_board_review(repeat('2',64),repeat('1',64),array['LEM5-RES8']);
 if s->>'roomCode'<>'LEM5-RES8' or s->'reviewedTurns'<>'0'::jsonb or jsonb_array_length(s#>'{finalState,history}')<>283
  or s::text like '%hostName%'then raise exception 'Invalid sanitized source';end if;
 r:=public.checkpoint_long_bot_board_review((s->>'archiveId')::uuid,s->>'fingerprint',repeat('2',64),repeat('1',64),0,42,'{"turnIndex":0,"status":"no-applicable-improvement"}');
 if r->'reviewedTurns'<>'1'::jsonb then raise exception 'Cursor not persisted';end if;
 begin perform public.checkpoint_long_bot_board_review((s->>'archiveId')::uuid,s->>'fingerprint',repeat('2',64),repeat('1',64),0,42,'{"turnIndex":0,"status":"no-applicable-improvement"}');
 exception when others then rejected:=true;end;
 if not rejected then raise exception 'Duplicate cursor accepted';end if;
 rejected:=false;
 begin perform public.checkpoint_long_bot_board_review((s->>'archiveId')::uuid,s->>'fingerprint',repeat('2',64),repeat('1',64),1,42,'{"turnIndex":1,"status":"model-reviewed","lesson":{"creditVersion":10}}');
 exception when others then rejected:=true;end;
 if not rejected then raise exception 'Unverified lesson accepted';end if;
 if (select count(*)from private.long_bot_board_lessons)<>lessons_before then raise exception 'Fixture published lesson';end if;
 if jsonb_array_length(public.get_long_bot_experience_patterns(null))<>patterns_before then raise exception 'Changed current published experience';end if;
 raise notice 'Board learning SQL rollback checks passed';
end $$;
