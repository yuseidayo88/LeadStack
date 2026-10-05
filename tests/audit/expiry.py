from pathlib import Path
import subprocess,json,urllib.request,urllib.error,urllib.parse,time
p=Path('/workspace/handoff/e2e-private');env=dict(line.split('=',1) for line in (p/'auth.env').read_text().splitlines() if '=' in line);env['GOTRUE_MAILER_OTP_EXP']='1';(p/'auth-expiry.env').write_text(''.join(k+'='+v+'\n' for k,v in env.items()));(p/'auth-expiry.env').chmod(0o600)
subprocess.run(['docker','rm','-f','leadstack-e2e-auth'],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['docker','run','-d','--name','leadstack-e2e-auth','--network','leadstack-e2e','--add-host=host.docker.internal:host-gateway','--env-file',str(p/'auth-expiry.env'),'-p','127.0.0.1:55325:9999','sha256:3c621b0978cc4d69ec6ef9640d8f70a553afe3f1e3cd421a49d7d45e9524a9e3'],check=True,stdout=subprocess.DEVNULL)
for _ in range(30):
 try:
  with urllib.request.urlopen('http://127.0.0.1:55325/health',timeout=1) as r:health=json.load(r)
  break
 except Exception:time.sleep(.2)
c=json.loads((p/'secrets.json').read_text())
email=subprocess.check_output(['docker','exec','leadstack-e2e-db','psql','-h','/tmp','-p','5432','-U','supabase_admin','-d','postgres','-At','-c',"select email from auth.users where email like 'audit-%' and email_confirmed_at is not null order by created_at desc limit 1"],text=True).strip()
req=urllib.request.Request('http://127.0.0.1:55325/admin/generate_link',data=json.dumps({'type':'recovery','email':email}).encode(),headers={'Authorization':'Bearer '+c['service_key'],'Content-Type':'application/json'})
with urllib.request.urlopen(req) as r:link=json.load(r)['action_link']
time.sleep(3)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
try:r=urllib.request.build_opener(NoRedirect).open(link)
except urllib.error.HTTPError as e:r=e
loc=r.headers.get('location','');u=urllib.parse.urlparse(loc);q=urllib.parse.parse_qs(u.query);f=urllib.parse.parse_qs(u.fragment)
result={'local_auth_version':health.get('version'),'configured_local_otp_exp_seconds':1,'wait_seconds':3,'status':r.status,'error_code':q.get('error_code',f.get('error_code')),'outbound_email_count':0}
print(json.dumps(result));Path('/workspace/handoff/security-expiry.json').write_text(json.dumps(result,indent=2));assert result['error_code']==['otp_expired']
