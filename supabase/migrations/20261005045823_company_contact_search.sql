-- Read-only projections: preserve the underlying tenant and active-session RLS.
-- No data rewrite and no changes to write APIs.
create view public.company_search with (security_invoker = true) as
 select c.*, regexp_replace(translate(coalesce(c.phone,''),
   '０１２３４５６７８９','0123456789'),'[^0-9]','','g') as search_phone
 from public.company_overview c;
create view public.contact_search with (security_invoker = true) as
 select c.*, regexp_replace(translate(coalesce(c.phone,''),
   '０１２３４５６７８９','0123456789'),'[^0-9]','','g') as search_phone
 from public.contacts c;
revoke all on public.company_search,public.contact_search from public,anon,authenticated;
grant select on public.company_search,public.contact_search to authenticated;
