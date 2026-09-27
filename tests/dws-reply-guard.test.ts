import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DwsReplyGuard, DWS_REPLY_BLOCK, openclawTranscriptCompatible, type ReplyContext } from "../src/dws-reply-guard/index.js";
import { dwsArgv, parseCommand } from "../src/dws-reply-guard/command.js";
import { analyzeScript } from "../src/dws-reply-guard/script.js";
import { externalMessages, resultObject, type Identity } from "../src/dws-reply-guard/events.js";
import { resolveClawAegisPluginConfig } from "../src/config.js";

const profile="corp:owner", self="open-owner", other="open-other", cid="cid-test";
const identity:Identity={profile,userId:"owner",openId:self,aliases:new Map([["other",other]])};
const auth=`dws auth status --profile ${profile} --format json`;
const people=`dws aisearch person --keyword Owner --dimension name --profile ${profile} --format json`;
const read=`dws chat message list --group ${cid} --profile ${profile} --format json`;
const send=(body="Generated answer",target=cid)=>`dws chat +messages-send --group '${target}' --text '${body}' --profile ${profile} --format json --yes`;
const incoming={success:true,messages:[{messageId:"msg1",conversationId:cid,text:"Recommend a fruit",senderId:other,senderOpenDingTalkId:other}]};
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
function fixture(host:"hermes"|"openclaw"="hermes",mode:"off"|"observe"|"enforce"="enforce",prompt="Read the message and reply with a fruit recommendation.",owner=true){
  let currentPrompt=prompt,now=100;
  let hostConfig:any={agents:{defaults:{}}};
  const audits:any[]=[],g=new DwsReplyGuard({mode,now:()=>now,prompt:()=>currentPrompt,audit:e=>audits.push(e),
    openclawContext:agent=>openclawTranscriptCompatible(hostConfig,agent)});
  const ctx:ReplyContext={host,agentId:"a",sessionKey:"s",runId:"r"};
  let count=0,api="",results:string[]=[];const fingerprints:Record<string,string[]>={};
  g.begin(prompt,ctx,owner);
  function plan(ids:string[],opts:{results?:string[];retry?:number;missingEnd?:boolean;clearedBody?:boolean}={}){
    api=`api${++count}`;
    if(host==="hermes"){
      g.apiStart({id:api,complete:true,retry:opts.retry??0,toolResultIds:opts.results??results,toolResultFingerprints:opts.clearedBody?{}:fingerprints},ctx);
      if(!opts.missingEnd)g.apiEnd({id:api,complete:true,toolCallIds:ids},ctx);
    }else{
      g.model({callId:api,contextTokenBudget:64000},ctx);
      if(!opts.missingEnd)g.model({callId:api,outcome:"completed"},ctx,true);
      g.transcript({role:"assistant",provider:"test",model:"test",content:ids.map(id=>({type:"toolCall",id,name:"exec",arguments:{}}))},ctx);
    }
  }
  const before=(id:string,command:string,override:ReplyContext={})=>g.before({toolName:"exec",params:{command}}, {...ctx,toolCallId:id,...(host==="hermes"?{apiRequestId:api}:{}),...override});
  function result(id:string,value:unknown,error=false){
    results.push(id);
    fingerprints[id]=externalMessages(dwsArgv(["dws","chat","message","list","--profile",profile])!,value,identity).map(m=>m.fingerprint);
    if(host==="hermes")g.result({exit_code:error?1:0,output:JSON.stringify(value)},error,{...ctx,toolCallId:id});
    else g.transcript({role:"toolResult",toolCallId:id,isError:error,content:[{type:"text",text:JSON.stringify(value)}],details:{status:"completed",exitCode:error?1:0}},ctx);
  }
  function verified(){
    plan(["auth","people"]);
    before("auth",auth);result("auth",{success:true,authenticated:true,token_valid:true,corp_id:"corp",user_id:"owner"});
    before("people",people);result("people",{success:true,result:[{userId:"owner",openDingTalkId:self},{userId:"other",openDingTalkId:other}]});
  }
  function source(value:unknown=incoming){plan(["read"]);before("read",read);result("read",value);}
  return {g,ctx,audits,plan,before,result,verified,source,setHostConfig:(cfg:unknown)=>{hostConfig=cfg;},setPrompt:(p:string)=>{currentPrompt=p;},advance:()=>{now+=300_001;}};
}

