import { performance } from "node:perf_hooks";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const base=path.dirname(fileURLToPath(import.meta.url));
const upstream=path.join(base,"aegis-upstream");
const {createClawAegisRuntime}=await import(pathToFileURL(path.join(upstream,"src/handlers.js")));
const {registerClawAegisPlugin}=await import(pathToFileURL(path.join(upstream,"index.js")));
const mode=process.argv[2]??"bench";
const summaries={environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpu:os.cpus().length,totalMemory:os.totalmem()},scope:"isolated hook/component replay; no tool commands, DWS, network, model, gateway, or production plugin changes",aegisCommit:"23d59b8986b86de448d24ff973e662295768d533",mode};
let logCount=0,logBytes=0;
const log = s=>{logCount++;logBytes+=Buffer.byteLength(String(s));};
function setup(label,config={}) {
 const registrations=[];
 const api={id:"agent-aegis",name:"Agent Aegis",config:{},pluginConfig:{...config},logger:{info:log,warn:log,error:log},source:path.join(upstream,"index.js"),rootDir:upstream,runtime:{state:{resolveStateDir:()=>path.join(base,"runtime",label)}},on:(hookName,handler,options)=>registrations.push({pluginId:"agent-aegis",hookName,handler,...options})};
 let runtime;
 registerClawAegisPlugin(api,a=>{runtime=createClawAegisRuntime(a);return runtime;});
 runtime.state.setProtectedRoots([upstream]);
 return {runtime,registrations};
}
const ctx={sessionKey:"agent:main:bench",sessionId:"bench-session",runId:"bench-run",agentId:"main",toolName:"exec"};
const cmds={
 ordinary:"printf hello",
 read:'dws chat message list --user employee-b --time 1700000000000 --direction newer --limit 20 --format json',
 send:'dws chat +messages-send --as user --user employee-b --text "已知悉" --yes',
 native:'dws chat message send --as user --user employee-b --text "已知悉" --yes',
 listen:'dws event +listen-im --kind sender --user employee-b --events message -f ndjson --duration 0',
 pipeline:"nohup bash -c 'dws event +listen-im --kind sender --user employee-b --events message -f ndjson --duration 0 | python3 ./auto_reply.py' > /dev/null 2>&1 &",
 python:"python3 ./auto_reply.py"
};
const ev=c=>({toolName:"exec",params:{command:c},runId:ctx.runId,toolCallId:"bench-call"});
function fresh(label){return setup(label);}
function describe(x){return x===undefined?"allowed":x;}
if(mode==="bench"){
 const {runtime,registrations}=fresh("bench");
 const before=registrations.find(x=>x.hookName==="before_tool_call").handler;
 const cleanup=()=>{runtime.state.clearRunToolCalls(ctx.runId);runtime.state.clearRunSecurityState(ctx.runId);runtime.state.clearSessionRuntimeState(ctx.sessionKey);};
 const metrics=[];
 async function measure(name,fn,iterations=4000,clean=()=>{}) {
   for(let i=0;i<150;i++){await fn();clean();}
   const count0=logCount,bytes0=logBytes; const times=[];
   const cpu0=process.cpuUsage();const start=performance.now();
   for(let i=0;i<iterations;i++){const t=performance.now();await fn();times.push(performance.now()-t);clean();}
   const wall=performance.now()-start,cpu=process.cpuUsage(cpu0);
   times.sort((a,b)=>a-b);
   metrics.push({name,n:iterations,p50_ms:times[Math.floor(iterations*.5)],p95_ms:times[Math.floor(iterations*.95)],p99_ms:times[Math.floor(iterations*.99)],max_ms:times.at(-1),mean_ms:times.reduce((a,b)=>a+b,0)/iterations,wall_ms:wall,cpu_ms:(cpu.user+cpu.system)/1000,logRecordsPerCall:(logCount-count0)/iterations,logBytesPerCall:(logBytes-bytes0)/iterations});
 }
 for(const k of ["ordinary","read","send","listen","python"]) await measure("Aegis.before."+k,()=>before(ev(cmds[k]),ctx),3000,cleanup);
 const after=registrations.find(x=>x.hookName==="after_tool_call").handler;
 const json=JSON.stringify({messages:[{messageId:"m1",senderId:"employee-b",text:"你好，请问在线文档如何导出 PDF？",conversationId:"c1"}]});
 await measure("Aegis.after.read",()=>after({...ev(cmds.read),result:{content:[{type:"text",text:json}]}},ctx),3000,cleanup);
 const {findDwsSendCommand}=await import("file:///Users/admin/Developer/codexProjects/openclaw-channel-dingtalk-v3.6.11/examples/dws-send-approval/command-policy.mjs");
 await measure("existing-DWS-command-parser.send",()=>findDwsSendCommand(cmds.send,"dws"),10000);
 for(const bytes of [8192,65536]){
   const file=path.join(base,"fixture-"+bytes+".py");
   await fs.writeFile(file,("# synthetic harmless fixture\n").repeat(Math.ceil(bytes/("# synthetic harmless fixture\n").length)).slice(0,bytes));
   assert.equal((await fs.stat(file)).size,bytes);
   await measure("warm-async-read-only."+bytes,()=>fs.readFile(file,"utf8"),1000);
   const payload=JSON.stringify({messages:Array.from({length:Math.floor(bytes/140)},(_,i)=>({messageId:"m"+i,senderId:"b",conversationId:"c",text:"normal external message text"}))});
   await measure("JSON-parse-only.actual-bytes-"+Buffer.byteLength(payload),()=>JSON.parse(payload),3000);
 }
 const normalEvent=ev(cmds.send);
 for(let i=0;i<200;i++){await before(normalEvent,ctx);cleanup();}
 global.gc?.();const startMem=process.memoryUsage();
 for(let i=0;i<10000;i++){await before(normalEvent,ctx);cleanup();}
 global.gc?.();const endMem=process.memoryUsage();
 summaries.metrics=metrics;summaries.cleanedLoopMemory={before:startMem,after:endMem,iterations:10000,warning:"Aegis+V8 microbenchmark only; not proposed guard RSS or container memory"};
}else{
 const hostBase=mode==="old"?"/Users/admin/.local/share/openclaw-compat-v3.6.11/node_modules/openclaw":"/Users/admin/.local/lib/node_modules/openclaw";
 const host=await import(pathToFileURL(path.join(hostBase,"dist/plugins/hook-runner-global.js")));
 summaries.hostVersion=JSON.parse(await fs.readFile(path.join(hostBase,"package.json"),"utf8")).version;
 const results=[];
 function runnerFor(registrations,probe){
   host.resetGlobalHookRunner();
   const hooks=[...registrations,...(probe?[probe]:[])];
   const ids=[...new Set(hooks.map(x=>x.pluginId))];
   host.initializeGlobalHookRunner({plugins:ids.map(id=>({id,status:"loaded"})),typedHooks:hooks,hooks:[],trustedToolPolicies:[]});
   return host.getGlobalHookRunner();
 }
 for(const k of Object.keys(cmds)){
   const a=fresh(mode+"-"+k);const runner=runnerFor(a.registrations);
   const result=await runner.runBeforeToolCall(ev(cmds[k]),ctx);
   results.push({case:k,result:describe(result)});
 }
 {const a=fresh(mode+"-loop"),runner=runnerFor(a.registrations);const calls=[];
 for(let i=0;i<4;i++)calls.push(describe(await runner.runBeforeToolCall(ev(cmds.read),ctx)));
 assert.equal(calls[3].block,true);results.push({case:"same read four times same run",calls});}
 for(const priority of [-100,100]){
   const a=fresh(mode+"-order"+priority);let probeCalls=0;
   const probe={pluginId:"dws-design-test-probe",hookName:"before_tool_call",priority,handler:()=>{probeCalls++;return {block:true,blockReason:"test probe deny"};}};
   const runner=runnerFor(a.registrations,probe);
   const result=await runner.runBeforeToolCall(ev(cmds.send),ctx);
   assert.equal(result.block,true);assert.equal(result.blockReason,"test probe deny");
   results.push({case:"probe deny; Aegis allows",priority,probeCalls,result});
 }
 {const a=fresh(mode+"-aegisdeny");let probeCalls=0;
 const runner=runnerFor(a.registrations,{pluginId:"dws-design-test-probe",hookName:"before_tool_call",priority:-100,handler:()=>{probeCalls++;return undefined;}});
 const result=await runner.runBeforeToolCall(ev("openclaw status"),ctx);
 assert.equal(result.block,true);assert.equal(probeCalls,0);
 results.push({case:"Aegis deny short circuits later probe",probeCalls,result});}
 {const a=fresh(mode+"-allowbeforedeny");let probeCalls=0;
 const runner=runnerFor(a.registrations,{pluginId:"dws-design-test-probe",hookName:"before_tool_call",priority:100,handler:()=>{probeCalls++;return undefined;}});
 const result=await runner.runBeforeToolCall(ev("openclaw status"),ctx);
 assert.equal(result.block,true);assert.equal(probeCalls,1);
 results.push({case:"probe allows; Aegis still denies",probeCalls,result});}
 {const a=fresh(mode+"-sync"),runner=runnerFor(a.registrations);
 const message={role:"assistant",content:[{type:"text",text:"api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789"}]};
 const direct=a.runtime.hooks.before_message_write({message},ctx);
 const wrapped=a.registrations.find(x=>x.hookName==="before_message_write").handler({message},ctx);
 const hostResult=runner.runBeforeMessageWrite({message},ctx);
 assert.ok(wrapped&&typeof wrapped.then==="function");assert.equal(hostResult,undefined);
 results.push({case:"public Aegis async wrapper at synchronous hook",directChanged:!!direct?.message,wrapperReturnsPromise:true,hostResult:"ignored"});
 await wrapped;}
 {const a=fresh(mode+"-script"),runner=runnerFor(a.registrations);
 const script={toolName:"write",params:{path:"./auto_reply.py",content:"import subprocess\nsubprocess.run(['openclaw','agent','--message','hello'])\n"},runId:ctx.runId,toolCallId:"write-1"};
 await runner.runAfterToolCall({...script,result:"ok"},ctx);
 const result=await runner.runBeforeToolCall(ev(cmds.python),ctx);
 results.push({case:"script written in run then calls openclaw CLI",result:describe(result)});}
 const times=[];
 for(const withAegis of [false,true]){
  const a=fresh(mode+"-bench"+withAegis);
  const probe={pluginId:"dws-design-test-probe",hookName:"before_tool_call",priority:-100,handler:()=>undefined};
  const runner=runnerFor(withAegis?a.registrations:[],probe);
  const t=[];
  for(let i=0;i<2200;i++){const st=performance.now();await runner.runBeforeToolCall(ev(cmds.send),ctx);if(i>=200)t.push(performance.now()-st);a.runtime.hooks.agent_end({},ctx);}
  t.sort((a,b)=>a-b);
  times.push({name:withAegis?"actual host + Aegis + noop-probe":"actual host + noop-probe",n:t.length,p50_ms:t[1000],p95_ms:t[1900],p99_ms:t[1980]});
 }
 summaries.results=results;summaries.dispatchBench=times;
 host.resetGlobalHookRunner();
}
await fs.writeFile(path.join(base,"result-"+mode+".json"),JSON.stringify(summaries,null,2)+"\n");
process.stdout.write(JSON.stringify(summaries,null,2)+"\n");
