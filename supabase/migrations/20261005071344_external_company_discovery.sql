-- External discoveries are candidates until an explicit CRM import. Keep each
-- organization's bounded candidate cache and first-import evidence separate.
create table public.company_candidates (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 corporate_number text not null check(corporate_number ~ '^[0-9]{13}$'),
 name text not null check(length(trim(name)) between 1 and 200),
 prefecture_code text check(prefecture_code is null or prefecture_code ~ '^(0[1-9]|[1-3][0-9]|4[0-7])$'),
 prefecture text check(length(prefecture) <= 20),
 location text check(length(location) <= 2000),
 industry_codes text[] not null default '{}' check(cardinality(industry_codes) <= 100 and octet_length(industry_codes::text) <= 4000),
 industry_labels text[] not null default '{}' check(cardinality(industry_labels) <= 100 and octet_length(industry_labels::text) <= 8000),
 phone text check(length(phone) <= 100),
 website_url text check(length(website_url) <= 2048 and website_url ~ '^https?://[^[:space:]@/]+([/?#]|$)'),
 employee_number bigint check(employee_number between 0 and 2147483647),
 source_updated_at text check(length(source_updated_at)<=100),
 fetched_at timestamptz not null default now(),
 provenance jsonb not null default '{}' check(jsonb_typeof(provenance) = 'object' and octet_length(provenance::text) <= 16000),
 enrichment_status text check(enrichment_status in ('pending','complete','unavailable','failed')),
 enrichment_error text check(length(enrichment_error) <= 500),
 enrichment_result jsonb check(enrichment_result is null or (jsonb_typeof(enrichment_result)='object' and octet_length(enrichment_result::text)<=16000)),
 enrichment_checked_at timestamptz,
 company_id uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,corporate_number),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete set null(company_id)
);
create index company_candidates_filter_idx on public.company_candidates(organization_id,prefecture_code,fetched_at desc,id);
create index company_candidates_name_idx on public.company_candidates(organization_id,name,id);
create index company_candidates_company_idx on public.company_candidates(organization_id,company_id);
create index company_candidates_industry_idx on public.company_candidates using gin(industry_codes);

create table public.company_candidate_imports (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null,
 corporate_number text not null check(corporate_number ~ '^[0-9]{13}$'),
 candidate_snapshot jsonb not null check(jsonb_typeof(candidate_snapshot)='object'),
 imported_by uuid references public.profiles(id) on delete set null,
 imported_at timestamptz not null default now(),
 unique(organization_id,company_id,corporate_number),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade
);

alter table public.company_candidates enable row level security;
alter table public.company_candidate_imports enable row level security;
revoke all on public.company_candidates,public.company_candidate_imports from public,anon,authenticated;
grant select,insert,update,delete on public.company_candidates to authenticated;
grant select on public.company_candidate_imports to authenticated;
create policy tenant_read on public.company_candidates for select to authenticated
 using(organization_id in(select private.readable_organizations()));
create policy tenant_insert on public.company_candidates for insert to authenticated
 with check(private.org_role(organization_id) in ('owner','admin','sales'));
create policy tenant_update on public.company_candidates for update to authenticated
 using(private.org_role(organization_id) in ('owner','admin','sales'))
 with check(private.org_role(organization_id) in ('owner','admin','sales'));
create policy tenant_delete on public.company_candidates for delete to authenticated
 using(private.org_role(organization_id) in ('owner','admin','sales'));
create policy active_session on public.company_candidates as restrictive for all to authenticated
 using((select private.session_active())) with check((select private.session_active()));
create policy tenant_read on public.company_candidate_imports for select to authenticated
 using(organization_id in(select private.readable_organizations()));
create policy active_session on public.company_candidate_imports as restrictive for all to authenticated
 using((select private.session_active())) with check((select private.session_active()));

