-- Existing CRM rows are preserved. This timestamp completes edit-version support
-- for the only editable resource that did not previously have updated_at.
alter table public.pain_points add column updated_at timestamptz not null default now();
create trigger touch_updated_at before update on public.pain_points
for each row execute function private.touch_updated_at();

-- Evaluate the caller's readable organizations once per statement, instead of
-- repeating a definer/session lookup for every company/activity/task row.
-- The restrictive active_session policies and all write policies remain in force.
create function private.readable_organizations() returns setof uuid
language sql stable security definer set search_path='' as $$
 select organization_id from public.organization_members
 where user_id=(select auth.uid()) and (select private.session_active());
$$;
revoke all on function private.readable_organizations() from public,anon;
grant execute on function private.readable_organizations() to authenticated;
do $$ declare t text; begin
 foreach t in array array['companies','contacts','activities','tasks','deals','business_processes','company_tools','pain_points','proposals'] loop
  execute format('drop policy tenant_read on public.%I',t);
  execute format('create policy tenant_read on public.%I for select to authenticated using(organization_id in(select private.readable_organizations()))',t);
 end loop;
end $$;
