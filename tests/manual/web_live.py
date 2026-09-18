"""Probe a running disposable WebUI. Never point --config at a production profile."""
import argparse,json,stat,time
from pathlib import Path
import urllib.request,urllib.error
p=argparse.ArgumentParser();p.add_argument('--config',type=Path,required=True);p.add_argument('--url',required=True);a=p.parse_args()
token=(a.config/'.aegis-webui-token').read_text().strip()
checks={}
def req(path,method='GET',body=None,auth=True,origin=None):
 headers={}
 if auth:headers['x-aegis-token']=token
 if body is not None:headers['Content-Type']='application/json'
 if origin:headers['Origin']=origin
 r=urllib.request.Request(a.url+path,method=method,headers=headers,data=None if body is None else json.dumps(body).encode())
 try:response=urllib.request.urlopen(r,timeout=5)
 except urllib.error.HTTPError as e:response=e
 return response.status,dict(response.headers),response.read().decode()
checks['public_health']=req('/api/v1/health',auth=False)[0]==200
for path in ['config','status','events','skills','skill-scans']:
 checks['auth_required_'+path]=req('/api/v1/'+path,auth=False)[0]==401
 checks['authorized_'+path]=req('/api/v1/'+path)[0]==200
checks['write_auth_required']=req('/api/v1/config','PUT',{'allDefensesEnabled':False},auth=False)[0]==401
checks['html_has_no_token']=token not in req('/',auth=False)[2]
checks['token_mode_0600']=stat.S_IMODE((a.config/'.aegis-webui-token').stat().st_mode)==0o600
checks['untrusted_origin_no_cors']=not any(k.lower()=='access-control-allow-origin' for k in req('/api/v1/status',origin='https://untrusted.example')[1])
checks['same_origin_allowed']=any(k.lower()=='access-control-allow-origin' and v==a.url for k,v in req('/api/v1/status',origin=a.url)[1].items())
checks['invalid_config_rejected']=req('/api/v1/config','PUT',{'commandBlockMode':'invalid'})[0]==400
checks['config_saved']=req('/api/v1/config','PUT',{'commandBlockMode':'observe'})[0]==200 and json.loads((a.config/'openclaw.plugin.json').read_text())['userConfig']['commandBlockMode']=='observe'
checks['config_readback']=json.loads(req('/api/v1/config')[2])['data']['config']['commandBlockMode']=='observe'
checks['config_reset']=req('/api/v1/config/reset','POST',{})[0]==200 and json.loads(req('/api/v1/config')[2])['data']['config']['commandBlockMode']=='enforce'
checks['actual_event_loaded']=json.loads(req('/api/v1/events?result=blocked')[2])['data']['total']>0
state=a.config/'state';f=state/'defense-events.jsonl'
with f.open('a') as stream:stream.write(json.dumps({'timestamp':int(time.time()*1000),'defense':'manual-canary','result':'observed','reason':'Live watcher fixture'})+'\n')
for _ in range(25):
 data=json.loads(req('/api/v1/events?defense=manual-canary&result=observed')[2])['data']
 if data['total']>0:break
 time.sleep(.2)
checks['event_watch_and_filter']=data['total']==1
# Keep the trusted fixture for the browser removal test.
checks['trusted_skill_loaded']=json.loads(req('/api/v1/skills')[2])['data']['total']==1
checks['integrity_status_loaded']=json.loads(req('/api/v1/status')[2])['data']['integrity']['fingerprintCount']>0
(a.config/'api-report.json').write_text(json.dumps(checks,indent=2))
print(json.dumps(checks,indent=2));assert all(checks.values())
