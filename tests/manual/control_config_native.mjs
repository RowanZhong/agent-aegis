// Opt-in: real installed OpenClaw hook dispatcher, execution wrapper and exec
// tool; fixture files only. Gateway sinks have a tripwire, never restart a host.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
const [repo,hostRoot,out]=process.argv.slice(2);
assert(repo&&hostRoot&&out);
await fs.mkdir(out,{recursive:true});
const work=path.join(out,"workspace"),state=path.join(out,"profile");
await fs.mkdir(work,{recursive:true});await fs.mkdir(state,{recursive:true});
process.env.OPENCLAW_STATE_DIR=state;process.env.OPENCLAW_CONFIG_PATH=path.join(state,"openclaw.json");
const cfg={commands:{restart:false},gateway:{mode:"local"},agents:{defaults:{workspace:work}},plugins:{enabled:false},tools:{exec:{host:"gateway",security:"full",ask:"off"}}};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(cfg));
const version=JSON.parse(await fs.readFile(path.join(hostRoot,"package.json"))).version;
assert(["2026.7.1-2","2026.8.1"].includes(version));
const old=version==="2026.7.1-2";
const imp=p=>import(pathToFileURL(path.join(hostRoot,"dist",p)));
const host=await imp("plugins/hook-runner-global.js");
const wrappers=await imp(old?"agent-tools.before-tool-call-C95DXQXZ.js":"agent-tools.before-tool-call-DSAdl1_z.js");
const wrap=wrappers[old?"p":"u"];
const {r:createExecTool}=await imp(old?"bash-tools-DHyGpWCr.js":"bash-tools-B5hjd3-h.js");
const {t:createOpenClawTools}=await imp(old?"openclaw-tools-KulZ1cdH.js":"openclaw-tools-B6oAovn4.js");
const createWriteTool=old?(await imp("openclaw-tools-KulZ1cdH.js")).g:(await imp("agent-tools.read-B0WHML7t.js")).n;
const {createClawAegisRuntime}=await import(pathToFileURL(path.join(repo,"src/handlers.js")));
const {registerClawAegisPlugin}=await import(pathToFileURL(path.join(repo,"index.js")));
const hooks=[],logs=[];
const api={rootDir:repo,config:cfg,pluginConfig:{skillScanEnabled:false},
 logger:Object.fromEntries(["info","warn","error","debug"].map(k=>[k,s=>logs.push({level:k,message:s})])),
 runtime:{state:{resolveStateDir:()=>state}},getPluginConfig:()=>undefined,resolvePath:p=>path.resolve(p),
 on:(hookName,handler,options)=>hooks.push({pluginId:"agent-aegis",hookName,handler,...options})};
