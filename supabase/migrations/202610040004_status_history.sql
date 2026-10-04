-- Log status changes from any authenticated writer, including future import tools.
create function private.log_company_status() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 if new.company_status is distinct from old.company_status and auth.uid() is not null then
  insert into public.activities(organization_id,company_id,user_id,type,title,content)
  values(new.organization_id,new.id,auth.uid(),'status_change','企業ステータスを変更',old.company_status || ' → ' || new.company_status);
 end if;
 return new;
end;
$$;
revoke all on function private.log_company_status() from public,anon,authenticated;
create trigger log_company_status after update of company_status on public.companies
for each row execute function private.log_company_status();