-- Guard direct Data API writes as well as invoker RPC writes.
create function private.guard_company_candidate() returns trigger
language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
begin
 if coalesce(private.org_role(new.organization_id),'') not in ('owner','admin','sales') then
  raise exception 'Forbidden' using errcode='42501';
 end if;
 if tg_op='UPDATE' then
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
   or new.corporate_number is distinct from old.corporate_number then
   raise exception 'Candidate identity cannot change' using errcode='23514';
  end if;

 end if;
 if new.company_id is not null and not exists(select 1 from public.companies
  where organization_id=new.organization_id and id=new.company_id and corporate_number=new.corporate_number) then
  if tg_op='UPDATE' and new.company_id is not distinct from old.company_id then
   -- CRM corporate numbers can be corrected later. Preserve the first-import
   -- snapshot, but do not retain a now-invalid link when refreshing candidates.
   new.company_id:=null;
  else
   raise exception 'Candidate and CRM corporate number must match' using errcode='23514';
  end if;
 end if;
 return new;
end;
$$;
revoke all on function private.guard_company_candidate() from public,anon,authenticated;
create trigger guard_company_candidate before insert or update on public.company_candidates
 for each row execute function private.guard_company_candidate();
create trigger touch_updated_at before update on public.company_candidates
 for each row execute function private.touch_updated_at();

-- Atomic counters are safe even when a caller uses REPEATABLE READ: concurrent
-- mutations either see the locked current count or abort with serialization error.
-- AFTER INSERT means an ON CONFLICT refresh consumes no extra quota slot.
create table private.company_candidate_counts (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 total integer not null check(total between 0 and 5000)
);
alter table private.company_candidate_counts enable row level security;
revoke all on private.company_candidate_counts from public,anon,authenticated;
create function private.count_company_candidate() returns trigger
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare n integer;
begin
 if tg_op='DELETE' then
  update private.company_candidate_counts set total=total-1 where organization_id=old.organization_id;
  return old;
 end if;
 if auth.uid() is null or coalesce(private.org_role(new.organization_id),'') not in ('owner','admin','sales') then
  raise exception 'Forbidden' using errcode='42501';
 end if;
 insert into private.company_candidate_counts as counts(organization_id,total) values(new.organization_id,1)
 on conflict(organization_id) do update set total=counts.total+1 where counts.total<5000 returning total into n;
 if n is null then raise exception 'Candidate limit reached (5000 per organization)' using errcode='P0429'; end if;
 return new;
end;
$$;
revoke all on function private.count_company_candidate() from public,anon,authenticated;
create trigger count_company_candidate after insert or delete on public.company_candidates
 for each row execute function private.count_company_candidate();

-- A private trigger is the only writer of immutable first-import evidence.
-- An import may later be refreshed or removed from the bounded candidate cache.
create function private.snapshot_company_candidate_import() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.company_id is null then return new; end if;
 if tg_op='UPDATE' and new.company_id is not distinct from old.company_id then return new; end if;
 if auth.uid() is null or coalesce(private.org_role(new.organization_id),'') not in ('owner','admin','sales') then
  raise exception 'Forbidden' using errcode='42501';
 end if;
 if not exists(select 1 from public.companies where organization_id=new.organization_id
  and id=new.company_id and corporate_number=new.corporate_number) then
  raise exception 'Candidate and CRM corporate number must match' using errcode='23514';
 end if;
 insert into public.company_candidate_imports(organization_id,company_id,corporate_number,candidate_snapshot,imported_by)
 values(new.organization_id,new.company_id,new.corporate_number,to_jsonb(new),auth.uid())
 on conflict(organization_id,company_id,corporate_number) do nothing;
 return new;
end;
$$;
revoke all on function private.snapshot_company_candidate_import() from public,anon,authenticated;
create trigger snapshot_company_candidate_import after insert or update of company_id on public.company_candidates
 for each row execute function private.snapshot_company_candidate_import();

create function private.discovery_normalize(value text) returns text
language sql immutable strict parallel safe set search_path='' as $$
 select lower(regexp_replace(normalize(value,NFKC),'[[:space:]　]','','g'));
$$;
create function private.discovery_phone(value text) returns text
language sql immutable strict parallel safe set search_path='' as $$
 select regexp_replace(normalize(value,NFKC),'[^0-9]','','g');
$$;
revoke all on function private.discovery_normalize(text),private.discovery_phone(text) from public,anon;
grant execute on function private.discovery_normalize(text),private.discovery_phone(text) to authenticated;