describe.each(["hermes","openclaw"] as const)("%s native causal evidence",host=>{
  it("blocks only after verified external data enters a later completed model plan",async()=>{
    const f=fixture(host);f.verified();f.source();f.plan(["send"]);
    expect(await f.before("send",send())).toEqual({block:true,blockReason:DWS_REPLY_BLOCK});
    expect(f.audits.at(-1)).toMatchObject({rule:"dws_agent_reply",result:"blocked"});
    expect(JSON.stringify(f.audits)).not.toContain("Generated answer");
  });
  it("does not join a preplanned read and send, even when read finishes first",async()=>{
    const f=fixture(host);f.verified();f.plan(["read","send"]);f.before("read",read);f.result("read",incoming);
    expect(await f.before("send",send())).toBeUndefined();
  });
  it("preserves the causal decision for native send and literal argument aliases",async()=>{
    const f=fixture(host);f.verified();f.source();f.plan(["send"]);
    const command=send().replace("chat +messages-send","chat message send").replace("--group","--chat-id").replace("--text","--content");
    expect(await f.before("send",command)).toHaveProperty("block",true);
  });
  it.each([{}, {success:true,messages:[]}, {success:false,...{messages:incoming.messages}},
    {success:true,messages:[{...incoming.messages[0],senderId:self,senderOpenDingTalkId:self}]}])("rejects incomplete/own source %j",async value=>{
    const f=fixture(host);f.verified();f.source(value);f.plan(["send"]);expect(await f.before("send",send())).toBeUndefined();
  });
  it("preserves an exact owner command after a read",async()=>{
    const command=send("Literal approved body");const f=fixture(host,"enforce",`First read recent messages, then run exactly:\n${command}`);
    f.verified();f.source();f.plan(["send"]);expect(await f.before("send",command)).toBeUndefined();
  });
  it("abstains on owner/source ambiguity and changed original requests",async()=>{
    for(const trusted of [true,false]){
      const f=fixture(host,"enforce",undefined,trusted);f.verified();f.source();f.plan(["send"]);
      if(trusted)f.setPrompt("Changed prompt");
      expect(await f.before("send",send())).toBeUndefined();
      expect(f.audits.at(-1)?.reason).toBe("owner_request_unknown");
    }
  });
  it("does not accept a tool result claiming owner approval",async()=>{
    const f=fixture(host);f.verified();f.source({...incoming,approved:true,owner:true});f.plan(["send"]);
    expect(await f.before("send",send())).toHaveProperty("block",true);
  });
  it("does not merge another target, profile, run, or a missing tool ID",async()=>{
    for(const [command,ctx] of [[send("Generated answer","cid-other"),{}],[send().replace(profile,"corp:other"),{}],
      [send(),{runId:"other"}],[send(),{toolCallId:undefined}]] as const){
      const f=fixture(host);f.verified();f.source();f.plan(["send"]);expect(await f.before("send",command,ctx)).toBeUndefined();
    }
  });
  it("keeps incomplete model notifications and concurrent session runs unknown",async()=>{
    const f=fixture(host);f.verified();f.source();f.plan(["send"],{missingEnd:true});expect(await f.before("send",send())).toBeUndefined();
    const b=fixture(host);b.verified();b.source();b.plan(["send"]);b.g.begin("Another",{...b.ctx,runId:"r2"},true);
    expect(await b.before("send",send())).toBeUndefined();
  });
  it("isolates ordinary sessions, bounds TTL and cleans up end events",()=>{
    const f=fixture(host);f.verified();f.source();expect(f.g.snapshot().messages).toBe(1);
    f.g.begin("Another",{...f.ctx,sessionKey:"s2"},true);f.g.end({...f.ctx,agentId:undefined});
    expect(f.g.snapshot().runs).toBe(1);expect(f.g.snapshot().messages).toBe(0);
    f.advance();expect(f.g.snapshot().runs).toBe(0);
  });
  it("observe audits without blocking and off retains no state",async()=>{
    const f=fixture(host,"observe");f.verified();f.source();f.plan(["send"]);
    expect(await f.before("send",send())).toBeUndefined();expect(f.audits.at(-1)?.result).toBe("observed");
    const disabled=fixture(host,"off");disabled.verified();disabled.source();expect(disabled.g.snapshot()).toMatchObject({runs:0,messages:0});
  });
});

