-- Tenant boundaries are enforced by both RLS and composite foreign keys.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null default '', email text not null, avatar_url text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 200),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.organization_members (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 role text not null check(role in ('owner','admin','sales','viewer')),
 created_at timestamptz not null default now(), primary key(organization_id,user_id)
);
create index members_user_idx on public.organization_members(user_id,organization_id);
create function private.org_role(org uuid) returns text
language sql stable security definer set search_path = '' as $$
 select role from public.organization_members where organization_id = org and user_id = (select auth.uid());
$$;
create function private.is_colleague(person uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.organization_members a join public.organization_members b
 on a.organization_id = b.organization_id where a.user_id = (select auth.uid()) and b.user_id = person);
$$;
revoke all on function private.org_role(uuid), private.is_colleague(uuid) from public;
grant execute on function private.org_role(uuid), private.is_colleague(uuid) to authenticated;
create function private.sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into public.profiles(id,name,email)
 values(new.id,left(coalesce(new.raw_user_meta_data->>'name',''),200),coalesce(new.email,''))
 on conflict(id) do update set email = excluded.email;
 return new;
end;
$$;
create trigger sync_profile after insert or update of email on auth.users for each row execute function private.sync_profile();
insert into public.profiles(id,name,email)
select id,left(coalesce(raw_user_meta_data->>'name',''),200),coalesce(email,'') from auth.users on conflict(id) do nothing;

