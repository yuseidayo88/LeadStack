-- Non-destructive: preserves CRM tables and existing records. Local validation only.
create or replace view public.company_overview with (security_invoker = true) as
 select c.*, p.name as assigned_user_name,
 (select max(a.occurred_at) from public.activities a where a.organization_id=c.organization_id and a.company_id=c.id
  and (a.type in ('meeting','email') or (a.type='call' and exists(select 1 from public.call_details d where d.activity_id=a.id and d.result in ('connected','callback','appointment'))))) as last_contact_at,
 (select jsonb_build_object('id',t.id,'title',t.title,'due_at',t.due_at) from public.tasks t
  where t.organization_id=c.organization_id and t.company_id=c.id and t.status='todo'
  order by t.due_at asc nulls last,t.created_at asc limit 1) as next_task
 from public.companies c left join public.profiles p on p.id=c.assigned_user_id;

create function public.next_company(org uuid, company uuid) returns table(id uuid,name text)
language sql stable security invoker set search_path='' as $$
 select c.id,c.name from public.companies c join public.companies current on current.id=company and current.organization_id=org
 where c.organization_id=org and (c.name,c.id)>(current.name,current.id) order by c.name,c.id limit 1;
$$;
revoke all on function public.next_company(uuid,uuid) from public;
grant execute on function public.next_company(uuid,uuid) to authenticated;

-- Private, user-bound previews provide explicit confirmation and retry idempotency.
create table private.company_import_previews (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 created_by uuid not null references public.profiles(id) on delete cascade,
 expires_at timestamptz not null default now()+interval '30 minutes',
 rows jsonb not null,
 imported_ids uuid[],
 selected_rows integer[]
);
alter table private.company_import_previews enable row level security;
create policy own_import on private.company_import_previews to authenticated
 using(created_by=(select auth.uid()) and private.org_role(organization_id) in ('owner','admin','sales'))
 with check(created_by=(select auth.uid()) and private.org_role(organization_id) in ('owner','admin','sales'));
grant select,insert,update,delete on private.company_import_previews to authenticated;
create index company_import_actor on private.company_import_previews(created_by,expires_at);

create function private.company_duplicates(org uuid, item jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'corporate',corporate_number=item->>'corporate_number') order by id),'[]'::jsonb)
 from public.companies where organization_id=org and
 ((nullif(item->>'corporate_number','') is not null and corporate_number=item->>'corporate_number')
 or lower(regexp_replace(name,'[[:space:]　]','','g'))=lower(regexp_replace(item->>'name','[[:space:]　]','','g'))
 or (length(regexp_replace(item->>'phone','[^0-9]','','g'))>0 and regexp_replace(phone,'[^0-9]','','g')=regexp_replace(item->>'phone','[^0-9]','','g')));
$$;
revoke all on function private.company_duplicates(uuid,jsonb) from public;
grant execute on function private.company_duplicates(uuid,jsonb) to authenticated;

