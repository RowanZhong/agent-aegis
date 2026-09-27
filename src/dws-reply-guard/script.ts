import { parser } from "@lezer/python";
import { performance } from "node:perf_hooks";
import { dwsArgv, parseCommand, MAX_INPUT, type DwsCommand } from "./command.js";
import type { Identity } from "./events.js";
type Node=ReturnType<typeof parser.parse>["topNode"];
type Source={id:number;command:DwsCommand;identity:Identity};
type Value={kind:"unknown"}|{kind:"literal";value:string|number|boolean|null}|{kind:"array";items:Value[]}|
  {kind:"dict";items:Map<string,Value>}|{kind:"name";name:string}|
  {kind:"data";source:Source;level:"raw"|"root"|"rows"|"message";row?:string}|
  {kind:"sender";source:Source;row:string;namespace:"open"|"user"}|
  {kind:"input"|"reply";source:Source}|{kind:"model";source:Source;path:(string|number)[];api:"chat"|"responses"|"anthropic";http?:boolean;wire?:boolean}|
  {kind:"request";source:Source;api:"chat"|"responses"}|{kind:"encoded";value:Value};
const U:Value={kind:"unknown"};
const children=(n:Node)=>{const a:Node[]=[];for(let c=n.firstChild;c;c=c.nextSibling)a.push(c);return a;};
const expressions=(n:Node)=>children(n).filter(c=>!['(',')','[',']','{','}',',',':','Comment'].includes(c.name));
type Scope={vars:Map<string,Value>;external:Set<string>};

/** Abstract interpretation of a deliberately small Python subset, never execution.
 * Unknown control flow, mutation, calls and parse errors abstain for the whole file.
 */