-- Called both by preview and confirmation, so callers cannot bypass duplicate
-- review by passing a boolean alone. The token covers source versions + matches.
create function private.company_candidate_review(org uuid,candidate_ids uuid[]) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare items jsonb; valid_count integer;
begin
 if coalesce(private.org_role(org),'') not in ('owner','admin','sales') then
  raise exception 'Forbidden' using errcode='42501';
 end if;
 if candidate_ids is null or cardinality(candidate_ids) not between 1 and 50
  or array_position(candidate_ids,null) is not null
  or cardinality(candidate_ids)<>(select count(distinct id) from unnest(candidate_ids) id) then
  raise exception 'Select 1 to 50 unique candidates' using errcode='22023';
 end if;
 select count(*) into valid_count from public.company_candidates where organization_id=org and id=any(candidate_ids);
 if valid_count<>cardinality(candidate_ids) then raise exception 'Candidate not found' using errcode='P0002'; end if;
 select jsonb_agg(jsonb_build_object(
  'candidate_id',d.id,'name',d.name,'updated_at',d.updated_at,'candidate_version',md5(to_jsonb(d)::text),
  'company_id',(select c.id from public.companies c where c.organization_id=org and c.corporate_number=d.corporate_number),
  'selected_duplicates',coalesce((select jsonb_agg(jsonb_build_object('candidate_id',other.id,'name',other.name,
    'reason',case when private.discovery_phone(d.phone)<>'' and private.discovery_phone(d.phone)=private.discovery_phone(other.phone) then 'phone' else 'name' end) order by other.id)
   from public.company_candidates other where other.organization_id=org and other.id=any(candidate_ids) and other.id<>d.id
    and (private.discovery_normalize(other.name)=private.discovery_normalize(d.name)
     or (private.discovery_phone(d.phone)<>'' and private.discovery_phone(d.phone)=private.discovery_phone(other.phone)))),'[]'::jsonb),
  'duplicates',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'updated_at',c.updated_at,
    'reason',case when private.discovery_phone(d.phone)<>'' and private.discovery_phone(d.phone)=private.discovery_phone(c.phone)
     then 'phone' else 'name' end) order by c.id)
   from public.companies c where c.organization_id=org and c.corporate_number is distinct from d.corporate_number
    and (private.discovery_normalize(c.name)=private.discovery_normalize(d.name)
     or (private.discovery_phone(d.phone)<>'' and private.discovery_phone(d.phone)=private.discovery_phone(c.phone)))),'[]'::jsonb)
 ) order by d.id) into items
 from public.company_candidates d where d.organization_id=org and d.id=any(candidate_ids);
 return jsonb_build_object('review_token',md5(org::text||items::text),'items',items);
end;
$$;
revoke all on function private.company_candidate_review(uuid,uuid[]) from public,anon;
grant execute on function private.company_candidate_review(uuid,uuid[]) to authenticated;
create function public.preview_company_candidates(org uuid,candidate_ids uuid[]) returns jsonb
language sql security invoker set search_path='' as $$
 select private.company_candidate_review(org,candidate_ids);
$$;

create function public.import_company_candidates(org uuid,candidate_ids uuid[],confirmed_duplicates boolean default false,review_token text default null) returns jsonb
language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare review jsonb; item jsonb; candidate public.company_candidates; linked uuid;
 results jsonb:='[]'; created_total integer:=0; created boolean;
