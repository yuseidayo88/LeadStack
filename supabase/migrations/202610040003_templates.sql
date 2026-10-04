-- Master templates are migrated into production; no fake CRM or user data.
insert into public.improvement_types(slug,name,category,default_question) values
 ('project_management','案件管理','build','案件の進捗は現在何を使って管理していますか？'),
 ('estimate','見積作成効率化','build','見積書はどのように作成し、過去の見積を探していますか？'),
 ('daily_report','現場日報','build','現場からの日報をどのように集めていますか？'),
 ('photo_management','施工写真管理','build','施工写真を案件別にどのように整理していますか？'),
 ('schedule','スケジュール管理','build','担当者や現場の予定をどのように共有していますか？'),
 ('maintenance','定期点検管理','build','次の定期点検をどのように把握していますか？'),
 ('customer_management','顧客管理','build','お客様とのやり取りをどこに記録していますか？'),
 ('reporting','報告書作成','build','報告書作成にはどのくらい時間がかかりますか？'),
 ('workflow_automation','ワークフロー自動化','automate','複数ツールの間で繰り返している作業はありますか？'),
 ('data_entry_automation','転記自動化','automate','同じ情報を複数の場所に入力していますか？'),
 ('cost_management','原価管理','build','案件ごとの原価をどのように確認していますか？'),
 ('aftercare','アフター対応','build','施工後の問い合わせやフォローをどのように記録していますか？'),
 ('inquiry_management','問い合わせ管理','build','問い合わせの対応漏れをどのように防いでいますか？');
insert into public.industry_recommendations(industry,improvement_type_id,priority)
 select v.industry,t.id,v.priority from (values
 ('電気工事','project_management',1),('電気工事','estimate',2),('電気工事','daily_report',3),('電気工事','photo_management',4),('電気工事','schedule',5),
 ('空調・設備','project_management',1),('空調・設備','maintenance',2),('空調・設備','estimate',3),('空調・設備','schedule',4),('空調・設備','reporting',5),
 ('内装','estimate',1),('内装','project_management',2),('内装','photo_management',3),('内装','cost_management',4),('内装','schedule',5),
 ('リフォーム','customer_management',1),('リフォーム','estimate',2),('リフォーム','project_management',3),('リフォーム','photo_management',4),('リフォーム','aftercare',5),
 ('建物メンテナンス','maintenance',1),('建物メンテナンス','customer_management',2),('建物メンテナンス','schedule',3),('建物メンテナンス','reporting',4),('建物メンテナンス','inquiry_management',5)
 ) as v(industry,slug,priority) join public.improvement_types t on t.slug = v.slug;