create function public.preview_company_import(org uuid, rows jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare preview uuid; enriched jsonb; checked_row jsonb;
begin
 if coalesce(private.org_role(org),'') not in ('owner','admin','sales') then raise exception 'Forbidden' using errcode='42501'; end if;
 if jsonb_typeof(rows)<>'array' or jsonb_array_length(rows) not between 1 and 500 or octet_length(rows::text)>2000000 then raise exception 'Invalid rows' using errcode='22023'; end if;
 for checked_row in select value from jsonb_array_elements(rows) loop
  if jsonb_typeof(checked_row->'data') is distinct from 'object' or jsonb_typeof(checked_row->'errors') is distinct from 'array' or (checked_row->>'row')::integer not between 2 and 501 then raise exception 'Invalid row' using errcode='22023'; end if;
 end loop;
 if (select count(distinct value->>'row') from jsonb_array_elements(rows))<>jsonb_array_length(rows) then raise exception 'Duplicate row' using errcode='22023'; end if;
 select jsonb_agg(r || jsonb_build_object('duplicates',private.company_duplicates(org,r->'data'),'fileDuplicates',
   (select coalesce(jsonb_agg((s->>'row')::integer),'[]'::jsonb) from jsonb_array_elements(rows) s where s->>'row'<>r->>'row' and (
     lower(regexp_replace(s->'data'->>'name','[[:space:]　]','','g'))=lower(regexp_replace(r->'data'->>'name','[[:space:]　]','','g'))
     or (nullif(s->'data'->>'corporate_number','') is not null and s->'data'->>'corporate_number'=r->'data'->>'corporate_number')
     or (length(regexp_replace(s->'data'->>'phone','[^0-9]','','g'))>0 and regexp_replace(s->'data'->>'phone','[^0-9]','','g')=regexp_replace(r->'data'->>'phone','[^0-9]','','g'))
   )))) into enriched from jsonb_array_elements(rows) r;
 delete from private.company_import_previews where created_by=auth.uid() and expires_at<now();
 insert into private.company_import_previews(organization_id,created_by,rows) values(org,auth.uid(),enriched) returning id into preview;
 return jsonb_build_object('id',preview,'rows',enriched,'expiresInMinutes',30);
end;
$$;
create function public.confirm_company_import(org uuid,preview_id uuid,selected_rows integer[]) returns uuid[]
language plpgsql security invoker set search_path='' as $$
declare batch private.company_import_previews; r jsonb; d jsonb; ids uuid[]:='{}'; created uuid;
begin
 if coalesce(private.org_role(org),'') not in ('owner','admin','sales') then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into batch from private.company_import_previews where id=preview_id and organization_id=org and created_by=auth.uid() for update;
 if not found or batch.expires_at<now() then raise exception 'Preview expired' using errcode='P0002'; end if;
 if batch.imported_ids is not null then
  if batch.selected_rows is distinct from selected_rows then raise exception 'Selection changed' using errcode='40001'; end if;
  return batch.imported_ids;
 end if;
 if cardinality(selected_rows) not between 1 and 500 or cardinality(selected_rows)<>(select count(distinct v) from unnest(selected_rows) v)
 or cardinality(selected_rows)<>(select count(*) from jsonb_array_elements(batch.rows) v where (v->>'row')::integer=any(selected_rows)) then raise exception 'Invalid selection' using errcode='22023'; end if;
 -- Serialize the bounded confirmation with other company writes, preventing stale duplicate checks.
 lock table public.companies in share row exclusive mode;
 for r in select value from jsonb_array_elements(batch.rows) where (value->>'row')::integer=any(selected_rows) loop
  if jsonb_array_length(r->'errors')<>0 then raise exception 'Invalid row selected' using errcode='22023'; end if;
  if private.company_duplicates(org,r->'data') is distinct from r->'duplicates' then raise exception 'Preview changed' using errcode='40001'; end if;
 end loop;
 for r in select value from jsonb_array_elements(batch.rows) where (value->>'row')::integer=any(selected_rows) loop
  d:=r->'data';
  insert into public.companies(organization_id,name,phone,corporate_number,industry,prefecture,city,address,website_url,business_description,source,assigned_user_id)
  values(org,d->>'name',d->>'phone',d->>'corporate_number',d->>'industry',d->>'prefecture',d->>'city',d->>'address',d->>'website_url',d->>'business_description',d->>'source',auth.uid()) returning id into created;
  ids:=array_append(ids,created);
 end loop;
 update private.company_import_previews set imported_ids=ids,selected_rows=confirm_company_import.selected_rows where id=preview_id;
 return ids;
end;
$$;
revoke all on function public.preview_company_import(uuid,jsonb),public.confirm_company_import(uuid,uuid,integer[]) from public;
grant execute on function public.preview_company_import(uuid,jsonb),public.confirm_company_import(uuid,uuid,integer[]) to authenticated;

create or replace function public.record_activity(org uuid, company uuid, payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare activity uuid; activity_type text := payload->>'type';
begin
 if activity_type='call' and payload->>'result'='callback' and
 (payload->'callback' is null or payload->'callback'='null'::jsonb or nullif(payload->'callback'->>'due_at','') is null) then
  raise exception 'Callback date required' using errcode='22023';
 end if;
 insert into public.activities(organization_id,company_id,contact_id,user_id,type,title,content,occurred_at)
 values(org,company,nullif(payload->>'contact_id','')::uuid,auth.uid(),activity_type,payload->>'title',payload->>'content',
 coalesce((payload->>'occurred_at')::timestamptz,now())) returning id into activity;
 if activity_type = 'call' then
  insert into public.call_details(activity_id,phone_number,result,started_at,ended_at,duration_seconds)
  values(activity,payload->>'phone_number',payload->>'result',(payload->>'started_at')::timestamptz,
  (payload->>'ended_at')::timestamptz,(payload->>'duration_seconds')::integer);
 end if;
 if payload->'callback' is not null and payload->'callback' <> 'null'::jsonb then
  insert into public.tasks(organization_id,company_id,contact_id,assigned_user_id,type,title,due_at)
  values(org,company,nullif(payload->>'contact_id','')::uuid,
  coalesce((payload->'callback'->>'assigned_user_id')::uuid,auth.uid()),'callback',
  coalesce(payload->'callback'->>'title','再架電'),(payload->'callback'->>'due_at')::timestamptz);
 end if;
 return activity;
end;
$$;