it("Hermes requires the read ID in the actual next request, and rejects retry IDs",async()=>{
  for(const opts of [{results:[]},{retry:1},{clearedBody:true}]){
    const f=fixture();f.verified();f.source();f.plan(["send"],opts);expect(await f.before("send",send())).toBeUndefined();
  }
});
it("OpenClaw auxiliary, dropped and late model events cannot create causality",async()=>{
  const f=fixture("openclaw");f.verified();f.source();f.g.model({callId:"aux"},f.ctx);f.plan(["send"]);
  expect(await f.before("send",send())).toBeUndefined();
});
it("OpenClaw does not promote historical or prunable transcript results into current model input",async()=>{
  for(const cfg of [undefined,{agents:{defaults:{contextPruning:{mode:"cache-ttl",keepLastAssistants:0}}}},
    {agents:{defaults:{}},plugins:{slots:{contextEngine:"custom"}}},
    {agents:{defaults:{contextLimits:{toolResultMaxChars:1}}}}]){
    const f=fixture("openclaw");f.setHostConfig(cfg);f.verified();f.source();f.plan(["send"]);
    expect(await f.before("send",send())).toBeUndefined();
  }
  const f=fixture("openclaw");f.verified();f.source();f.plan([]);f.plan(["send"]);
  expect(await f.before("send",send())).toBeUndefined();
});