begin
 if coalesce(private.org_role(org),'') not in ('owner','admin','sales') then raise exception 'Forbidden' using errcode='42501'; end if;
 -- Use the same organization lock as manual CRM writes and CSV imports.
 perform pg_advisory_xact_lock(hashtextextended('companies:'||org::text,0));
 perform id from public.company_candidates where organization_id=org and id=any(candidate_ids) order by id for update;
 review:=private.company_candidate_review(org,candidate_ids);
 if review_token is not null and review_token is distinct from review->>'review_token' then
  -- Replays after all rows were imported are idempotent, even with the old token.
  if exists(select 1 from jsonb_array_elements(review->'items') r where r->>'company_id' is null) then
   raise exception 'Candidate preview changed; review again' using errcode='40001';
  end if;
 end if;
 for item in select value from jsonb_array_elements(review->'items') loop
  if item->>'company_id' is null and (jsonb_array_length(item->'duplicates')>0 or jsonb_array_length(item->'selected_duplicates')>0)
   and (confirmed_duplicates is not true or review_token is distinct from review->>'review_token') then
   raise exception 'Duplicate review required' using errcode='40001';
  end if;
 end loop;
 for candidate in select * from public.company_candidates where organization_id=org and id=any(candidate_ids) order by id loop
  select id into linked from public.companies where organization_id=org and corporate_number=candidate.corporate_number;
  created:=linked is null;
  if created then
   insert into public.companies(organization_id,corporate_number,name,prefecture,address,industry,industry_subcategory,
    phone,website_url,employee_min,employee_max,source)
   values(org,candidate.corporate_number,candidate.name,candidate.prefecture,candidate.location,
    candidate.industry_labels[1],array_to_string(candidate.industry_labels,'、'),candidate.phone,candidate.website_url,
    candidate.employee_number::integer,candidate.employee_number::integer,
    'Gビズインフォ https://info.gbiz.go.jp/hojin/ichiran?hojinBango='||candidate.corporate_number)
   returning id into linked;
   created_total:=created_total+1;
  end if;
  update public.company_candidates set company_id=linked where id=candidate.id and company_id is distinct from linked;
  results:=results||jsonb_build_array(jsonb_build_object('candidate_id',candidate.id,'company_id',linked,'created',created));
 end loop;
 return jsonb_build_object('items',results,'created_count',created_total,'existing_count',cardinality(candidate_ids)-created_total);
end;
$$;
revoke all on function public.preview_company_candidates(uuid,uuid[]),public.import_company_candidates(uuid,uuid[],boolean,text) from public,anon;
grant execute on function public.preview_company_candidates(uuid,uuid[]),public.import_company_candidates(uuid,uuid[],boolean,text) to authenticated;

-- Remote acquisition limits persist across serverless instances and are also
-- enforced for direct RPC callers; no provider credentials are stored here.
create table private.discovery_rate_limits (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 operation text not null check(operation in ('acquire','enrich')),
 expires_at timestamptz not null,
 total integer not null check(total between 1 and 20),
 primary key(organization_id,operation)
);
alter table private.discovery_rate_limits enable row level security;
revoke all on private.discovery_rate_limits from public,anon,authenticated;
create function private.reserve_company_discovery_request(org uuid,operation text) returns boolean
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare n integer; cap integer; lifetime interval;
begin
 if auth.uid() is null or coalesce(private.org_role(org),'') not in ('owner','admin','sales') then
  raise exception 'Forbidden' using errcode='42501';
 end if;
 if operation is null or operation not in ('acquire','enrich') then
  raise exception 'Invalid operation' using errcode='22023';
 end if;
 cap:=case operation when 'acquire' then 1 else 20 end;
 lifetime:=case operation when 'acquire' then interval '30 seconds' else interval '1 hour' end;
 perform pg_advisory_xact_lock(hashtextextended('discovery_rate:'||org::text||':'||operation,0));
 select total into n from private.discovery_rate_limits r
 where r.organization_id=org and r.operation=reserve_company_discovery_request.operation and r.expires_at>now();
 if n>=cap then return false; end if;
 insert into private.discovery_rate_limits as r(organization_id,operation,expires_at,total)
 values(org,operation,now()+lifetime,1)
 on conflict on constraint discovery_rate_limits_pkey do update
 set total=case when r.expires_at<=now() then 1 else r.total+1 end,
 expires_at=case when r.expires_at<=now() then excluded.expires_at else r.expires_at end;
 return true;
end;
$$;
revoke all on function private.reserve_company_discovery_request(uuid,text) from public,anon;
grant execute on function private.reserve_company_discovery_request(uuid,text) to authenticated;
create function public.reserve_company_discovery_request(org uuid,operation text) returns boolean
language sql security invoker set search_path='' as $$
 select private.reserve_company_discovery_request(org,operation);
$$;
revoke all on function public.reserve_company_discovery_request(uuid,text) from public,anon;
grant execute on function public.reserve_company_discovery_request(uuid,text) to authenticated;