export function analyzeScript(code:string,language:"python"|"shell",stdin:DwsCommand|undefined,
  identity:(command:DwsCommand)=>Identity|undefined,deadline:number):"match"|"clear"|"unsupported_syntax"|"budget_exceeded"{
  if(Buffer.byteLength(code)>MAX_INPUT)return "unsupported_syntax";
  if(language==="shell"){
    const candidate=parseCommand(code.replace(/^#![^\n]*\n/,""));
    if(candidate.kind!=="script"||candidate.script.language!=="python"||candidate.script.code===undefined)return "unsupported_syntax";
    return analyzeScript(candidate.script.code,"python",candidate.script.stdin??stdin,identity,deadline);
  }
  let steps=0,nextSource=0,matched=false,unsupported=false;
  const budget=()=>{if(++steps>16000||performance.now()>deadline)throw new Error("budget");};
  const text=(n:Node)=>code.slice(n.from,n.to);
  const constant=(v:Value)=>v.kind==="literal"?v.value:undefined;
  const string=(v:Value)=>typeof constant(v)==="string"?constant(v) as string:undefined;
  function source(command:DwsCommand):Source|undefined{
    const self=identity(command);if(!self||command.kind!=="read")return;
    return {id:++nextSource,command,identity:self};
  }
  const piped=stdin?source(stdin):undefined;
  function literal(n:Node):Value{
    const s=text(n);
    if(n.name==="Boolean")return {kind:"literal",value:s==="True"};
    if(n.name==="None")return {kind:"literal",value:null};
    if(n.name==="Number"&&/^\d+$/.test(s))return {kind:"literal",value:Number(s)};
    if(n.name!=="String")return U;
    // Exact single/double literals; reject f/bytes/raw/triple/concatenated strings.
    if(!/^(['"])[\s\S]*\1$/.test(s)||s.startsWith("'''" )||s.startsWith('"""'))return U;
    let value="";
    for(let i=1;i<s.length-1;i++){
      if(s[i]!=="\\"){value+=s[i];continue;}
      const c=s[++i],simple:Record<string,string>={n:"\n",r:"\r",t:"\t","\\":"\\","'":"'",'"':'"'};
      if(c in simple)value+=simple[c];
      else if(c==="u"&&/^[0-9a-f]{4}$/i.test(s.slice(i+1,i+5))){value+=String.fromCharCode(parseInt(s.slice(i+1,i+5),16));i+=4;}
      else return U;
    }
    return {kind:"literal",value};
  }
  function member(value:Value,key:string|number,scope:Scope):Value{
    if(value.kind==="name")return {kind:"name",name:`${value.name}.${key}`};
    if(value.kind==="dict"&&typeof key==="string")return value.items.get(key)??U;
    if(value.kind==="array"&&typeof key==="number")return value.items[key]??U;
    if(value.kind==="data"){
      if(value.level==="root"&&key==="result")return value;
      if(value.level==="root"&&key==="messages")return {...value,level:"rows"};
      if(value.level==="rows"&&typeof key==="number")return {...value,level:"message",row:String(key)};
      if(value.level==="message"){
        if(["senderId","senderOpenDingTalkId","senderUserId","sender_open_dingtalk_id"].includes(String(key)))return {kind:"sender",source:value.source,row:value.row!,namespace:key==="senderUserId"?"user":"open"};
        if(["text","content"].includes(String(key))&&scope.external.has(`${value.source.id}:${value.row}`))return {kind:"input",source:value.source};
      }
    }
    if(value.kind==="model"&&!value.http){
      const p=[...value.path,key];const expected=value.api==="chat"?["choices",0,"message","content"]:value.api==="anthropic"?["content",0,"text"]:value.wire?["output",0,"content",0,"text"]:["output_text"];
      if(p.every((x,i)=>x===expected[i]))return p.length===expected.length?{kind:"reply",source:value.source}:{...value,path:p};
    }
    return U;
  }
  function args(n:Node,scope:Scope):{pos:Value[];kw:Map<string,Value>}{
    const nodes=expressions(n),pos:Value[]=[],kw=new Map<string,Value>();
    for(let i=0;i<nodes.length;i++){
      if(nodes[i].name==="VariableName"&&nodes[i+1]?.name==="AssignOp"){
        const key=text(nodes[i]);if(kw.has(key)){unsupported=true;return {pos,kw};}
        kw.set(key,evaluate(nodes[i+2],scope));i+=2;
      }else pos.push(evaluate(nodes[i],scope));
    }
    return {pos,kw};
  }
  function inputOf(messages:Value|undefined):Source|undefined{
    if(messages?.kind!=="array")return;
    let found:Source|undefined;
    for(const m of messages.items){
      if(m.kind!=="dict")continue;
      const v=m.items.get("content");
      if(v?.kind==="input"){
        if(found&&found.id!==v.source.id)return;
        found=v.source;
      }
    }
    return found;
  }
  function apiFor(url:string|undefined):"chat"|"responses"|undefined{
    if(!url)return;try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return;
      if(/\/(?:v1\/)?chat\/completions$/.test(u.pathname))return "chat";
      if(/\/v1\/responses$/.test(u.pathname))return "responses";
    }catch{return;}
  }
  function bodySource(body:Value|undefined,api:"chat"|"responses"):Source|undefined{
    if(body?.kind==="encoded")body=body.value;
    if(body?.kind!=="dict"||!string(body.items.get("model")??U))return;
    return inputOf(body.items.get(api==="chat"?"messages":"input"));
  }
  function call(n:Node,scope:Scope):Value{
    const ns=children(n),callee=ns[0],argumentsNode=ns.find(x=>x.name==="ArgList");
    if(!argumentsNode)return U;
    const a=args(argumentsNode,scope),name=evaluate(callee,scope);
    // Bound, recognized methods whose return preserves a known value.
    if(callee.name==="MemberExpression"){
      const cs=children(callee),receiver=evaluate(cs[0],scope),method=cs.at(-1)?.name==="PropertyName"?text(cs.at(-1)!):"";
      if(method==="json"&&receiver.kind==="model"&&receiver.http&&!a.pos.length&&!a.kw.size)return {...receiver,http:false};
      if(method==="read"&&receiver.kind==="model"&&receiver.http&&!a.pos.length&&!a.kw.size)return receiver;
      if(method==="decode"&&receiver.kind==="model"&&receiver.http&&a.pos.length<=1&&(!a.pos.length||string(a.pos[0])==="utf-8")&&!a.kw.size)return receiver;
      if(method==="encode"&&receiver.kind==="encoded"&&a.pos.length<=1&&(!a.pos.length||string(a.pos[0])==="utf-8")&&!a.kw.size)return receiver;
      if(method==="strip"&&receiver.kind==="reply"&&!a.pos.length&&!a.kw.size)return receiver;
    }
    if(name.kind!=="name"){unsupported=true;return U;}
    const fn=name.name;
    const kwargs=(allowed:string[],maxPos=0)=>{
      if(a.pos.length>maxPos||[...a.kw.keys()].some(key=>!allowed.includes(key))){unsupported=true;return false;}
      return true;
    };
    if(["subprocess.check_output","subprocess.run"].includes(fn)){
      // Popen overrides can replace the executable, DWS profile environment or
      // relative executable resolution. They are outside this literal subset.
      if(!kwargs(["shell","check","text","capture_output","encoding","errors","timeout"],1))return U;
      if(a.kw.has("shell")&&constant(a.kw.get("shell")!)!==false){unsupported=true;return U;}
      const array=a.pos[0];if(array?.kind!=="array")return U;
      const values=array.items,argv=values.map(v=>string(v)??(v.kind==="reply"?"__AEGIS_MODEL_BODY__":"__AEGIS_UNKNOWN__"));
      if(argv.includes("__AEGIS_UNKNOWN__"))return U;
      const command=dwsArgv(argv);if(!command)return U;
      if(command.kind==="send"){
        const index=argv.findIndex(x=>x==="--text"||x==="--content");
        const body=index>=0?values[index+1]:undefined;
        if(body?.kind==="reply"&&command.profile===body.source.command.profile&&command.executable===body.source.command.executable)matched=true;
        return U;
      }
      const s=source(command);if(!s)return U;
      if(fn==="subprocess.check_output")return {kind:"data",source:s,level:"raw"};
      if(constant(a.kw.get("capture_output")??U)===true)return {kind:"dict",items:new Map([["stdout",{kind:"data",source:s,level:"raw"}]])};
      return U;
    }
    if(fn==="json.loads"){
      if(!kwargs([],1))return U;
      const v=a.pos[0];if(v?.kind==="data"&&v.level==="raw")return {...v,level:v.source.command.listen?"message":"root",row:v.row??"one"};
      if(v?.kind==="model")return {...v,http:false};
      return U;
    }
    if(fn==="json.dumps")return kwargs([],1)?{kind:"encoded",value:a.pos[0]??U}:U;
    if(fn==="sys.stdin.read"&&piped&&!a.pos.length)return {kind:"data",source:piped,level:"raw"};
    if(fn==="requests.post"){
      if(!kwargs(["url","json","data","headers","timeout","verify","cert"],1))return U;
      // Requests gives nonempty data precedence over json. Unknown truthiness
      // must not be promoted into an external-message input edge.
      if(a.kw.has("json")&&a.kw.has("data")){unsupported=true;return U;}
      const api=apiFor(string(a.pos[0]??a.kw.get("url")??U));const s=api?bodySource(a.kw.get("json")??a.kw.get("data"),api):undefined;
      if(s&&api)return {kind:"model",source:s,path:[],api,http:true,wire:true};return U;
    }
    if(fn==="urllib.request.Request"){
      if(!kwargs(["data","headers","method"],1)||a.kw.has("method")&&string(a.kw.get("method")!)!=="POST")return U;
      const api=apiFor(string(a.pos[0]??U)),s=api?bodySource(a.kw.get("data"),api):undefined;
      return s&&api?{kind:"request",source:s,api}:U;
    }
    if(fn==="urllib.request.urlopen"){
      if(!kwargs(["timeout"],1))return U;
      const req=a.pos[0];return req?.kind==="request"?{kind:"model",source:req.source,path:[],api:req.api,http:true,wire:true}:U;
    }
    if(fn==="openai.OpenAI"||fn==="anthropic.Anthropic"){
      if(!kwargs(["api_key","base_url","timeout","max_retries"]))return U;
      return {kind:"name",name:fn==="openai.OpenAI"?"$openai":"$anthropic"};
    }
    if(["$openai.chat.completions.create","$openai.responses.create","$anthropic.messages.create"].includes(fn)){
      if(!kwargs(["model","messages","input","system","instructions","temperature","top_p","max_tokens","max_output_tokens","max_completion_tokens","timeout"]))return U;
      if(!string(a.kw.get("model")??U))return U;
      const api=fn==="$openai.responses.create"?"responses":fn==="$anthropic.messages.create"?"anthropic":"chat";
      const s=inputOf(a.kw.get(api==="responses"?"input":"messages"));
      return s?{kind:"model",source:s,path:[],api}:U;
    }
    if(["print","len"].includes(fn))return U;
    // Reading environment for an ordinary SDK/header value neither supplies
    // source evidence nor grants a bypass; it cannot mutate Python locals.
    if(fn==="os.getenv")return U;
    unsupported=true;return U;
  }
  function evaluate(n:Node|undefined,scope:Scope):Value{
    budget();if(!n)return U;
    if(["String","Number","Boolean","None"].includes(n.name))return literal(n);
    if(n.name==="VariableName")return scope.vars.get(text(n))??(["print","len"].includes(text(n))?{kind:"name",name:text(n)}:U);
    if(n.name==="ArrayExpression"||n.name==="TupleExpression")return {kind:"array",items:expressions(n).map(x=>evaluate(x,scope))};
    if(n.name==="DictionaryExpression"){
      const parts=children(n).filter(x=>!["{","}",",","Comment"].includes(x.name)),items=new Map<string,Value>();
      for(let i=0;i<parts.length;i+=3){const key=string(evaluate(parts[i],scope));if(key===undefined||parts[i+1]?.name!==":"||items.has(key)){unsupported=true;return U;}items.set(key,evaluate(parts[i+2],scope));}
      return {kind:"dict",items};
    }
    if(n.name==="MemberExpression"){
      const c=children(n),base=evaluate(c[0],scope),key=c[1]?.name==="."?text(c[2]):constant(evaluate(c[2],scope));
      return typeof key==="string"||typeof key==="number"?member(base,key,scope):U;
    }
    if(n.name==="CallExpression")return call(n,scope);
    if(n.name==="ParenthesizedExpression")return evaluate(expressions(n)[0],scope);
    if(n.name==="BinaryExpression"){
      const c=children(n),a=evaluate(c[0],scope),b=evaluate(c[2],scope);
      if(text(c[1])==="+"){
        if(a.kind==="reply"&&b.kind==="literal")return a;
        if(b.kind==="reply"&&a.kind==="literal")return b;
        if(a.kind==="literal"&&b.kind==="literal"&&typeof a.value==="string"&&typeof b.value==="string")return {kind:"literal",value:a.value+b.value};
      }return U;
    }
    unsupported=true;return U;
  }
  function externalCondition(n:Node,scope:Scope):string|undefined{
    if(n.name!=="BinaryExpression")return;const c=children(n),left=evaluate(c[0],scope),right=string(evaluate(c[2],scope));
    if(left.kind!=="sender"||right===undefined)return;
    const own=left.namespace==="open"?left.source.identity.openId:left.source.identity.userId;
    if(!own)return;
    if((text(c[1])==="!="&&right===own)||(text(c[1])==="=="&&right!==own))return `${left.source.id}:${left.row}`;
  }
  function statements(n:Node,scope:Scope){
    for(const statement of children(n)){
      budget();if([":","Comment"].includes(statement.name))continue;
      const c=children(statement);
      if(statement.name==="ImportStatement"){
        const raw=text(statement).trim();let m=raw.match(/^import (json|subprocess|requests|sys|os|openai|anthropic|urllib\.request)(?: as (\w+))?$/);
        if(m){scope.vars.set(m[2]??m[1].split('.')[0],{kind:"name",name:m[2]?m[1]:m[1].split('.')[0]});continue;}
        m=raw.match(/^from (openai|anthropic) import (OpenAI|Anthropic)(?: as (\w+))?$/);
        if(m){scope.vars.set(m[3]??m[2],{kind:"name",name:`${m[1]}.${m[2]}`});continue;}
        if(/^import (?:json|subprocess|requests|sys|os|urllib\.request)(?:,\s*(?:json|subprocess|requests|sys|os|urllib\.request))*$/.test(raw)){
          for(const imported of raw.slice(7).split(',').map(s=>s.trim())){
            const name=imported.split('.')[0];scope.vars.set(name,{kind:"name",name});
          }continue;
        }
        unsupported=true;
      }else if(statement.name==="AssignStatement"){
        if(c.length!==3||c[0].name!=="VariableName"||text(c[1])!=="="){unsupported=true;continue;}
        scope.vars.set(text(c[0]),evaluate(c[2],scope));
      }else if(statement.name==="ExpressionStatement")evaluate(c[0],scope);
      else if(statement.name==="ForStatement"){
        const value=evaluate(c[3],scope),body=c.find(x=>x.name==="Body");
        const stream=value.kind==="name"&&value.name==="sys.stdin"&&piped?.command.listen;
        if(c[1]?.name!=="VariableName"||!body||(!stream&&(value.kind!=="data"||value.level!=="rows"))||c.some(x=>x.name==="else")){unsupported=true;continue;}
        const child:Scope={vars:new Map(scope.vars),external:new Set(scope.external)};
        child.vars.set(text(c[1]),stream?{kind:"data",source:piped!,level:"raw",row:`loop:${statement.from}`}:{...value as Extract<Value,{kind:"data"}>,level:"message",row:`loop:${statement.from}`});statements(body,child);
        // Loop assignments may execute zero times. Do not propagate inferred values.
        for(const name of child.vars.keys())if(child.vars.get(name)!==scope.vars.get(name))scope.vars.set(name,U);
      }else if(statement.name==="IfStatement"){
        if(c.length!==3||c[0].name!=="if"||c[2].name!=="Body"){unsupported=true;continue;}
        const external=externalCondition(c[1],scope);
        if(!external){unsupported=true;continue;}
        const child:Scope={vars:new Map(scope.vars),external:new Set(scope.external)};child.external.add(external);statements(c[2],child);
        for(const name of child.vars.keys())if(child.vars.get(name)!==scope.vars.get(name))scope.vars.set(name,U);
      }else if(statement.name==="PassStatement")continue;
      else if(statement.name==="BreakStatement")break;
      else unsupported=true;
    }
  }
  try{
    budget();
    const parsing=parser.startParse(code);let tree=parsing.advance();
    while(!tree){budget();tree=parsing.advance();}
    let error=false;
    tree.iterate({enter(node){budget();if(node.type.isError)error=true;}});
    if(error)return "unsupported_syntax";
    statements(tree.topNode,{vars:new Map(),external:new Set()});
    return unsupported?"unsupported_syntax":matched?"match":"clear";
  }catch{return "budget_exceeded";}
}
