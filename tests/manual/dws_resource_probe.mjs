// Synthetic hook/resource measurements: no DWS, model or shell execution.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {performance,monitorEventLoopDelay} from "node:perf_hooks";

const [repo,baseline,hostRoot,out]=process.argv.slice(2);
const onlyArm=process.argv[6];
assert(repo&&baseline&&hostRoot&&out);
await fs.mkdir(out,{recursive:true});
const host=await import(pathToFileURL(path.join(hostRoot,"dist/plugins/hook-runner-global.js")));
const version=JSON.parse(await fs.readFile(path.join(hostRoot,"package.json"))).version;
const ctx={agentId:"main",sessionKey:"resource-session",runId:"resource-run",toolCallId:"send"};
const prompt="Read the external fruit question and reply.";
const read="dws chat message list --group cid-resource --profile corp:owner --format json";
const send="dws chat +messages-send --group cid-resource --profile corp:owner --text 'New fruit answer'";
const source={success:true,messages:[{messageId:"m1",conversationId:"cid-resource",senderId:"other-open",senderOpenDingTalkId:"other-open",text:"Which fruit?"}]};
const script=`import json, subprocess, requests
raw = subprocess.check_output(["dws","chat","message","list","--group","cid-resource","--profile","corp:owner"], text=True)
data = json.loads(raw)
for m in data["messages"]:
    if m["senderOpenDingTalkId"] != "self-open":
        response = requests.post("http://localhost:1234/v1/chat/completions", json={"model":"test","messages":[{"role":"user","content":m["text"]}]})
        answer = response.json()["choices"][0]["message"]["content"]
        subprocess.run(["dws","chat","+messages-send","--group","cid-resource","--profile","corp:owner","--text",answer])
`;
for(const size of [8192,65536])await fs.writeFile(path.join(out,`script-${size}.py`),script+"#"+" ".repeat(size-Buffer.byteLength(script)-2)+"\n");
const quantiles=a=>{const b=[...a].sort((a,b)=>a-b);return {n:b.length,p50_ms:b[Math.floor(b.length*.5)],p95_ms:b[Math.floor(b.length*.95)],p99_ms:b[Math.floor(b.length*.99)],max_ms:b.at(-1)};};
let logs=0,logBytes=0;
const log=s=>{logs++;logBytes+=Buffer.byteLength(s);};
async function setup(root,enabled,label){
 const registrations=[];
 const {createClawAegisRuntime}=await import(pathToFileURL(path.join(root,"src/handlers.js")));
 const {registerClawAegisPlugin}=await import(pathToFileURL(path.join(root,"index.js")));
 const api={rootDir:root,config:{agents:{defaults:{}}},pluginConfig:{dwsReplyGuardEnabled:enabled},
  logger:{info:log,warn:log,error:log},runtime:{state:{resolveStateDir:()=>path.join(out,label)}},
  getPluginConfig:()=>undefined,resolvePath:p=>path.resolve(p),on:(hookName,handler,opts)=>registrations.push({pluginId:"agent-aegis",hookName,handler,...opts})};
 let runtime;registerClawAegisPlugin(api,a=>{runtime=createClawAegisRuntime(a);return runtime;});
 await runtime.dwsReplyGuard?.ready();
 const g=runtime.dwsReplyGuard;
 if(g&&enabled){
  g.begin(prompt,ctx,true);
  let n=0;
  const plan=ids=>{const id="model"+(++n);g.model({callId:id,contextTokenBudget:64000},ctx);g.model({callId:id,outcome:"completed"},ctx,true);g.transcript({role:"assistant",provider:"test",model:"test",content:ids.map(id=>({type:"toolCall",id}))},ctx);};
  const result=(id,value)=>g.transcript({role:"toolResult",toolCallId:id,content:[{type:"text",text:JSON.stringify(value)}],details:{status:"completed",exitCode:0}},ctx);
  plan(["auth","people"]);
  g.before({toolName:"exec",params:{command:"dws auth status --profile corp:owner"}},{...ctx,toolCallId:"auth"});
  result("auth",{success:true,authenticated:true,token_valid:true,corp_id:"corp",user_id:"owner"});
  g.before({toolName:"exec",params:{command:"dws aisearch person --keyword owner --profile corp:owner"}},{...ctx,toolCallId:"people"});
  result("people",{success:true,result:[{userId:"owner",openDingTalkId:"self-open"}]});
  plan(["read"]);g.before({toolName:"exec",params:{command:read}},{...ctx,toolCallId:"read"});result("read",source);plan(["send"]);
 }
 return {runtime,registrations};
}
const samples={},metrics=[],memory=[];
const lag=monitorEventLoopDelay({resolution:10});lag.enable();
for(const [label,root,enabled] of [["baseline",baseline,false],["off",repo,false],["on",repo,true]].filter(([label])=>!onlyArm||onlyArm===label)){
 global.gc?.();const before=process.memoryUsage(),cpuStart=process.cpuUsage(),started=performance.now();
 const {runtime,registrations}=await setup(root,enabled,label);
 global.gc?.();memory.push({label,startup_ms:performance.now()-started,before,after:process.memoryUsage()});
 host.resetGlobalHookRunner();host.initializeGlobalHookRunner({plugins:[{id:"agent-aegis",status:"loaded"}],typedHooks:registrations,hooks:[],trustedToolPolicies:[]});
 const runner=host.getGlobalHookRunner();
 for(const [name,event,n] of [
  ["unrelated",{toolName:"read",params:{path:"ordinary.txt"}},800],
  ["dws-send",{toolName:"exec",params:{command:send}},400],
  ...[8192,65536].map(size=>[`script-${size}`,{toolName:"exec",params:{command:`python3 ${path.join(out,`script-${size}.py`)}`}},200]),
  ["large-unrelated",{toolName:"read",params:{path:"ordinary.txt",extra:"x".repeat(65536)}},200]]){
  const times=[];const logsBefore=logs,bytesBefore=logBytes;
  for(let i=0;i<n+25;i++){
   runtime.state.clearSessionRuntimeState(ctx.sessionKey);runtime.state.clearRunToolCalls(ctx.runId);runtime.state.clearRunSecurityState(ctx.runId);
   runtime.state.notePromptSnapshot(ctx.sessionKey,prompt);
   const start=performance.now();const result=await runner.runBeforeToolCall({...event,toolCallId:"send"},ctx);const elapsed=performance.now()-start;
   if(enabled&&["dws-send","script-8192","script-65536"].includes(name))assert.equal(result?.block,true);
   else assert(!result?.block);
   if(i>=25)times.push(elapsed);
  }
  samples[label+"/"+name]=times;
  metrics.push({label,name,...quantiles(times),logRecords:logs-logsBefore,logBytes:logBytes-bytesBefore});
 }
 runtime.hooks.agent_end({},ctx);runtime.dwsReplyGuard?.clear();
 global.gc?.();memory.at(-1).afterCleanup=process.memoryUsage();memory.at(-1).cpu=process.cpuUsage(cpuStart);
 host.resetGlobalHookRunner();
}
const paired=[];
for(const name of ["unrelated","dws-send","script-8192","script-65536","large-unrelated"]){
 const on=samples["on/"+name],off=samples["off/"+name];if(on&&off)paired.push({name,...quantiles(on.map((v,i)=>v-off[i]))});
}
lag.disable();
const report={host:version,node:process.version,cpu:os.cpus()[0].model,cpus:os.cpus().length,memoryBytes:os.totalmem(),
 scope:"Pinned native hook dispatcher with synthetic fixtures; no tool execution. Counter logger; guard audit uses existing asynchronous writer. "+(onlyArm?"Independent process, single arm.":"Warm sequential arms; paired differences are indexed samples, not subtracted percentiles."),
 metrics,pairedOnMinusOff:paired,memory,eventLoop:{mean_ms:lag.mean/1e6,p99_ms:lag.percentile(99)/1e6,max_ms:lag.max/1e6},
 state: "cleared after each arm",resourceObservationHours:0};
await fs.writeFile(path.join(out,"report.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify({host:version,metrics,pairedOnMinusOff:paired}));
