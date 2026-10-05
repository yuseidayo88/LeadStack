-- Reject revoked sessions even when an otherwise valid JWT is presented directly to PostgREST.
-- Auth owns auth.sessions. We only read it; existing sessions/data are not removed.
create function private.session_active() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.sessions s where s.id =
 case when (auth.jwt()->>'session_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (auth.jwt()->>'session_id')::uuid else null end
 and s.user_id=(select auth.uid()) and (s.not_after is null or s.not_after>now()));
$$;
revoke all on function private.session_active() from public,anon;
grant execute on function private.session_active() to authenticated;
create or replace function private.org_role(org uuid) returns text
language sql stable security definer set search_path='' as $$
 select role from public.organization_members where organization_id=org and user_id=(select auth.uid()) and private.session_active();
$$;
create or replace function private.is_colleague(person uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.session_active() and exists(select 1 from public.organization_members a join public.organization_members b
 on a.organization_id=b.organization_id where a.user_id=(select auth.uid()) and b.user_id=person);
$$;
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('create policy active_session on public.%I as restrictive for all to authenticated using((select private.session_active())) with check((select private.session_active()))',t.tablename);
 end loop;
end $$;
create policy active_session on private.company_import_previews as restrictive for all to authenticated
 using((select private.session_active())) with check((select private.session_active()));

-- Bounded, persistent per-user CSV throttle, also reached by direct RPC callers.
create table private.operation_limits(actor uuid not null,kind text not null,window_start timestamptz not null,total integer not null,primary key(actor,kind));
alter table private.operation_limits enable row level security;
revoke all on private.operation_limits from public,anon,authenticated;
create function private.consume_operation(kind text) returns void
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if not private.session_active() then raise exception 'Session required' using errcode='42501'; end if;
 if kind not in ('csv_preview','csv_confirm') then raise exception 'Invalid operation' using errcode='22023'; end if;
 insert into private.operation_limits as limits(actor,kind,window_start,total) values(auth.uid(),kind,date_trunc('minute',now()),1)
 on conflict on constraint operation_limits_pkey do update set total=case when limits.window_start=excluded.window_start then limits.total+1 else 1 end,window_start=excluded.window_start returning total into n;
 if n>20 then raise exception 'Rate limited' using errcode='P0429'; end if;
end;
$$;
revoke all on function private.consume_operation(text) from public,anon;
grant execute on function private.consume_operation(text) to authenticated;

-- Serialize competing imports/writes only within their organization, not across the CRM.
create function private.lock_company_organization() returns trigger
language plpgsql set search_path='' set lock_timeout='3s' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('companies:'||coalesce(new.organization_id,old.organization_id)::text,0));
 if tg_op='DELETE' then return old; end if;return new;
end;
$$;
revoke all on function private.lock_company_organization() from public,anon,authenticated;
create trigger lock_company_organization before insert or update or delete on public.companies
 for each row execute function private.lock_company_organization();

-- Request identity makes retries of an activity/callback atomic and idempotent.
alter table public.activities add column request_id uuid, add column request_payload jsonb;
create unique index activities_request on public.activities(organization_id,user_id,request_id) where request_id is not null;

