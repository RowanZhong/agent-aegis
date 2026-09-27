"""Synthetic native Hermes hook/IPC/lock benchmark; no model or DWS execution."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gc
import itertools
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
import tracemalloc
import yaml


def main():
    p=argparse.ArgumentParser()
    for key in ["repo","baseline","host","output"]:p.add_argument("--"+key,required=True)
    p.add_argument("--arm",choices=["baseline","off","on"])
    a=p.parse_args();out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
    if not a.arm:
        for arm in ["baseline","off","on"]:
            subprocess.run([sys.executable,__file__,"--repo",a.repo,"--baseline",a.baseline,"--host",a.host,
                "--output",str(out),"--arm",arm],check=True)
        reports=[json.loads((out/(arm+".json")).read_text()) for arm in ["baseline","off","on"]]
        (out/"report.json").write_text(json.dumps(reports,indent=2));return
    sys.path.insert(0,a.host)
    from hermes_cli.plugins import PluginManager,PluginManifest
    from hermes_constants import set_hermes_home_override,reset_hermes_home_override
    root=Path(a.baseline if a.arm=="baseline" else a.repo).resolve()
    home=out/a.arm;home.mkdir(exist_ok=True)
    # Same test-only heap observer for all arms; actual worker and dispatch are
    # unchanged. No port/service. Sampling happens between timed workloads.
    heap_file=home/"node-heap.json"
    probe=home/"heap-probe.cjs"
    probe.write_text("process.on('SIGUSR2',()=>{global.gc();require('node:fs').writeFileSync("+json.dumps(str(heap_file))+",JSON.stringify({...process.memoryUsage(),cpuUsage:process.cpuUsage()}));});\n")
    wrapper=home/"node-probe"
    import shlex
    wrapper.write_text("#!/bin/sh\nexec "+shlex.quote(shutil.which("node"))+" --expose-gc --require "+shlex.quote(str(probe))+" \"$@\"\n")
    wrapper.chmod(0o700)
    config={"plugins":{"enabled":["agent-aegis"],"entries":{"agent-aegis":{"settings":{
        "dwsReplyGuardEnabled":a.arm=="on","nodeExecutable":str(wrapper)}}}}}
    (home/"config.yaml").write_text(yaml.safe_dump(config))
    os.environ["HERMES_HOME"]=str(home);os.environ["TERMINAL_CWD"]=str(home)
    token=set_hermes_home_override(home)
    tracemalloc.start();gc.collect();python_before=tracemalloc.get_traced_memory()[0]
    start=time.perf_counter();manager=PluginManager()
    manager._load_plugin(PluginManifest(name="agent-aegis",key="agent-aegis",version="2026.3.14",description="resource test",source="user",path=root))
    assert manager._plugins["agent-aegis"].enabled
    startup_ms=(time.perf_counter()-start)*1000
    callback=manager._hooks["pre_tool_call"][0]
    while hasattr(callback,"__wrapped__"):callback=callback.__wrapped__
    adapter=next(c.cell_contents for c in callback.__closure__ if hasattr(c.cell_contents,"bridge"))
    bridge=adapter.bridge;pid=bridge.process.pid
    gate=threading.local();waits={"adapter":[],"ipc":[]};holds={"adapter":[],"ipc":[]}
    class TimedLock:
        def __init__(self,lock,label):self.lock,self.label=lock,label;self.local=threading.local()
        def __enter__(self):
            start=time.perf_counter();self.lock.__enter__();self.local.started=time.perf_counter()
            if getattr(gate,"enabled",False):waits[self.label].append((self.local.started-start)*1000)
            return self
        def __exit__(self,*args):
            if getattr(gate,"enabled",False):holds[self.label].append((time.perf_counter()-self.local.started)*1000)
            return self.lock.__exit__(*args)
    adapter.lock=TimedLock(adapter.lock,"adapter");bridge.lock=TimedLock(bridge.lock,"ipc")
    script=home/"risk.py"
    script.write_text('''import json, subprocess, requests
raw = subprocess.check_output(["dws","chat","message","list","--group","cid-bench","--profile","corp:owner"], text=True)
data = json.loads(raw)
for m in data["messages"]:
    if m["senderOpenDingTalkId"] != "self-open":
        response = requests.post("http://localhost:1234/v1/chat/completions", json={"model":"test","messages":[{"role":"user","content":m["text"]}]})
        answer = response.json()["choices"][0]["message"]["content"]
        subprocess.run(["dws","chat","+messages-send","--group","cid-bench","--profile","corp:owner","--text",answer])
''')
    source={"success":True,"messages":[{"messageId":"m","conversationId":"cid-bench","senderOpenDingTalkId":"other-open","senderId":"other-open","text":"Which fruit?"}]}
    serial=itertools.count()
    def sample(kind):
        sid="bench-"+str(next(serial));ctx={"session_id":sid,"task_id":sid,"turn_id":sid,"platform":"cli"}
        def invoke(hook,**kw):
            result=manager.invoke_hook(hook,**ctx,**kw);return result[0] if result else None
        invoke("pre_llm_call",user_message="Read an incoming fruit question and reply")
        done={}
        def plan(ids,n):
            invoke("pre_api_request",api_request_id="api"+str(n),retry_count=0,request_messages=[{"role":"tool","tool_call_id":id,"content":text} for id,text in done.items()])
            invoke("post_api_request",api_request_id="api"+str(n),assistant_message={"tool_calls":[{"id":id} for id in ids]})
        def result(id,command,value,n):
            invoke("pre_tool_call",tool_name="terminal",args={"command":command},tool_call_id=id,api_request_id="api"+str(n))
            text=json.dumps({"exit_code":0,"output":json.dumps(value)})
            invoke("transform_tool_result",tool_name="terminal",result=text,tool_call_id=id)
            done[id]=text
        if kind!="unrelated":
            plan(["auth","self"],1)
            result("auth","dws auth status --profile corp:owner",{"success":True,"authenticated":True,"token_valid":True,"corp_id":"corp","user_id":"owner"},1)
            result("self","dws aisearch person --keyword owner --profile corp:owner",{"success":True,"result":[{"userId":"owner","openDingTalkId":"self-open"}]},1)
            plan(["read"],2);result("read","dws chat message list --group cid-bench --profile corp:owner",source,2);plan(["send"],3)
        if kind=="unrelated":tool,args="read_file",{"path":"ordinary.txt"}
        else:tool,args="terminal",{"command":("python3 "+str(script)) if kind=="script" else "dws chat +messages-send --group cid-bench --profile corp:owner --text 'Fresh answer'"}
        gate.enabled=True;start=time.perf_counter()
        response=invoke("pre_tool_call",tool_name=tool,args=args,tool_call_id="send",api_request_id="api3")
        elapsed=(time.perf_counter()-start)*1000;gate.enabled=False
        expected=a.arm=="on" and kind!="unrelated"
        assert bool(response and response.get("action")=="block")==expected,(kind,response)
        invoke("on_session_end")
        return elapsed
    def q(values):
        v=sorted(values);return {"n":len(v),"p50_ms":v[len(v)//2],"p95_ms":v[int(len(v)*.95)],"p99_ms":v[int(len(v)*.99)],"max_ms":v[-1]}
    metrics=[];workload_start=time.perf_counter();cpu_start=time.process_time()
    for kind in ["unrelated","dws-send","script"]:
        for _ in range(5):sample(kind)
        for concurrency in [1,4]:
            for d in (waits,holds):
                for key in d:d[key].clear()
            if concurrency==1:values=[sample(kind) for _ in range(60)]
            else:
                with ThreadPoolExecutor(max_workers=4) as pool:values=list(pool.map(lambda _:sample(kind),range(60)))
            metrics.append({"kind":kind,"concurrency":concurrency,"hook":q(values),"samples_ms":values,"lockWait":{k:q(v) for k,v in waits.items()},"lockHold":{k:q(v) for k,v in holds.items()}})
    gc.collect();python_after=tracemalloc.get_traced_memory()[0]
    os.kill(pid,signal.SIGUSR2)
    for _ in range(100):
        if heap_file.exists():break
        time.sleep(.01)
    node_memory=json.loads(heap_file.read_text())
    rss=lambda p:int(subprocess.check_output(["ps","-o","rss=","-p",str(p)],text=True).strip())*1024
    report={"arm":a.arm,"scope":"Hermes v2026.8.19 native PluginManager + actual adapter/worker; synthetic successful tool results; no commands or model calls executed",
        "startup_ms":startup_ms,"metrics":metrics,"pythonTracedDelta":python_after-python_before,"nodeMemory":node_memory,
        "pythonRss":rss(os.getpid()),"nodeRss":rss(pid),"threads":threading.active_count(),"workerPidReused":bridge.process.pid==pid,"observationHours":0,
        "workloadWallMs":(time.perf_counter()-workload_start)*1000,"pythonCpuMs":(time.process_time()-cpu_start)*1000,
        "logBytes":sum(p.stat().st_size for p in home.rglob('*.jsonl'))}
    (out/(a.arm+".json")).write_text(json.dumps(report,indent=2));print(json.dumps({"arm":a.arm,"startup_ms":startup_ms,"workerPidReused":report["workerPidReused"]}),flush=True)
    manager.unload();reset_hermes_home_override(token)


if __name__=="__main__":main()
