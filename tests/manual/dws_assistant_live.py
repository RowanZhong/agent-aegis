"""Opt-in: up to four assistant sends to an explicitly authorized peer.

Real Gateway, native completion API, unchanged assistant and real DWS. Cards
and owner callback actions are local fixtures, not a DingTalk UI acceptance.
"""
import argparse,json,os,secrets,socket,subprocess,time
from pathlib import Path
from dws_model_relay import start_relay

def main():
 p=argparse.ArgumentParser()
 for k in ['host-root','assistant-root','output','dws','profile','peer-open','source-id','since']:p.add_argument('--'+k,required=True)
 p.add_argument('--cases',nargs='+',choices=['approve','edit','fixed','topic'],default=['approve','edit','fixed','topic'])
 p.add_argument('--test-model',default='gpt-5.6-sol')
 a=p.parse_args();root=Path(a.output).resolve();root.mkdir(parents=True,exist_ok=False)
 repo=Path(__file__).resolve().parents[2];host=Path(a.host_root).resolve();version=json.loads((host/'package.json').read_text())['version']
 assert version in ['2026.7.1-2','2026.8.1']
 relay,calls=start_relay(root,a.test_model);state=root/'state';state.mkdir();work=root/'workspace';work.mkdir();plugin=root/'driver';plugin.mkdir()
 opts={'hostVersion':version,'assistantRoot':a.assistant_root,'output':str(root),'profile':a.profile,'dws':a.dws,'peer':a.peer_open,'sourceId':a.source_id,'since':a.since,'nonce':secrets.token_hex(3),'cases':list(dict.fromkeys(a.cases))}
 (plugin/'package.json').write_text(json.dumps({'name':'assistant-live-driver','version':'1.0.0','type':'module','openclaw':{'extensions':['./index.mjs']}}))
 (plugin/'openclaw.plugin.json').write_text(json.dumps({'id':'assistant-live-driver','activation':{'onStartup':True},'configSchema':{'type':'object','properties':{}}}))
 # The driver's service is not restarted by agent-runtime plugin prewarming.
 (plugin/'index.mjs').write_text("import fs from 'node:fs/promises';\nimport {run} from "+json.dumps((repo/'tests/manual/dws_assistant_live.mjs').as_uri())+";\nexport default {id:'assistant-live-driver',register(api){api.registerService({id:'assistant-live-driver',start(){setTimeout(()=>run(api,"+json.dumps(opts)+").then(cases=>fs.writeFile("+json.dumps(str(root/'completed.json'))+",JSON.stringify({ok:true,cases}))).catch(e=>fs.writeFile("+json.dumps(str(root/'completed.json'))+",JSON.stringify({ok:false,error:String(e),stack:e.stack}))),15000);},stop(){}});}};\n")
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 cfg={'logging':{'level':'debug','consoleLevel':'debug'},'gateway':{'mode':'local','port':port,'bind':'loopback','auth':{'mode':'token','token':secrets.token_hex(20)},'controlUi':{'enabled':False}},
  'agents':{'defaults':{'workspace':str(work),'skipBootstrap':True,'model':{'primary':'dws-live/gpt-5.6-sol'}}},
  'models':{'providers':{'dws-live':{'baseUrl':f'http://127.0.0.1:{relay.server_port}/v1','api':'openai-completions','apiKey':'local-test-relay','models':[{'id':'gpt-5.6-sol','name':'Real inference','contextWindow':64000,'maxTokens':2500,'input':['text'],'reasoning':False,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0}}]}}},
  'plugins':{'allow':['agent-aegis','dws-send-approval','assistant-live-driver'],'load':{'paths':[str(repo),a.assistant_root,str(plugin)]},'entries':{
   'agent-aegis':{'enabled':True,'hooks':{'allowConversationAccess':True,'allowPromptInjection':True},'config':{'dwsReplyGuardEnabled':True,'dwsReplyGuardMode':'enforce'}},
   'dws-send-approval':{'enabled':True,'config':{'ownerUserId':a.profile.split(':')[1],'dwsPath':a.dws,'listener':{'enabled':False},'assistant':{'enabled':True}}},
   'assistant-live-driver':{'enabled':True}}}}
 cfg['agents']['defaults']['model']['primary']='dws-live/'+a.test_model
 cfg['models']['providers']['dws-live']['models'][0]['id']=a.test_model
 (state/'openclaw.json').write_text(json.dumps(cfg));env=os.environ.copy();env.update(OPENCLAW_STATE_DIR=str(state),OPENCLAW_CONFIG_PATH=str(state/'openclaw.json'),DWS_CONFIG_DIR='/Users/admin/.dws',OPENCLAW_NO_RESPAWN='1')
 process=None
 try:
  with (root/'gateway.log').open('w') as log:
   process=subprocess.Popen(['node',str(host/'openclaw.mjs'),'gateway','run','--port',str(port),'--bind','loopback'],env=env,stdout=log,stderr=subprocess.STDOUT)
   for _ in range(1800):
    if (root/'completed.json').exists():break
    if process.poll() is not None:raise RuntimeError('Gateway exited')
    time.sleep(.2)
   else:raise RuntimeError('Assistant test timed out')
   result=json.loads((root/'completed.json').read_text());print(json.dumps({'host':version,'ok':result['ok'],'model_calls':len(calls),'error':result.get('error')}),flush=True)
   assert result['ok'],result.get('error')
 finally:
  if process and process.poll() is None:
   process.terminate()
   try:process.wait(timeout=12)
   except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
  relay.shutdown();relay.server_close()

if __name__=='__main__':main()
