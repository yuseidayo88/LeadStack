-- Durable cancellation for one short discovery HTTP chunk. No background worker,
-- provider secrets, CRM imports, or candidate deletion are introduced.
create table private.discovery_scan_runs (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 run_id uuid not null,
 user_id uuid not null references auth.users(id) on delete cascade,
 issued_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 retain_until timestamptz not null default clock_timestamp()+interval '10 minutes',
 status text not null check(status in ('active','cancelled','finished')),
 began boolean not null default false,
 detail_count integer not null default 0 check(detail_count between 0 and 5),
 search_count integer not null default 0 check(search_count between 0 and 2),
 commit_count integer not null default 0 check(commit_count between 0 and 5 and commit_count<=detail_count),
 saved_count integer not null default 0 check(saved_count between 0 and 5 and saved_count<=commit_count),
 primary key(organization_id,run_id)
);
alter table private.discovery_scan_runs enable row level security;
revoke all on private.discovery_scan_runs from public,anon,authenticated;

create function private.discovery_scan_state(r private.discovery_scan_runs) returns jsonb
language sql volatile security invoker set search_path='' as $$
 select jsonb_build_object('run_id',r.run_id,'status',case
  when r.status='active' and r.expires_at<=clock_timestamp() then 'expired' else r.status end,
  'expires_at',r.expires_at,'detail_count',r.detail_count,'search_count',r.search_count,'saved_count',r.saved_count);
$$;
revoke all on function private.discovery_scan_state(private.discovery_scan_runs) from public,anon,authenticated;