create table public.companies (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 corporate_number text check(corporate_number is null or corporate_number ~ '^[0-9]{13}$'),
 name text not null check(length(trim(name)) between 1 and 200),
 industry text, industry_subcategory text, prefecture text, city text, address text,
 website_url text, phone text, contact_url text,
 employee_min integer check(employee_min >= 0), employee_max integer check(employee_max >= 0),
 capital bigint check(capital >= 0), business_description text,
 company_status text not null default 'new' check(company_status in ('new','active','nurturing','not_target','closed')),
 assigned_user_id uuid, source text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,corporate_number),
 check(employee_min is null or employee_max is null or employee_min <= employee_max),
 foreign key(organization_id,assigned_user_id) references public.organization_members(organization_id,user_id) on delete set null(assigned_user_id)
);
create index companies_status_idx on public.companies(organization_id,company_status,created_at desc);
create index companies_name_idx on public.companies(organization_id,name,id);
create table public.contacts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, name text not null check(length(trim(name)) between 1 and 200),
 department text, position text, phone text, email text, is_decision_maker boolean not null default false, notes text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,company_id,id),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade
);
create table public.activities (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, contact_id uuid, user_id uuid not null references public.profiles(id),
 type text not null check(type in ('call','meeting','email','memo','status_change')), title text, content text,
 occurred_at timestamptz not null default now(), created_at timestamptz not null default now(), unique(organization_id,id),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade,
 foreign key(organization_id,company_id,contact_id) references public.contacts(organization_id,company_id,id) on delete set null(contact_id)
);
create index activities_timeline_idx on public.activities(organization_id,company_id,occurred_at desc,id);
create index activities_daily_idx on public.activities(organization_id,occurred_at desc,type);
create table public.call_details (
 activity_id uuid primary key references public.activities(id) on delete cascade, zoom_call_id text unique,
 phone_number text, started_at timestamptz, ended_at timestamptz,
 duration_seconds integer check(duration_seconds >= 0),
 result text check(result in ('no_answer','gatekeeper','connected','callback','appointment','rejected','other')),
 check(started_at is null or ended_at is null or ended_at >= started_at)
);
create table public.tasks (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, contact_id uuid, assigned_user_id uuid not null,
 type text not null check(type in ('callback','follow_up','meeting','proposal','other')),
 title text not null check(length(trim(title)) between 1 and 300), description text, due_at timestamptz,
 status text not null default 'todo' check(status in ('todo','completed','cancelled')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade,
 foreign key(organization_id,company_id,contact_id) references public.contacts(organization_id,company_id,id) on delete set null(contact_id),
 foreign key(organization_id,assigned_user_id) references public.organization_members(organization_id,user_id)
);
create index tasks_due_idx on public.tasks(organization_id,status,due_at,id);
create index tasks_assignee_idx on public.tasks(organization_id,assigned_user_id,status);
create table public.deals (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, contact_id uuid, owner_user_id uuid not null,
 name text not null check(length(trim(name)) between 1 and 300),
 stage text not null default 'discovery' check(stage in ('discovery','proposal','negotiation','won','lost')),
 initial_price integer check(initial_price >= 0), monthly_price integer check(monthly_price >= 0),
 expected_close_date date, lost_reason text, notes text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade,
 foreign key(organization_id,company_id,contact_id) references public.contacts(organization_id,company_id,id) on delete set null(contact_id),
 foreign key(organization_id,owner_user_id) references public.organization_members(organization_id,user_id)
);
create index deals_pipeline_idx on public.deals(organization_id,stage,expected_close_date,id);
create table public.business_processes (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, process_type text not null, current_method text, description text,
 pain_level integer check(pain_level between 1 and 5), notes text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,company_id,process_type),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade
);
create table public.company_tools (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, tool_name text not null check(length(trim(tool_name)) between 1 and 200), category text, usage_description text,
 keep_or_replace text not null default 'unknown' check(keep_or_replace in ('unknown','keep','replace','integrate')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade
);
create table public.pain_points (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, type text not null, description text, severity integer check(severity between 1 and 5),
 created_at timestamptz not null default now(),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade
);
create table public.improvement_types (
 id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null,
 category text not null, description text, default_question text
);
create table public.industry_recommendations (
 id uuid primary key default gen_random_uuid(), industry text not null,
 improvement_type_id uuid not null references public.improvement_types(id), priority integer not null check(priority > 0),
 unique(industry,improvement_type_id), unique(industry,priority)
);
create table public.proposals (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 company_id uuid not null, type text not null check(type in ('build','automate','keep')),
 title text not null check(length(trim(title)) between 1 and 300), description text, reason text, expected_benefit text,
 automation_config jsonb check(automation_config is null or jsonb_typeof(automation_config) = 'object'),
 status text not null default 'draft' check(status in ('draft','proposed','accepted','rejected')),
 generated_by text not null default 'human' check(generated_by in ('rule','ai','human')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(organization_id,company_id) references public.companies(organization_id,id) on delete cascade
);
create table public.organization_invitations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 email text not null check(email = lower(trim(email)) and position('@' in email) > 1),
 role text not null check(role in ('admin','sales','viewer')), invited_by uuid references public.profiles(id) on delete set null,
 expires_at timestamptz not null default now() + interval '7 days', accepted_at timestamptz,
 created_at timestamptz not null default now(), unique(organization_id,email)
);
create function private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create function private.protect_identity() returns trigger language plpgsql set search_path = '' as $$
begin
 if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id then
  raise exception 'Record identity and organization cannot be changed' using errcode = '23514';
 end if;
 return new;
end;
$$;
do $$ declare t text; begin
 foreach t in array array['profiles','organizations','companies','contacts','tasks','deals','business_processes','company_tools','proposals'] loop
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
 foreach t in array array['companies','contacts','activities','tasks','deals','business_processes','company_tools','pain_points','proposals'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon',t);
  execute format('grant select,insert,update,delete on public.%I to authenticated',t);
  execute format('create policy tenant_read on public.%I for select to authenticated using(private.org_role(organization_id) is not null)',t);
  execute format('create policy tenant_insert on public.%I for insert to authenticated with check(private.org_role(organization_id) in (''owner'',''admin'',''sales''))',t);
  execute format('create policy tenant_update on public.%I for update to authenticated using(private.org_role(organization_id) in (''owner'',''admin'',''sales'')) with check(private.org_role(organization_id) in (''owner'',''admin'',''sales''))',t);
  execute format('create policy tenant_delete on public.%I for delete to authenticated using(private.org_role(organization_id) in (''owner'',''admin'',''sales''))',t);
  execute format('create trigger protect_identity before update on public.%I for each row execute function private.protect_identity()',t);
  if t <> 'companies' then execute format('create index %I on public.%I(organization_id,company_id)',t || '_company_idx',t); end if;
 end loop;
 foreach t in array array['profiles','organizations','organization_members','organization_invitations','call_details','improvement_types','industry_recommendations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
grant update(name,avatar_url) on public.profiles to authenticated;
create policy profile_read on public.profiles for select to authenticated using(id = (select auth.uid()) or private.is_colleague(id));
create policy profile_update on public.profiles for update to authenticated using(id = (select auth.uid())) with check(id = (select auth.uid()));
grant update(name) on public.organizations to authenticated;
create policy org_read on public.organizations for select to authenticated using(private.org_role(id) is not null);
create policy org_update on public.organizations for update to authenticated using(private.org_role(id) in ('owner','admin')) with check(private.org_role(id) in ('owner','admin'));
create policy member_read on public.organization_members for select to authenticated using(private.org_role(organization_id) is not null);
create policy invitation_read on public.organization_invitations for select to authenticated using(private.org_role(organization_id) in ('owner','admin'));
create policy improvement_read on public.improvement_types for select to authenticated using(true);
create policy recommendation_read on public.industry_recommendations for select to authenticated using(true);
grant insert,update,delete on public.call_details to authenticated;
create policy call_read on public.call_details for select to authenticated using(exists(select 1 from public.activities a where a.id = activity_id));
create policy call_write on public.call_details for all to authenticated
using(exists(select 1 from public.activities a where a.id = activity_id and a.type = 'call' and private.org_role(a.organization_id) in ('owner','admin','sales')))
with check(exists(select 1 from public.activities a where a.id = activity_id and a.type = 'call' and private.org_role(a.organization_id) in ('owner','admin','sales')));
create function private.protect_activity_author() returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op = 'INSERT' and new.user_id is distinct from auth.uid() then
  raise exception 'Activity author must be the current user' using errcode = '42501';
 elsif tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.type is distinct from old.type) then
  raise exception 'Activity author and type cannot change' using errcode = '23514';
 end if;
 return new;
end;
$$;
create trigger protect_activity_author before insert or update on public.activities for each row execute function private.protect_activity_author();