const sourceCode=`import json, subprocess, requests
raw = subprocess.check_output(["dws", "chat", "message", "list", "--group", "cid-test", "--profile", "corp:owner", "--format", "json"], text=True)
data = json.loads(raw)
for message in data["messages"]:
    if message["senderOpenDingTalkId"] != "open-owner":
        response = requests.post("http://127.0.0.1:8888/v1/chat/completions", json={"model": "test", "messages": [{"role": "user", "content": message["text"]}]})
        answer = response.json()["choices"][0]["message"]["content"]
        subprocess.run(["dws", "chat", "+messages-send", "--group", "cid-test", "--profile", "corp:owner", "--text", answer], check=True)
`;
const analyze=(code:string,lang:"python"|"shell"="python",stdin?:ReturnType<typeof dwsArgv>)=>analyzeScript(code,lang,stdin,()=>identity,performance.now()+1000);
it("caps aggregate metadata even with maximum-length IDs, then reclaims its allocation credits",()=>{
  const g=new DwsReplyGuard({mode:"enforce",prompt:()=>"",openclawContext:()=>true});
  for(let i=0;i<64;i++){
    const ctx={agentId:"a",sessionKey:`s${i}`+"x".repeat(480),runId:`r${i}`+"y".repeat(480)};
    g.begin("",ctx,true);
    for(let j=0;j<64;j++){
      const id=`t${i}-${j}`+"z".repeat(470);
      g.model({callId:id,contextTokenBudget:64000},ctx);g.model({callId:id,outcome:"completed"},ctx,true);
      g.transcript({role:"assistant",provider:"p",model:"m",content:[{type:"toolCall",id}]},ctx);
      g.before({toolName:"exec",params:{command:auth}},{...ctx,toolCallId:id});
    }
  }
  expect(g.snapshot().metadataBytes).toBeLessThanOrEqual(g.snapshot().metadataLimit);
  expect(g.snapshot().counters.capacity_exceeded).toBeGreaterThan(0);
  g.clear();expect(g.snapshot()).toMatchObject({runs:0,messages:0,metadataBytes:0});
  const ctx={sessionKey:"new",runId:"new"};g.begin("",ctx,true);expect(g.snapshot().runs).toBe(1);
  g.end(ctx);expect(g.snapshot().metadataBytes).toBe(0);
});
describe("bounded Python data flow",()=>{
  it("does not confuse JSON file decoding or custom object hooks with an unchanged string body",()=>{
    expect(analyze(sourceCode.replace("json.loads(raw)","json.load(raw)"))).toBe("unsupported_syntax");
    expect(analyze(sourceCode.replace("json.loads(raw)","json.loads(raw, object_hook=str)"))).toBe("unsupported_syntax");
  });
  it("distinguishes raw Responses JSON from the SDK output_text convenience property",()=>{
    const wire=sourceCode.replace("/v1/chat/completions","/v1/responses").replace('"messages": [{','"input": [{')
      .replace('response.json()["choices"][0]["message"]["content"]','response.json()["output"][0]["content"][0]["text"]');
    expect(analyze(wire)).toBe("match");
    expect(analyze(wire.replace('["output"][0]["content"][0]["text"]','["output_text"]'))).not.toBe("match");
    const sdk=sourceCode.replace("import json, subprocess, requests","import json, subprocess\nfrom openai import OpenAI\nclient = OpenAI()")
      .replace('requests.post("http://127.0.0.1:8888/v1/chat/completions", json={"model": "test", "messages": [{"role": "user", "content": message["text"]}]})',
        'client.responses.create(model="test", input=[{"role":"user","content":message["text"]}])')
      .replace('response.json()["choices"][0]["message"]["content"]','response.output_text');
    expect(analyze(sdk)).toBe("match");
  });
  it("proves each read/model/body edge through assignment and loop",()=>expect(analyze(sourceCode)).toBe("match"));
  it.each(['executable="/bin/echo"', 'env={"DWS_CONFIG_DIR":"/tmp/other"}', 'cwd="/tmp"'])("abstains when subprocess changes execution identity: %s",override=>{
    expect(analyze(sourceCode.replace("check=True)",`check=True, ${override})`))).not.toBe("match");
    expect(analyze(sourceCode.replace("text=True)",`text=True, ${override})`))).not.toBe("match");
  });
  it("does not treat Requests json as the transmitted body when data overrides it",()=>{
    expect(analyze(sourceCode.replace('json={"model": "test"', 'data="constant unrelated body", json={"model": "test"'))).not.toBe("match");
  });
  it("abstains on HTTP hooks and SDK extra-body overrides",()=>{
    expect(analyze(sourceCode.replace('json={"model": "test"', 'hooks={"response": replace_response}, json={"model": "test"'))).not.toBe("match");
    const code=sourceCode.replace("import json, subprocess, requests", "import json, subprocess\nfrom openai import OpenAI\nclient = OpenAI()")
      .replace('requests.post("http://127.0.0.1:8888/v1/chat/completions", json={"model": "test", "messages": [{"role": "user", "content": message["text"]}]})',
        'client.chat.completions.create(model="test", messages=[{"role":"user","content":message["text"]}], extra_body={"messages":[{"role":"user","content":"constant"}]})')
      .replace('response.json()["choices"][0]["message"]["content"]','response.choices[0].message.content');
    expect(analyze(code)).not.toBe("match");
  });
  it("supports native SDK, alias and response content extraction",()=>{
    const code=sourceCode.replace("import json, subprocess, requests","import json, subprocess\nfrom openai import OpenAI as Client\nclient = Client()")
      .replace('requests.post("http://127.0.0.1:8888/v1/chat/completions", json={"model": "test", "messages": [{"role": "user", "content": message["text"]}]})',
        'client.chat.completions.create(model="test", messages=[{"role": "user", "content": message["text"]}])')
      .replace('response.json()["choices"][0]["message"]["content"]','response.choices[0].message.content');
    expect(analyze(code)).toBe("match");
  });
  it("supports a standard-library HTTP request and its decoded response body",()=>{
    const code=sourceCode.replace("import json, subprocess, requests","import json, subprocess, urllib.request")
      .replace('response = requests.post("http://127.0.0.1:8888/v1/chat/completions", json={"model": "test", "messages": [{"role": "user", "content": message["text"]}]})',
        'request = urllib.request.Request("http://127.0.0.1:8888/v1/chat/completions", data=json.dumps({"model":"test","messages":[{"role":"user","content":message["text"]}]}).encode("utf-8"), headers={"Content-Type":"application/json"}, method="POST")\n        response = urllib.request.urlopen(request, timeout=60)')
      .replace('response.json()["choices"][0]["message"]["content"]','json.loads(response.read().decode("utf-8"))["choices"][0]["message"]["content"]');
    expect(analyze(code)).toBe("match");
    expect(analyze(code.replace('"--text", answer','"--text", "已知悉"'))).toBe("clear");
  });
  it("supports piped JSON read and a shell wrapper, never runs script imports",()=>{
    const code=sourceCode.replace("import json, subprocess, requests","import json, subprocess, requests, sys")
      .replace(/raw = .*\n/,"raw = sys.stdin.read()\n");
    const parsed=parseCommand(read+" | python3 -c "+quote(code));expect(parsed.kind).toBe("script");
    if(parsed.kind==="script")expect(analyzeScript(parsed.script.code!,"python",parsed.script.stdin,()=>identity,performance.now()+1000)).toBe("match");
    expect(analyze("#!/bin/sh\npython3 -c "+quote(sourceCode),"shell")).toBe("match");
  });
  it("recognizes the DWS 1.0.58 projected NDJSON listener fields on stdin",()=>{
    const parsed=parseCommand("dws event +listen-im --kind sender --open-dingtalk-id open-other --events message --duration 1m --profile corp:owner --format ndjson | python3 -c "+quote(`import json, subprocess, requests, sys
for line in sys.stdin:
    message = json.loads(line)
    if message["sender_open_dingtalk_id"] != "open-owner":
        response = requests.post("https://model.example/v1/chat/completions", json={"model":"test","messages":[{"role":"user","content":message["content"]}]})
        answer = response.json()["choices"][0]["message"]["content"]
        subprocess.run(["dws","chat","+messages-send","--group","cid-test","--profile","corp:owner","--text",answer])
`));
    expect(parsed.kind).toBe("script");
    if(parsed.kind==="script")expect(analyzeScript(parsed.script.code!,"python",parsed.script.stdin,()=>identity,performance.now()+1000)).toBe("match");
  });
  it.each([
    sourceCode.replace('"--text", answer','"--text", "已知悉"'),
    sourceCode.replace('"content": message["text"]','"content": "Unrelated question"'),
    sourceCode.replace('"--text", answer','"--text", templates[answer]').replace("data = json.loads(raw)",'templates = {"ACK": "已知悉", "THANKS": "谢谢"}\ndata = json.loads(raw)'),
    sourceCode.replace("/v1/chat/completions","/ordinary-http"),
    sourceCode.replace('answer = response.json()["choices"][0]["message"]["content"]','answer = "Known template"'),
  ])("never turns mere API co-occurrence or a fixed template into a block",code=>expect(analyze(code)).not.toBe("match"));
  it.each([
    sourceCode.replace('message["senderOpenDingTalkId"] != "open-owner"','message["senderOpenDingTalkId"] != "unknown"'),
    "# dws -> model -> send\nprint('No execution')",
    sourceCode+"\neval('mutate everything')\n",
    "def nested():\n"+sourceCode.split("\n").map(l=>"    "+l).join("\n"),
    sourceCode.replace('"--profile", "corp:owner"','"--profile", selected_profile'),
  ])("abstains on unsupported identity or syntax",code=>expect(analyze(code)).not.toBe("match"));
  it("stops on budget and invalid syntax",()=>{
    expect(analyzeScript(sourceCode,"python",undefined,()=>identity,performance.now()-1)).toBe("budget_exceeded");
    expect(analyze(sourceCode+"???")).toBe("unsupported_syntax");
  });
});

