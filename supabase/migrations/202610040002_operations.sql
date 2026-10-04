create function public.create_organization(org_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare org uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 insert into public.organizations(name) values(trim(org_name)) returning id into org;
 insert into public.organization_members(organization_id,user_id,role) values(org,auth.uid(),'owner');
 return org;
end;
$$;
create function public.invite_member(org uuid, invite_email text, invite_role text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor text; invitation uuid;
begin
 perform 1 from public.organizations where id = org for update;
 actor := private.org_role(org);
 if actor is null or actor not in ('owner','admin') or (actor = 'admin' and invite_role not in ('sales','viewer')) then
  raise exception 'Not allowed to invite this role' using errcode = '42501';
 end if;
 insert into public.organization_invitations(organization_id,email,role,invited_by)
 values(org,lower(trim(invite_email)),invite_role,auth.uid())
 on conflict(organization_id,email) do update set role = excluded.role, invited_by = excluded.invited_by,
 expires_at = now() + interval '7 days', accepted_at = null returning id into invitation;
 return invitation;
end;
$$;
create function public.my_invitations() returns table(id uuid, organization_name text, role text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select i.id,o.name,i.role,i.expires_at from public.organization_invitations i
 join public.organizations o on o.id = i.organization_id
 join auth.users u on u.id = auth.uid() and lower(u.email) = i.email and u.email_confirmed_at is not null
 where i.accepted_at is null and i.expires_at > now();
$$;
create function public.accept_invitation(invitation_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare invitation public.organization_invitations; verified_email text;
begin
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
create function public.revoke_invitation(org uuid, invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if coalesce(private.org_role(org),'') not in ('owner','admin') then raise exception 'Forbidden' using errcode = '42501'; end if;
 delete from public.organization_invitations where id = invitation_id and organization_id = org
 and (private.org_role(org) = 'owner' or role in ('sales','viewer'));
end;
$$;
create function public.manage_member(org uuid, member_id uuid, new_role text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare actor text; target text; replacement uuid;
begin
 perform 1 from public.organizations where id = org for update;
 actor := private.org_role(org);
 select role into target from public.organization_members where organization_id = org and user_id = member_id;
 if actor is null or actor not in ('owner','admin') or target is null or
 (actor = 'admin' and (target not in ('sales','viewer') or coalesce(new_role,'sales') not in ('sales','viewer'))) then
  raise exception 'Forbidden' using errcode = '42501';
 end if;
 if target = 'owner' and new_role is distinct from 'owner' and
 (select count(*) from public.organization_members where organization_id = org and role = 'owner') <= 1 then
  raise exception 'The last owner cannot be removed or demoted' using errcode = '23514';
 end if;
 if new_role is null then
  if member_id <> auth.uid() then replacement := auth.uid();
  else select user_id into replacement from public.organization_members where organization_id = org and user_id <> member_id and role = 'owner' order by created_at limit 1;
  end if;
  update public.tasks set assigned_user_id = replacement where organization_id = org and assigned_user_id = member_id;
  update public.deals set owner_user_id = replacement where organization_id = org and owner_user_id = member_id;
  delete from public.organization_members where organization_id = org and user_id = member_id;
 else
  update public.organization_members set role = new_role where organization_id = org and user_id = member_id;
 end if;
end;
$$;
-- Invoker semantics retain RLS. Failure rolls back activity, call and callback together.
create function public.record_activity(org uuid, company uuid, payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare activity uuid; activity_type text := payload->>'type';
begin
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
create view public.company_overview with(security_invoker = true) as
 select c.*, p.name as assigned_user_name,
 (select max(a.occurred_at) from public.activities a where a.organization_id = c.organization_id and a.company_id = c.id) as last_contact_at,
 (select jsonb_build_object('id',t.id,'title',t.title,'due_at',t.due_at) from public.tasks t
 where t.organization_id = c.organization_id and t.company_id = c.id and t.status = 'todo'
 order by t.due_at asc nulls last,t.created_at asc limit 1) as next_task
 from public.companies c left join public.profiles p on p.id = c.assigned_user_id;
revoke all on public.company_overview from anon;
grant select on public.company_overview to authenticated;
create function public.dashboard_counts(org uuid, day_start timestamptz, day_end timestamptz) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
 if private.org_role(org) is null then raise exception 'Forbidden' using errcode = '42501'; end if;
 if day_start is null or day_end is null or day_end <= day_start or day_end > day_start + interval '26 hours' then
  raise exception 'Invalid day range' using errcode = '22023';
 end if;
 return jsonb_build_object(
 'calls_today',(select count(*) from public.activities where organization_id = org and type = 'call' and occurred_at >= day_start and occurred_at < day_end),
 'connected_today',(select count(*) from public.activities a join public.call_details d on d.activity_id = a.id where a.organization_id = org and a.occurred_at >= day_start and a.occurred_at < day_end and d.result in ('connected','callback','appointment')),
 'appointments_today',(select count(*) from public.activities a join public.call_details d on d.activity_id = a.id where a.organization_id = org and a.occurred_at >= day_start and a.occurred_at < day_end and d.result = 'appointment'),
 'open_deals',(select count(*) from public.deals where organization_id = org and stage in ('discovery','proposal','negotiation')),
 'won_deals',(select count(*) from public.deals where organization_id = org and stage = 'won'),
 'pipeline',coalesce((select jsonb_object_agg(stage,total) from (select stage,count(*) total from public.deals where organization_id = org group by stage) s),'{}'::jsonb));
end;
$$;
revoke all on all functions in schema private from public,anon;
revoke all on function public.create_organization(text), public.invite_member(uuid,text,text),
 public.my_invitations(), public.accept_invitation(uuid), public.revoke_invitation(uuid,uuid),
 public.manage_member(uuid,uuid,text), public.record_activity(uuid,uuid,jsonb), public.dashboard_counts(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.create_organization(text), public.invite_member(uuid,text,text),
 public.my_invitations(), public.accept_invitation(uuid), public.revoke_invitation(uuid,uuid),
 public.manage_member(uuid,uuid,text), public.record_activity(uuid,uuid,jsonb), public.dashboard_counts(uuid,timestamptz,timestamptz) to authenticated;

