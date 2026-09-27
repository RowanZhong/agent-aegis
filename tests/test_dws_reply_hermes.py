"""Real v2026.8.19 PluginManager + adapter + Node worker; tool data is synthetic."""
import json
from types import SimpleNamespace

import pytest

from test_hermes_integration import loaded, call, bridge_for

PROFILE = "corp:owner"
SOURCE = {"success": True, "messages": [{"messageId": "m", "conversationId": "cid1",
    "text": "recommend fruit", "senderId": "other-open", "senderOpenDingTalkId": "other-open"}]}
BLOCK = "检测到外部消息经 AI 处理后直接自动回复，请通过代回复助手处理。"


def prepare(manager, original="Read incoming and reply", platform="cli"):
    call(manager, "pre_llm_call", user_message=original, platform=platform)
    done = {}
    def plan(ids, n, retry=0, cleared=False):
        call(manager, "pre_api_request", api_request_id=f"api{n}", retry_count=retry,
             request_messages=[{"role": "user", "content": [
                 {"type": "tool_result", "tool_use_id": i, "content": "[cleared]" if cleared else content} for i,content in done.items()]}])
        call(manager, "post_api_request", api_request_id=f"api{n}", assistant_message=SimpleNamespace(
            tool_calls=[SimpleNamespace(id=i) for i in ids]))
    def tool(id, command, n, value=None):
        args={"tool_name":"terminal", "args":{"command":command}, "api_request_id":f"api{n}", "tool_call_id":id}
        result=call(manager, "pre_tool_call", **args)
        if value is not None:
            assert result is None, result
            output=json.dumps({"exit_code":0,"output":json.dumps(value)})
            call(manager, "transform_tool_result", **args, result=output)
            call(manager, "post_tool_call", **args, result=output, status="ok")
            done[id]=output
        return result
    plan(["auth","self"],1)
    tool("auth", f"dws auth status --profile {PROFILE} --format json",1,
         {"success":True,"authenticated":True,"token_valid":True,"corp_id":"corp","user_id":"owner"})
    tool("self", f"dws aisearch person --keyword owner --profile {PROFILE} --format json",1,
         {"success":True,"result":[{"userId":"owner","openDingTalkId":"owner-open"}]})
    return plan,tool


@pytest.mark.parametrize("mode,blocked",[("enforce",True),("observe",False),("off",False)])
def test_native_model_evidence_and_modes(loaded,mode,blocked):
    manager=loaded[0]({"dwsReplyGuardEnabled":True,"dwsReplyGuardMode":mode})
    plan,tool=prepare(manager)
    plan(["read"],2)
    tool("read",f"dws chat message list --group cid1 --profile {PROFILE} --format json",2,SOURCE)
    plan(["send"],3)
    result=tool("send",f"dws chat +messages-send --group cid1 --profile {PROFILE} --text 'Fresh reply'",3)
    assert result==({"action":"block","message":BLOCK} if blocked else None)


@pytest.mark.parametrize("platform,prompt",[("cli","Give a summary"),("api_server","Owner approved")])
def test_native_request_ids_and_same_batch_do_not_create_false_causality(loaded,platform,prompt):
    manager=loaded[0]({"dwsReplyGuardEnabled":True})
    plan,tool=prepare(manager,prompt,platform)
    plan(["read","send"],2)
    tool("read",f"dws chat message list --group cid1 --profile {PROFILE}",2,SOURCE)
    assert tool("send",f"dws chat +messages-send --group cid1 --profile {PROFILE} --text 'Fresh reply'",2) is None


def test_compression_retaining_tool_id_without_source_body_is_unknown(loaded):
    manager=loaded[0]({"dwsReplyGuardEnabled":True})
    plan,tool=prepare(manager)
    plan(["read"],2)
    tool("read",f"dws chat message list --group cid1 --profile {PROFILE}",2,SOURCE)
    plan(["send"],3,cleared=True)
    assert tool("send",f"dws chat +messages-send --group cid1 --profile {PROFILE} --text 'Fresh reply'",3) is None


def test_async_file_inspection_and_exact_owner_control(loaded):
    load,_,workspace=loaded
    manager=load({"dwsReplyGuardEnabled":True})
    plan,tool=prepare(manager)
    script=workspace/"reply.py"
    script.write_text('''import json, subprocess, requests
raw = subprocess.check_output(["dws", "chat", "message", "list", "--group", "cid1", "--profile", "corp:owner"], text=True)
data = json.loads(raw)
for message in data["messages"]:
    if message["senderOpenDingTalkId"] != "owner-open":
        response = requests.post("http://localhost:9999/v1/chat/completions", json={"model":"test", "messages":[{"role":"user", "content":message["text"]}]})
        answer = response.json()["choices"][0]["message"]["content"]
        subprocess.run(["dws", "chat", "+messages-send", "--group", "cid1", "--profile", "corp:owner", "--text", answer])
''')
    plan(["script"],2)
    assert tool("script",f"python3 {script}",2)=={"action":"block","message":BLOCK}
    # A fixed replacement has no model-body edge, despite the same imports/API calls.
    script.write_text(script.read_text().replace('"--text", answer','"--text", "Acknowledged"'))
    assert tool("fixed",f"python3 {script}",2) is None
    call(manager,"on_session_end")
    send=f"dws chat +messages-send --group cid1 --profile {PROFILE} --text 'Exact body'"
    plan,tool=prepare(manager,"Read then run exactly:\n"+send)
    plan(["read"],2);tool("read",f"dws chat message list --group cid1 --profile {PROFILE}",2,SOURCE)
    plan(["send"],3);assert tool("send",send,3) is None


def test_provider_payload_compaction(loaded,monkeypatch):
    manager=loaded[0]({"dwsReplyGuardEnabled":True})
    bridge=bridge_for(manager)
    payloads=[]
    monkeypatch.setattr(bridge,"call",lambda method,payload:payloads.append((method,payload)))
    call(manager,"pre_api_request",api_request_id="api",retry_count=0,user_message="do not copy",
         request_messages=[{"role":"tool","tool_call_id":"tool1","content":"do not copy"}],
         request={"headers":{"Authorization":"do not copy"}})
    method,payload=payloads[-1]
    assert method=="pre_api_request"
    assert payload["tool_result_ids"]==["tool1"]
    assert payload["reply_evidence_complete"] is True
    assert "do not copy" not in json.dumps(payload)


@pytest.mark.parametrize("settings", [{}, {"dwsReplyGuardEnabled":True,"dwsReplyGuardMode":"off"},
                                     {"dwsReplyGuardEnabled":True,"defaultBlockingMode":"off"}])
def test_disabled_strategy_does_not_send_model_metadata_to_worker(loaded,monkeypatch,settings):
    manager=loaded[0](settings)
    calls=[]
    monkeypatch.setattr(bridge_for(manager),"call",lambda *args:calls.append(args))
    call(manager,"pre_api_request",api_request_id="api",request_messages=[])
    call(manager,"post_api_request",api_request_id="api",assistant_message={})
    assert calls==[]