create or replace function public.create_organization(org_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare org uuid;
begin
 if not private.session_active() then raise exception 'Session required' using errcode='42501'; end if;
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 insert into public.organizations(name) values(trim(org_name)) returning id into org;
 insert into public.organization_members(organization_id,user_id,role) values(org,auth.uid(),'owner');
 return org;
end;
$$;

create or replace function public.my_invitations() returns table(id uuid, organization_name text, role text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select i.id,o.name,i.role,i.expires_at from public.organization_invitations i
 join public.organizations o on o.id = i.organization_id
 join auth.users u on u.id = auth.uid() and lower(u.email) = i.email and u.email_confirmed_at is not null
 where private.session_active() and i.accepted_at is null and i.expires_at > now();
$$;

create or replace function public.accept_invitation(invitation_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare invitation public.organization_invitations; verified_email text;
begin
 if not private.session_active() then raise exception 'Session required' using errcode='42501'; end if;
 select lower(email) into verified_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
 select * into invitation from public.organization_invitations
 where id = invitation_id and email = verified_email and accepted_at is null and expires_at > now() for update;
 if not found then raise exception 'Invitation unavailable' using errcode = '42501'; end if;
 insert into public.organization_members(organization_id,user_id,role)
 values(invitation.organization_id,auth.uid(),invitation.role) on conflict do nothing;
 update public.organization_invitations set accepted_at = now() where id = invitation.id;
 return invitation.organization_id;
end;
$$;

create or replace function public.preview_company_import(org uuid, rows jsonb) returns jsonb
language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare preview uuid; enriched jsonb; checked_row jsonb;
begin
 perform private.consume_operation('csv_preview');
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

create or replace function public.confirm_company_import(org uuid,preview_id uuid,selected_rows integer[]) returns uuid[]
language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare batch private.company_import_previews; r jsonb; d jsonb; ids uuid[]:='{}'; created uuid;
begin
 if coalesce(private.org_role(org),'') not in ('owner','admin','sales') then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into batch from private.company_import_previews where id=preview_id and organization_id=org and created_by=auth.uid() for update;
 if not found or batch.expires_at<now() then raise exception 'Preview expired' using errcode='P0002'; end if;
 if batch.imported_ids is not null then
  if batch.selected_rows is distinct from selected_rows then raise exception 'Selection changed' using errcode='40001'; end if;
  return batch.imported_ids;
 end if;
 if selected_rows is null or array_position(selected_rows,null) is not null or cardinality(selected_rows) not between 1 and 500 or cardinality(selected_rows)<>(select count(distinct v) from unnest(selected_rows) v)
 or cardinality(selected_rows)<>(select count(*) from jsonb_array_elements(batch.rows) v where (v->>'row')::integer=any(selected_rows)) then raise exception 'Invalid selection' using errcode='22023'; end if;
 -- Serialize the bounded confirmation with other company writes, preventing stale duplicate checks.
 perform private.consume_operation('csv_confirm');
 perform pg_advisory_xact_lock(hashtextextended('companies:'||org::text,0));
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

create or replace function public.record_activity(org uuid, company uuid, payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare existing public.activities; request_key uuid:=nullif(payload->>'request_id','')::uuid; activity uuid; activity_type text := payload->>'type';
begin
 if not private.session_active() then raise exception 'Session required' using errcode='42501'; end if;
 if request_key is not null then
  perform pg_advisory_xact_lock(hashtextextended(org::text||auth.uid()::text||request_key::text,0));
  select * into existing from public.activities where organization_id=org and user_id=auth.uid() and request_id=request_key;
  if found then
   if existing.company_id<>company or existing.request_payload is distinct from payload then raise exception 'Request already saved with different input' using errcode='40001'; end if;
   return existing.id;
  end if;
 end if;
 if activity_type='call' and payload->>'result'='callback' and
 (payload->'callback' is null or payload->'callback'='null'::jsonb or nullif(payload->'callback'->>'due_at','') is null) then
  raise exception 'Callback date required' using errcode='22023';
 end if;
 insert into public.activities(organization_id,company_id,contact_id,user_id,type,title,content,occurred_at,request_id,request_payload)
 values(org,company,nullif(payload->>'contact_id','')::uuid,auth.uid(),activity_type,payload->>'title',payload->>'content',
 coalesce((payload->>'occurred_at')::timestamptz,now()),request_key,case when request_key is not null then payload else null end) returning id into activity;
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

-- App auth attempts are counted before contacting Auth. No account existence is disclosed.
-- Supabase's own IP/endpoint limits still protect direct Auth API requests.
create table private.auth_attempts(operation text not null,subject text not null,total integer not null,expires_at timestamptz not null,primary key(operation,subject));
create index auth_attempts_expiry on private.auth_attempts(expires_at);
alter table private.auth_attempts enable row level security;
revoke all on private.auth_attempts from public,anon,authenticated;
create function public.allow_auth_attempt(operation text,subject text) returns boolean
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare cap integer; lifetime interval; n integer;
begin
 if subject is null or subject !~ '^[a-f0-9]{64}$' or operation is null or operation not in ('login','signup','recovery') then raise exception 'Invalid operation' using errcode='22023'; end if;
 cap:=case operation when 'login' then 10 when 'signup' then 5 else 3 end;
 lifetime:=case operation when 'login' then interval '5 minutes' when 'signup' then interval '1 hour' else interval '15 minutes' end;
 delete from private.auth_attempts where ctid in (select ctid from private.auth_attempts where expires_at<now() limit 100);
 insert into private.auth_attempts as attempts values(operation,subject,1,now()+lifetime)
 on conflict on constraint auth_attempts_pkey do update set total=case when attempts.expires_at<now() then 1 else least(attempts.total+1,1000000) end, expires_at=case when attempts.expires_at<now() then now()+lifetime else attempts.expires_at end returning total into n;
 return n<=cap;
end;
$$;
revoke all on function public.allow_auth_attempt(text,text) from public;
grant execute on function public.allow_auth_attempt(text,text) to anon,authenticated;

create or replace function private.protect_activity_author() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' and new.user_id is distinct from auth.uid() then
  raise exception 'Activity author must be current user' using errcode='42501';
 elsif tg_op='UPDATE' and (new.user_id is distinct from old.user_id or new.type is distinct from old.type or new.request_id is distinct from old.request_id or new.request_payload is distinct from old.request_payload) then
  raise exception 'Activity identity cannot change' using errcode='23514';
 end if;return new;
end;
$$;