create function private.require_discovery_scan_writer(org uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null or not private.session_active()
  or coalesce(private.org_role(org),'') not in ('owner','admin','sales') then
  raise exception 'Forbidden' using errcode='42501';
 end if;
 return auth.uid();
end;
$$;
revoke all on function private.require_discovery_scan_writer(uuid) from public,anon,authenticated;

create function private.start_discovery_scan_run(org uuid,run_id uuid,issued_at timestamptz,deadline_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare actor uuid; r private.discovery_scan_runs; t timestamptz;
begin
 actor:=private.require_discovery_scan_writer(org);
 if run_id is null or issued_at is null or not isfinite(issued_at)
  or (deadline_at is not null and not isfinite(deadline_at)) then
  raise exception 'Invalid scan run' using errcode='22023';
 end if;
 -- Org lock precedes row locks everywhere that inserts/supersedes run records.
 perform pg_advisory_xact_lock(hashtextextended('discovery_scan:'||org::text,0));
 t:=clock_timestamp();
 if issued_at<t-interval '120 seconds' or issued_at>t+interval '30 seconds'
  or issued_at+interval '25 seconds'<=t
  or (deadline_at is not null and deadline_at<=t) then
  raise exception 'Scan request expired' using errcode='22023';
 end if;
 select * into r from private.discovery_scan_runs s
  where s.organization_id=org and s.run_id=start_discovery_scan_run.run_id for update;
 if found then
  if r.user_id<>actor then raise exception 'Forbidden' using errcode='42501'; end if;
  return private.discovery_scan_state(r)||jsonb_build_object('started',false);
 end if;
 -- Expired tombstones may be removed only after every valid delayed start is
 -- already too old. Never evict a fresh tombstone to make room for another run.
 delete from private.discovery_scan_runs where organization_id=org and retain_until<=t;
 if (select count(*) from private.discovery_scan_runs where organization_id=org)>=64 then
  raise exception 'Scan run limit reached' using errcode='P0429';
 end if;
 -- A delayed older request must never supersede a newer run or restart work
 -- after a newer terminal request. Equal issuance times also fail closed.
 if exists(select 1 from private.discovery_scan_runs s where s.organization_id=org and s.began and s.issued_at>=start_discovery_scan_run.issued_at) then
  insert into private.discovery_scan_runs(organization_id,run_id,user_id,issued_at,created_at,expires_at,retain_until,status)
   values(org,run_id,actor,issued_at,t,t,t+interval '10 minutes','cancelled') returning * into r;
  return private.discovery_scan_state(r)||jsonb_build_object('started',false);
 end if;
 update private.discovery_scan_runs set status='cancelled' where organization_id=org and status='active';
 insert into private.discovery_scan_runs(organization_id,run_id,user_id,issued_at,created_at,expires_at,retain_until,status,began)
 values(org,run_id,actor,issued_at,t,least(t+interval '25 seconds',issued_at+interval '25 seconds',coalesce(deadline_at,t+interval '25 seconds')),t+interval '10 minutes','active',true) returning * into r;
 return private.discovery_scan_state(r)||jsonb_build_object('started',true);
end;
$$;

create function private.authorize_discovery_scan_step(org uuid,run_id uuid,kind text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare actor uuid; r private.discovery_scan_runs; state jsonb;
begin
 actor:=private.require_discovery_scan_writer(org);
 if run_id is null or kind is null or kind not in ('search','detail') then raise exception 'Invalid scan step' using errcode='22023'; end if;
 select * into r from private.discovery_scan_runs s where s.organization_id=org and s.run_id=authorize_discovery_scan_step.run_id for update;
 if not found then return jsonb_build_object('status','missing','allowed',false); end if;
 if r.user_id<>actor then raise exception 'Forbidden' using errcode='42501'; end if;
 state:=private.discovery_scan_state(r);
 if state->>'status'<>'active' then return state||jsonb_build_object('allowed',false); end if;
 if (kind='detail' and r.detail_count>=5) or (kind='search' and r.search_count>=2) then
  return state||jsonb_build_object('status','chunk_limit','allowed',false);
 end if;
 update private.discovery_scan_runs s set detail_count=s.detail_count+case when kind='detail' then 1 else 0 end,
 search_count=s.search_count+case when kind='search' then 1 else 0 end
 where s.organization_id=org and s.run_id=authorize_discovery_scan_step.run_id returning * into r;
 return private.discovery_scan_state(r)||jsonb_build_object('allowed',true);
end;
$$;

create function private.commit_discovery_scan_candidate(org uuid,run_id uuid,candidate jsonb,expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare actor uuid; r private.discovery_scan_runs; state jsonb; incoming public.company_candidates;
 existing public.company_candidates; result public.company_candidates; did_save boolean:=false;
begin
 actor:=private.require_discovery_scan_writer(org);
 if run_id is null then raise exception 'Invalid scan run' using errcode='22023'; end if;
 select * into r from private.discovery_scan_runs s where s.organization_id=org and s.run_id=commit_discovery_scan_candidate.run_id for update;
 if not found then return jsonb_build_object('status','missing','row',null,'saved',false); end if;
 if r.user_id<>actor then raise exception 'Forbidden' using errcode='42501'; end if;
 state:=private.discovery_scan_state(r);
 if state->>'status'<>'active' then return jsonb_build_object('status',state->>'status','row',null,'saved',false); end if;
 if r.commit_count>=r.detail_count or r.commit_count>=5 then
  return jsonb_build_object('status','chunk_limit','row',null,'saved',false);
 end if;
 -- Provider writes cannot change IDs, organization, phone, CRM links, or supply
 -- enrichment results. Column constraints still validate every accepted value.
 if jsonb_typeof(candidate) is distinct from 'object' or octet_length(candidate::text)>40000
  or exists(select 1 from jsonb_object_keys(candidate) k where k not in
   ('corporate_number','name','prefecture_code','prefecture','location','industry_codes','industry_labels',
    'website_url','employee_number','source_updated_at','fetched_at','provenance')) then
  raise exception 'Invalid candidate fields' using errcode='22023';
 end if;
 incoming:=jsonb_populate_record(null::public.company_candidates,candidate);
 if incoming.corporate_number is null or incoming.name is null or incoming.fetched_at is null
  or incoming.provenance is null or incoming.industry_codes is null or incoming.industry_labels is null then
  raise exception 'Missing candidate fields' using errcode='22023';
 end if;
 select * into existing from public.company_candidates c where c.organization_id=org and c.corporate_number=incoming.corporate_number for update;
 -- Recheck after waiting on a concurrent manual update. Expired work cannot
 -- write simply because it acquired the run lock before its lease expired.
 if r.expires_at<=clock_timestamp() then return jsonb_build_object('status','expired','row',null,'saved',false); end if;
 if found then
  result:=existing;
  if expected_updated_at is not null and existing.updated_at=expected_updated_at then
   update public.company_candidates c set name=incoming.name,prefecture_code=incoming.prefecture_code,
    prefecture=incoming.prefecture,location=incoming.location,industry_codes=incoming.industry_codes,
    industry_labels=incoming.industry_labels,website_url=incoming.website_url,employee_number=incoming.employee_number,
    source_updated_at=incoming.source_updated_at,fetched_at=incoming.fetched_at,provenance=incoming.provenance,
    enrichment_result=case when existing.website_url is distinct from incoming.website_url then null else existing.enrichment_result end,
    enrichment_status=case when existing.website_url is distinct from incoming.website_url then null else existing.enrichment_status end,
    enrichment_checked_at=case when existing.website_url is distinct from incoming.website_url then null else existing.enrichment_checked_at end,
    enrichment_error=case when existing.website_url is distinct from incoming.website_url then null else existing.enrichment_error end
   where c.organization_id=org and c.id=existing.id returning * into result;
   did_save:=true;
  end if;
 elsif expected_updated_at is null then
  insert into public.company_candidates(organization_id,corporate_number,name,prefecture_code,prefecture,location,
   industry_codes,industry_labels,website_url,employee_number,source_updated_at,fetched_at,provenance)
  values(org,incoming.corporate_number,incoming.name,incoming.prefecture_code,incoming.prefecture,incoming.location,
   incoming.industry_codes,incoming.industry_labels,incoming.website_url,incoming.employee_number,incoming.source_updated_at,
   incoming.fetched_at,incoming.provenance) on conflict(organization_id,corporate_number) do nothing returning * into result;
  did_save:=found;
  if not did_save then
   select * into result from public.company_candidates c where c.organization_id=org and c.corporate_number=incoming.corporate_number;
  end if;
 end if;
 -- Candidate quota/unique-index locks can delay the INSERT itself. Roll back
 -- the complete RPC transaction if the lease ran out while waiting there.
 if r.expires_at<=clock_timestamp() then raise exception 'Scan lease expired' using errcode='P0409'; end if;
 update private.discovery_scan_runs s set commit_count=s.commit_count+1,saved_count=s.saved_count+case when did_save then 1 else 0 end
  where s.organization_id=org and s.run_id=commit_discovery_scan_candidate.run_id;
 return jsonb_build_object('status','active','row',case when result.id is null then null else to_jsonb(result) end,'saved',did_save);
end;
$$;

create function private.cancel_discovery_scan_run(org uuid,run_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare actor uuid; r private.discovery_scan_runs; t timestamptz;
begin
 actor:=private.require_discovery_scan_writer(org);
 if run_id is null then raise exception 'Invalid scan run' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('discovery_scan:'||org::text,0));
 select * into r from private.discovery_scan_runs s where s.organization_id=org and s.run_id=cancel_discovery_scan_run.run_id for update;
 if found then
  if r.user_id<>actor then raise exception 'Forbidden' using errcode='42501'; end if;
  update private.discovery_scan_runs s set status=case when s.status='finished' then s.status else 'cancelled' end
   where s.organization_id=org and s.run_id=cancel_discovery_scan_run.run_id returning * into r;
 else
  t:=clock_timestamp();
  delete from private.discovery_scan_runs where organization_id=org and retain_until<=t;
  if (select count(*) from private.discovery_scan_runs where organization_id=org)>=64 then
   raise exception 'Scan run limit reached' using errcode='P0429';
  end if;
  insert into private.discovery_scan_runs(organization_id,run_id,user_id,issued_at,created_at,expires_at,retain_until,status)
   values(org,run_id,actor,t,t,t,t+interval '10 minutes','cancelled') returning * into r;
 end if;
 -- This acknowledgement holds the same row lock as every scan commit. Any
 -- already committed row precedes the acknowledgement; no later scan can save.
 return private.discovery_scan_state(r);
end;
$$;

create function private.finish_discovery_scan_run(org uuid,run_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare actor uuid; r private.discovery_scan_runs;
begin
 actor:=private.require_discovery_scan_writer(org);
 if run_id is null then raise exception 'Invalid scan run' using errcode='22023'; end if;
 select * into r from private.discovery_scan_runs s where s.organization_id=org and s.run_id=finish_discovery_scan_run.run_id for update;
 if not found then return jsonb_build_object('status','missing'); end if;
 if r.user_id<>actor then raise exception 'Forbidden' using errcode='42501'; end if;
 update private.discovery_scan_runs s set status=case when s.status='active' then 'finished' else s.status end
  where s.organization_id=org and s.run_id=finish_discovery_scan_run.run_id returning * into r;
 return private.discovery_scan_state(r);
end;
$$;

create function public.start_discovery_scan_run(org uuid,run_id uuid,issued_at timestamptz,deadline_at timestamptz default null) returns jsonb
language sql security invoker set search_path='' as $$ select private.start_discovery_scan_run(org,run_id,issued_at,deadline_at); $$;
create function public.authorize_discovery_scan_step(org uuid,run_id uuid,kind text) returns jsonb
language sql security invoker set search_path='' as $$ select private.authorize_discovery_scan_step(org,run_id,kind); $$;
create function public.commit_discovery_scan_candidate(org uuid,run_id uuid,candidate jsonb,expected_updated_at timestamptz default null) returns jsonb
language sql security invoker set search_path='' as $$ select private.commit_discovery_scan_candidate(org,run_id,candidate,expected_updated_at); $$;
create function public.cancel_discovery_scan_run(org uuid,run_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.cancel_discovery_scan_run(org,run_id); $$;
create function public.finish_discovery_scan_run(org uuid,run_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.finish_discovery_scan_run(org,run_id); $$;

revoke all on function private.start_discovery_scan_run(uuid,uuid,timestamptz,timestamptz),public.start_discovery_scan_run(uuid,uuid,timestamptz,timestamptz),
 private.authorize_discovery_scan_step(uuid,uuid,text),public.authorize_discovery_scan_step(uuid,uuid,text),
 private.commit_discovery_scan_candidate(uuid,uuid,jsonb,timestamptz),public.commit_discovery_scan_candidate(uuid,uuid,jsonb,timestamptz),
 private.cancel_discovery_scan_run(uuid,uuid),public.cancel_discovery_scan_run(uuid,uuid),
 private.finish_discovery_scan_run(uuid,uuid),public.finish_discovery_scan_run(uuid,uuid) from public,anon;
grant execute on function private.start_discovery_scan_run(uuid,uuid,timestamptz,timestamptz),public.start_discovery_scan_run(uuid,uuid,timestamptz,timestamptz),
 private.authorize_discovery_scan_step(uuid,uuid,text),public.authorize_discovery_scan_step(uuid,uuid,text),
 private.commit_discovery_scan_candidate(uuid,uuid,jsonb,timestamptz),public.commit_discovery_scan_candidate(uuid,uuid,jsonb,timestamptz),
 private.cancel_discovery_scan_run(uuid,uuid),public.cancel_discovery_scan_run(uuid,uuid),
 private.finish_discovery_scan_run(uuid,uuid),public.finish_discovery_scan_run(uuid,uuid) to authenticated;