const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(p=>fs.rm(p,{force:true,recursive:true})));});
describe("entry-file and command boundaries",()=>{
  it("blocks a real single file before execution through the async hook",async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"aegis-dws-"));dirs.push(dir);await fs.writeFile(path.join(dir,"risk.py"),sourceCode);
    const f=fixture();await f.g.ready();f.verified();f.plan(["script"]);
    expect(await f.before("script","python3 "+quote(path.join(dir,"risk.py")))).toHaveProperty("block",true);
    expect(await f.before("script","python3 relative.py")).toBeUndefined();
    expect(f.audits.at(-1)?.reason).toBe("missing_context");
  });
  it("bounds slow file reads and ignores late completion",async()=>{
    const f=fixture();f.verified();const close=vi.fn().mockResolvedValue(undefined),stat=vi.fn();
    let finish!:(handle:any)=>void;
    vi.spyOn(fs,"open").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}) as any);
    const start=performance.now();expect(await f.before("script","python3 /slow.py")).toBeUndefined();
    expect(performance.now()-start).toBeLessThan(250);expect(f.audits.at(-1)?.reason).toBe("budget_exceeded");
    finish({stat,close});await new Promise(r=>setTimeout(r,5));expect(stat).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
  });
  it("rejects symlinks, directories, oversized files, substitutions and compound commands",async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"aegis-dws-"));dirs.push(dir);await fs.writeFile(path.join(dir,"large.py"),"#".repeat(65537));
    await fs.symlink(path.join(dir,"large.py"),path.join(dir,"link.py"));await fs.mkdir(path.join(dir,"dir.py"));
    const f=fixture();f.verified();
    for(const file of ["large.py","link.py","dir.py"])expect(await f.before("script","python3 "+quote(path.join(dir,file)))).toBeUndefined();
    for(const command of ['dws chat +messages-send --text "$(danger)"',read+"; "+send(),read+" --jq '.messages'",read+" --profile corp:other"])
      expect(parseCommand(command).kind).toBe("unknown");
  });
  it("distinguishes scalar JSON, incomplete tool outputs and foreign IDs",()=>{
    expect(resultObject({exit_code:1,output:JSON.stringify(incoming)})).toBeUndefined();
    expect(resultObject({content:[{type:"text",text:JSON.stringify(incoming)}],details:{status:"running"}})).toBeUndefined();
    const command=dwsArgv(["dws","chat","message","list","--profile",profile])!;
    expect(externalMessages(command,{...incoming,messages:[{...incoming.messages[0],senderOpenDingTalkId:undefined}]},identity)).toEqual([]);
  });
});
it("configuration opts in independently and inherits the existing default mode",()=>{
  const config=(raw:Record<string,unknown>)=>resolveClawAegisPluginConfig({pluginConfig:raw} as any);
  expect(config({})).toMatchObject({dwsReplyGuardEnabled:false,dwsReplyGuardMode:"off"});
  expect(config({dwsReplyGuardEnabled:true})).toMatchObject({dwsReplyGuardEnabled:true,dwsReplyGuardMode:"enforce"});
  expect(config({dwsReplyGuardEnabled:true,defaultBlockingMode:"off"})).toMatchObject({dwsReplyGuardEnabled:false,dwsReplyGuardMode:"off"});
  expect(config({dwsReplyGuardEnabled:true,defaultBlockingMode:"observe"})).toMatchObject({dwsReplyGuardEnabled:true,dwsReplyGuardMode:"observe"});
  expect(config({dwsReplyGuardEnabled:true,allDefensesEnabled:false})).toMatchObject({dwsReplyGuardEnabled:false,dwsReplyGuardMode:"off"});
});
