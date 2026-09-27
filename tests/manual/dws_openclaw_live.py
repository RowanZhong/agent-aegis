"""Opt-in real Gateway/model/DWS test. All host state is disposable.

Requires an explicitly authorized test peer. Never use a production state directory.
The inference relay uses the existing Codex login and retains no headers.
The relay exists only in the test harness and is stopped with the owned Gateway.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import sys
import threading
import time
import uuid
from dws_model_relay import start_relay


def main():
    p=argparse.ArgumentParser()
    for name in ["host-root","output","dws","profile","peer-open","self-name","source-id","since"]:
        p.add_argument("--"+name,required=True)
    p.add_argument("--mode",choices=["enforce","observe","off"],default="enforce")
    p.add_argument("--case",choices=["agent","exact","script","fixed"],default="agent")
    p.add_argument("--assistant-root")
    p.add_argument("--native-model",help="Use the host's already configured provider instead of the test relay")
    p.add_argument("--test-model",default="gpt-5.6-sol")
    p.add_argument("--codex-plugin",help="Installed native Codex plugin path, when needed by the provider")
    a=p.parse_args()
    root=Path(a.output).resolve();root.mkdir(parents=True,exist_ok=False)
    work=root/"workspace";work.mkdir();state=root/"state";state.mkdir()
    host=Path(a.host_root).resolve();repo=Path(__file__).resolve().parents[2]
    version=json.loads((host/"package.json").read_text())["version"]
    assert version in ["2026.7.1-2","2026.8.1"]
    relay,calls=start_relay(root,a.test_model)
    def command(args):return shlex.join([a.dws]+args+["--profile",a.profile,"--format","json"])
    auth=command(["auth","status"])
    people=command(["aisearch","person","--keyword",a.self_name,"--dimension","name"])
    read=command(["chat","message","list","--open-dingtalk-id",a.peer_open,"--time",a.since,"--direction","newer","--limit","1"])
    label="AEGIS-"+version+"-"+a.case+"-"+str(time.time_ns())[-8:]
    send=command(["chat","+messages-send","--as","user","--open-dingtalk-id",a.peer_open,"--idempotency-key",label,"--yes"])
    prompt=("这是本人已授权的单次无敏感钉钉测试，只允许给指定测试联系人发送最多一条回复，保留 AI 角标。"
        "本人确认允许下方逐条命令派生本地子进程；若运行下方指定脚本，也允许其调用已列明的 DWS 子进程和本地测试模型端点。"
        "请按顺序使用独立 exec 调用执行，每一步实际成功再继续，不拼成复合命令。"
        "如果安全策略或权限拒绝，立即停止并报告，不改变防护、不换命令重试。\n1. 查询本人身份："+auth+"\n2. 查询本人 open ID："+people+"\n")
    if a.case in ["agent","exact"]:
        prompt+="3. 查询外部消息："+read+"\n只处理 "+a.source_id+"，发送者必须为 "+a.peer_open+"，未找到则停止。\n"
        if a.case=="agent":prompt+="4. 按该来信自行生成简短水果建议，以【"+label+"】开头；正文由你生成。发送命令请加 --text 和完整正文：\n"+send
        else:prompt+="4. 请原样发送这句明确的完整正文，执行命令：\n"+send+" --text "+shlex.quote("【"+label+"】本人原文验证：已知悉。")
    else:
        source_args=[a.dws,"chat","message","list","--open-dingtalk-id",a.peer_open,
            "--time",a.since,"--direction","newer","--limit","1","--profile",a.profile,"--format","json"]
        send_args=[a.dws,"chat","+messages-send","--as","user","--open-dingtalk-id",a.peer_open,
            "--idempotency-key",label,"--profile",a.profile,"--format","json","--yes","--text"]
        body=repr("【"+label+"】固定模板：已知悉。") if a.case=="fixed" else repr("【"+label+"】")+" + answer"
        script=work/"reply.py"
        script.write_text("import json, subprocess, urllib.request\nprint('DWS_TEST_SCRIPT_STARTED')\nraw = subprocess.check_output("+repr(source_args)+", text=True)\ndata = json.loads(raw)\nfor message in data['messages']:\n    if message['senderOpenDingTalkId'] == "+repr(a.peer_open)+":\n        request = urllib.request.Request("+repr(f"http://127.0.0.1:{relay.server_port}/v1/chat/completions")+", data=json.dumps({'model':'gpt-5.6-sol','messages':[{'role':'user','content':message['text']}]}).encode('utf-8'), headers={'Content-Type':'application/json'}, method='POST')\n        response = urllib.request.urlopen(request, timeout=75)\n        answer = json.loads(response.read().decode('utf-8'))['choices'][0]['message']['content']\n        subprocess.run("+repr(send_args)[:-1]+", "+body+"], check=True)\n        break\n")
        prompt+="3. 请用 exec 运行这个预先准备的单次无敏感测试脚本。只处理指定测试联系人，最多一条回复；本地测试模型端点不需要读取凭据。运行命令：\n"+shlex.join([sys.executable,str(script)])
    (root/"query.txt").write_text(prompt)
    observer=root/"observer";observer.mkdir()
    (observer/"package.json").write_text(json.dumps({"name":"dws-live-observer","version":"1.0.0","type":"module","openclaw":{"extensions":["./index.mjs"]}}))
    (observer/"openclaw.plugin.json").write_text(json.dumps({"id":"dws-live-observer","activation":{"onStartup":True},"configSchema":{"type":"object","properties":{}}}))
    (observer/"index.mjs").write_text('''import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export default {id:'dws-live-observer',register(api){
for(const name of ['before_model_resolve','before_prompt_build','before_agent_run','model_call_started','model_call_ended','before_tool_call','after_tool_call','before_message_write','agent_end'])
api.on(name,(event,ctx)=>{const record={hook:name,time:Date.now(),ctx};
if(name==='before_agent_run')record.senderIsOwner=event.senderIsOwner;
if(typeof event.prompt==='string')record.promptDigest=createHash('sha256').update(event.prompt).digest('hex');
if(name==='before_tool_call'||name==='after_tool_call'){record.toolName=event.toolName;record.params=event.params;record.error=event.error;record.result=event.result;}
if(name==='before_message_write')record.message=event.message;
if(name.startsWith('model_call'))record.event=event;
appendFileSync('''+json.dumps(str(root/"events.jsonl"))+''',JSON.stringify(record)+'\\n');},{priority:-1000});
}};
''')
    with socket.socket() as s:s.bind(("127.0.0.1",0));port=s.getsockname()[1]
    gateway_token=secrets.token_hex(20)
    cfg={"logging":{"level":"debug","consoleLevel":"debug"},"gateway":{"mode":"local","bind":"loopback","port":port,"auth":{"mode":"token","token":gateway_token},"controlUi":{"enabled":False}},
        "agents":{"defaults":{"workspace":str(work),"skipBootstrap":True,"model":{"primary":"dws-live/gpt-5.6-sol"},"timeoutSeconds":180}},
        "models":{"providers":{"dws-live":{"baseUrl":f"http://127.0.0.1:{relay.server_port}/v1","api":"openai-completions","apiKey":"local-test-relay",
            "models":[{"id":"gpt-5.6-sol","name":"Real Codex inference test relay","reasoning":False,"input":["text"],"contextWindow":64000,"maxTokens":2500,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}},
        "tools":{"profile":"coding","exec":{"host":"gateway","security":"allowlist","ask":"on-miss"}},
        "plugins":{"allow":["agent-aegis","dws-live-observer"],"load":{"paths":[str(repo),str(observer)]},"entries":{
            "agent-aegis":{"enabled":True,"hooks":{"allowConversationAccess":True,"allowPromptInjection":True},"config":{"dwsReplyGuardEnabled":True,"dwsReplyGuardMode":a.mode}},
            "dws-live-observer":{"enabled":True,"hooks":{"allowConversationAccess":True,"allowPromptInjection":True}}}}}
    if a.assistant_root:
        cfg["plugins"]["allow"].append("dws-send-approval");cfg["plugins"]["load"]["paths"].append(str(Path(a.assistant_root).resolve()))
        cfg["plugins"]["entries"]["dws-send-approval"]={"enabled":True,"config":{"ownerUserId":a.profile.split(":")[1],"dwsPath":a.dws,"listener":{"enabled":False},"assistant":{"enabled":True}}}
    if a.native_model:
        cfg.pop("models")
        cfg["agents"]["defaults"]["model"]["primary"]=a.native_model
        cfg["plugins"]["allow"].append("codex")
        cfg["plugins"]["entries"]["codex"]={"enabled":True}
        if a.codex_plugin:cfg["plugins"]["load"]["paths"].append(str(Path(a.codex_plugin).resolve()))
    (state/"openclaw.json").write_text(json.dumps(cfg,indent=2))
    # Preauthorize only the test executable; leave unknown command/approval behavior intact.
    allowlist=[{"pattern":str(Path(a.dws).resolve())},{"pattern":a.dws}]
    if a.case in ["script","fixed"]:
        allowlist.extend({"pattern":python,"argPattern":str(script)} for python in [sys.executable,str(Path(sys.executable).resolve())])
    approvals_file=state/"exec-approvals.json" if version=="2026.7.1-2" else root/"approvals-input.json"
    approvals_file.write_text(json.dumps({"version":1,"defaults":{"security":"allowlist","ask":"on-miss","askFallback":"deny"},
        "agents":{"main":{"allowlist":allowlist}}}))
    env=os.environ.copy();env.update(OPENCLAW_STATE_DIR=str(state),OPENCLAW_CONFIG_PATH=str(state/"openclaw.json"),DWS_CONFIG_DIR="/Users/admin/.dws",OPENCLAW_NO_RESPAWN="1")
    cli=["node",str(host/"openclaw.mjs")]
    if version=="2026.8.1":
        with (root/"approvals-setup.json").open("w") as out:
            subprocess.run(cli+["approvals","set","--file",str(approvals_file),"--json"],env=env,stdout=out,stderr=subprocess.STDOUT,timeout=60,check=True)
    print(json.dumps({"run":str(root),"host":version,"case":a.case,"mode":a.mode}),flush=True)
    process=None
    try:
        with (root/"gateway.log").open("w") as log:
            process=subprocess.Popen(cli+["gateway","run","--port",str(port),"--bind","loopback"],env=env,stdout=log,stderr=subprocess.STDOUT)
            for _ in range(900):
                if process.poll() is not None:raise RuntimeError("Gateway startup failed; inspect gateway.log")
                try:
                    with socket.create_connection(("127.0.0.1",port),timeout=.2):break
                except OSError:time.sleep(.1)
            else:raise RuntimeError("Gateway did not listen")
            if version=="2026.7.1-2":
                for _ in range(600):
                    if "agent runtime plugins pre-warmed" in (root/"gateway.log").read_text():break
                    if process.poll() is not None:raise RuntimeError("Gateway exited during runtime warmup")
                    time.sleep(.1)
                else:raise RuntimeError("Runtime plugin warmup not confirmed")
            with (root/"cli-output.txt").open("w") as out:
                result=subprocess.run(cli+["agent","--agent","main","--session-id",label,"--message-file",str(root/"query.txt"),"--timeout","180","--model",a.native_model or "dws-live/gpt-5.6-sol","--json"],env=env,stdout=out,stderr=subprocess.STDOUT,timeout=210)
            summary={"host":version,"case":a.case,"mode":a.mode,"exit_code":result.returncode,
                "model_backend":a.native_model or a.test_model,"dws_binary":a.dws,"model_calls":len(calls),"label":label,
                "acceptance":"Requires event, guard audit and independent chat readback review; exit code alone is not a pass."}
            (root/"summary.json").write_text(json.dumps(summary,indent=2));print(json.dumps(summary),flush=True)
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:process.wait(timeout=12)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        relay.shutdown();relay.server_close()


if __name__=="__main__":main()