let runtime;registerClawAegisPlugin(api,a=>runtime=createClawAegisRuntime(a,{stateDir:path.join(out,"audit")}));
await runtime.hooks.gateway_start();
host.resetGlobalHookRunner();host.initializeGlobalHookRunner({plugins:[{id:"agent-aegis",status:"loaded"}],typedHooks:hooks,hooks:[],trustedToolPolicies:[]});
const ctx={agentId:"main",sessionKey:"agent:main:control-test",workspaceDir:work,config:cfg};
const runner=host.getGlobalHookRunner(),results=[];
let executed=0;
const nativeExec=createExecTool({cwd:work,host:"gateway",security:"full",ask:"off",allowBackground:false,timeoutSec:10});
const exec=wrap({...nativeExec,execute:async(...args)=>{executed++;return nativeExec.execute(...args);}},ctx,{emitDiagnostics:false});
const nativeWrite=createWriteTool(work);
let writeEntered=0;
const write=wrap({...nativeWrite,execute:async(...args)=>{writeEntered++;return nativeWrite.execute(...args);}},ctx,{emitDiagnostics:false});
const tools=createOpenClawTools({config:cfg,workspaceDir:work,agentSessionKey:ctx.sessionKey,wrapBeforeToolCallHook:false});
const nativeGateway=tools.find(t=>t.name==="gateway");assert(nativeGateway);
let gatewayEntered=0;
const gateway=wrap({...nativeGateway,execute:async()=>{gatewayEntered++;throw Error("Gateway mutation tripwire: no host side effect is permitted in this test");}},ctx,{emitDiagnostics:false});
for(const action of ["restart","config.apply","config.patch","update.run"]){
 const params={action,note:"配置了cati-proxy SSE MCP服务器连接用户本机CATI，重启加载MCP客户端"};
 const decision=await runner.runBeforeToolCall({toolName:"gateway",params},ctx);assert(decision?.block);
 let response;try{response=await gateway.execute("gateway-"+action,params);}catch(e){response={error:String(e)};}
 assert.equal(gatewayEntered,0);results.push({case:action,blocked:true,entered:false,response});
}
for(const action of ["config.get","config.schema.lookup"]){assert(!(await runner.runBeforeToolCall({toolName:"gateway",params:{action,path:"agents.defaults"}},ctx))?.block);results.push({case:action,hookAllowed:true});}
for(const file of ["mcp-servers.json5","agents-list.json5"]){
 const p=path.join(state,file);await fs.writeFile(p,"ORIGINAL");await fs.writeFile(path.join(work,"replacement"),"REPLACEMENT");
 for(const command of [`cat > '${p}' <<'EOF'\n{}\nEOF`,`printf '{}' | tee '${p}'`,`mv ./replacement '${p}'`,`node -e 'require("fs").writeFileSync("${p}","{}")'`,
   `cat <<EOF\n$(printf changed > '${p}')\nEOF`,`sed -i.bak -es/ORIGINAL/CHANGED/ '${p}'`,
   `(cat > '${p}')`,`cat <(printf changed > '${p}')`]){
  const before=executed;let response;try{response=await exec.execute(file+results.length,{command});}catch(e){response={error:String(e)};}
  assert.equal(executed,before);assert.equal(await fs.readFile(p,"utf8"),"ORIGINAL");results.push({case:file,command,blocked:true,entered:false,response});
 }
 const before=writeEntered;let directResponse;
 try{directResponse=await write.execute("direct-"+file,{path:path.relative(work,p),content:"CHANGED",workdir:"/private/tmp/ordinary"});}catch(e){directResponse={error:String(e)};}
 assert.equal(writeEntered,before);assert.equal(await fs.readFile(p,"utf8"),"ORIGINAL");results.push({case:"direct-"+file,blocked:true,entered:false,response:directResponse});
 for(const input of [`*** Begin Patch\n  *** Add File: ${p}\n+changed\n*** End Patch`]){
   assert((await runner.runBeforeToolCall({toolName:"apply_patch",params:{input}},ctx))?.block);results.push({case:"indented-patch-"+file,hookBlocked:true});
 }
 const safe=path.join(work,file);
 const response=await exec.execute("ordinary-"+file,{command:`cat > '${safe}' <<'EOF'\nORDINARY\nEOF`});
 assert.equal((await fs.readFile(safe,"utf8")).trim(),"ORDINARY");results.push({case:"ordinary-"+file,executed:true,response});
 const read=await exec.execute("read-"+file,{command:`cat '${p}'`});assert(JSON.stringify(read).includes("ORIGINAL"));results.push({case:"read-"+file,executed:true});
 await exec.execute("reference-"+file,{command:`touch -r '${p}' '${safe}'`});assert.equal(await fs.readFile(p,"utf8"),"ORIGINAL");results.push({case:"read-reference-"+file,executed:true});
 await write.execute("ordinary-direct-"+file,{path:file,content:"NATIVE_WRITE"});assert.equal(await fs.readFile(safe,"utf8"),"NATIVE_WRITE");results.push({case:"ordinary-direct-"+file,executed:true});
}
await new Promise(r=>setTimeout(r,100));
await fs.writeFile(path.join(out,"report.json"),JSON.stringify({host:version,method:"installed native dispatcher + native execution wrapper; actual native exec/write for allowed controls; gateway sink tripwire; no model inference",gatewayEntered,executed,writeEntered,results},null,2));
await fs.writeFile(path.join(out,"logs.json"),JSON.stringify(logs,null,2));
runtime.hooks.gateway_stop();host.resetGlobalHookRunner();
console.log(JSON.stringify({host:version,passed:results.length,gatewayEntered,executed}));
