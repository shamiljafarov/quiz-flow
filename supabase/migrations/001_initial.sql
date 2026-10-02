create table public.quizzes(id uuid primary key,teacher_id uuid not null references auth.users(id) on delete cascade,title text not null,slug text unique not null,status text not null default 'draft' check(status in ('draft','published','closed')),current_version integer not null default 1,created_at timestamptz default now(),updated_at timestamptz default now());
create table public.quiz_versions(quiz_id uuid references public.quizzes(id) on delete cascade,version integer not null,data jsonb not null,created_at timestamptz default now(),primary key(quiz_id,version));
create table public.attempts(id uuid primary key,quiz_id uuid references public.quizzes(id) on delete cascade,version integer not null,first_name text not null,last_name text not null,correct integer not null,incorrect integer not null,unanswered integer not null,earned integer not null,maximum integer not null,percentage numeric(6,2) not null,responses jsonb not null,submitted_at timestamptz default now(),foreign key(quiz_id,version) references public.quiz_versions(quiz_id,version));
create index quizzes_teacher_idx on public.quizzes(teacher_id,created_at desc);create index attempts_quiz_idx on public.attempts(quiz_id,submitted_at desc);
alter table public.quizzes enable row level security;alter table public.quiz_versions enable row level security;alter table public.attempts enable row level security;
revoke all on public.quizzes,public.quiz_versions,public.attempts from anon,authenticated;
create function public.save_quiz(p_id uuid,p_teacher uuid,p_slug text,p_data jsonb) returns void language plpgsql security invoker set search_path=public as $$
declare v integer;
begin
 if exists(select 1 from quizzes where id=p_id and teacher_id<>p_teacher) then raise exception 'Forbidden';end if;
 insert into quizzes(id,teacher_id,slug,title) values(p_id,p_teacher,p_slug,p_data->>'title') on conflict(id) do update set title=excluded.title,updated_at=now(),current_version=quizzes.current_version+1,status='draft';
 select current_version into v from quizzes where id=p_id;
 insert into quiz_versions(quiz_id,version,data) values(p_id,v,p_data);
end $$;
create function public.submit_quiz(p_slug text,p_version integer,p_first text,p_last text,p_submission uuid,p_answers jsonb) returns jsonb language plpgsql security invoker set search_path=public as $$
declare q quizzes%rowtype; d jsonb; item jsonb; selected text; correct_id text; points integer; good integer:=0; bad integer:=0; missing integer:=0; earned_points integer:=0; max_points integer:=0; detail jsonb:='[]'::jsonb; result attempts%rowtype;
begin
 select * into q from quizzes where slug=p_slug for share;
 if not found then raise exception 'Тест не найден';end if;
 if exists(select 1 from attempts where id=p_submission and quiz_id=q.id) then select * into result from attempts where id=p_submission;return jsonb_build_object('ok',true,'id',result.id,'earned',result.earned,'maximum',result.maximum,'percentage',result.percentage,'duplicate',true);end if;
 if q.status<>'published' or q.current_version<>p_version then raise exception 'Тест закрыт или версия изменилась. Обновите страницу.';end if;
 select data into d from quiz_versions where quiz_id=q.id and version=p_version;
 for item in select value from jsonb_array_elements(d->'questions') loop
 points=(item->>'points')::integer;correct_id=item->>'correctOptionId';selected=p_answers->>(item->>'id');max_points=max_points+points;
 if selected is null or not exists(select 1 from jsonb_array_elements(item->'options') opt where opt->>'id'=selected) then selected=null;missing=missing+1;
 elsif selected=correct_id then good=good+1;earned_points=earned_points+points;
 else bad=bad+1;end if;
 detail=detail||jsonb_build_array(jsonb_build_object('questionId',item->>'id','selectedOptionId',selected,'correctOptionId',correct_id,'isCorrect',coalesce(selected=correct_id,false),'points',case when selected=correct_id then points else 0 end,'maxPoints',points));
 end loop;
 insert into attempts(id,quiz_id,version,first_name,last_name,correct,incorrect,unanswered,earned,maximum,percentage,responses) values(p_submission,q.id,p_version,trim(p_first),trim(p_last),good,bad,missing,earned_points,max_points,case when max_points>0 then round(100.0*earned_points/max_points,2) else 0 end,detail) on conflict(id) do nothing;
 select * into result from attempts where id=p_submission and quiz_id=q.id;
 if not found then raise exception 'Идентификатор отправки уже использован';end if;
 return jsonb_build_object('ok',true,'id',result.id,'earned',result.earned,'maximum',result.maximum,'percentage',result.percentage,'correct',result.correct,'incorrect',result.incorrect);
end $$;
revoke all on function public.save_quiz(uuid,uuid,text,jsonb),public.submit_quiz(text,integer,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_quiz(uuid,uuid,text,jsonb),public.submit_quiz(text,integer,text,text,uuid,jsonb) to service_role;
