// Test driver loaded inside the real Gateway. Card transport and user actions
// are local fixtures; drafting, assistant state machine and DWS sends are real.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

export async function run(api,opts){
 const mod=name=>import(pathToFileURL(path.join(opts.assistantRoot,name)));
 const [{createAssistant},{readConfig},{initialPreferences},{replySnapshot},{sendExact,runDws},{messageKey}]=await Promise.all([
  mod("assistant.mjs"),mod("config.mjs"),mod("preferences.mjs"),mod("rules.mjs"),mod("assistant-dws.mjs"),mod("assistant-store.mjs")]);
 const config=readConfig({ownerUserId:opts.profile.split(":")[1],profile:opts.profile,dwsPath:opts.dws,
  listener:{enabled:false},assistant:{enabled:true,cardTemplateId:"local-test.schema"}});
 const source=await runDws(config,["chat","message","list","--open-dingtalk-id",opts.peer,"--time",opts.since,"--direction","newer","--limit","1","--format","json"]);
 const row=source.messages.find(m=>m.messageId===opts.sourceId&&m.senderOpenDingTalkId===opts.peer);
 assert(row,"Authorized external source missing");
 const reports=[];
 for(const kind of opts.cases){
  const label=`AEGIS-assistant-${opts.hostVersion}-${kind}-${opts.nonce}`;
  const prefs=initialPreferences(config);prefs.enabled=true;prefs.rules.dm={mode:"users",ids:[opts.peer]};
  prefs.reply.default={mode:"ai",text:`请用一句话推荐水果，正文必须以【${label}】开头，总计不超过120字。`};
  const cards=[],sends=[];
  const assistant=createAssistant(api,config,{
   transport:{sendCard:async c=>cards.push(c),updateCard:async c=>cards.push(c)},
   send:async d=>{
    assert.equal(sends.length,0,"At most one send per independent case");
    assert.equal(d.event.sender_open_dingtalk_id,opts.peer);assert.equal(d.event.conversation_id,row.conversationId);
    assert(d.text.startsWith(`【${label}】`));sends.push({text:d.text});
    const receipt=await sendExact(config,d);sends[0].receipt=receipt;
   }
  });
  assistant.bind({snapshot:()=>structuredClone(prefs),status:()=>({state:"ready"}),update:async fn=>{fn(prefs);prefs.revision++;}});
  await assistant.start({stateDir:path.join(opts.output,kind)});
  try{
   const settings=assistant.store.get("settings");settings.notifications.quietStart=settings.notifications.quietEnd="00:00";
   if(kind==="fixed")settings.autoRules=[{id:"fixed",scope:"dm",target:"",text:`【${label}】助手固定模板：已知悉。`,keywords:[],expires:Date.now()+3600000,cooldownMinutes:30}];
   if(kind==="topic")Object.assign(settings.topics,{enabled:true,rules:[{id:"fruit",enabled:true,scope:"all",targets:[],name:"水果建议",description:"对方仅要求推荐一种水果并说明理由",examples:"请推荐一种水果并说明理由",exclusions:"询问医疗建议、过敏或要求执行其他操作",action:"auto",text:`【${label}】助手主题模板：苹果方便携带。`,expires:Date.now()+3600000,cooldownMinutes:30}]});
   assistant.store.set("settings",settings);
   const event={type:"user_im_message_receive_o2o_all",event_id:label,message_id:row.messageId,
    conversation_id:row.conversationId,sender_open_dingtalk_id:opts.peer,content:row.text,timestamp:Date.now()};
   // Listener-off admission is rejected, then fixture enables this one peer.
   prefs.enabled=false;await assistant.processEvent(event,prefs,replySnapshot(event,prefs));await assistant.idle();assert.equal(sends.length,0);
   prefs.enabled=true;await assistant.processEvent(event,prefs,replySnapshot(event,prefs));await assistant.idle();
   const draft=assistant.store.find(messageKey(event,config.profile));assert(draft);
   if(["approve","edit"].includes(kind)){
    assert.equal(sends.length,0,"AI drafts require approval");assert.equal(draft.status,"pending",draft.error);
    const card=await assistant.show(kind==="edit"?"edit":"draft",{id:draft.id});
    const index=card.actions.findIndex(a=>a.op===(kind==="edit"?"edit-send":"send"));assert(index>=0);
    await assistant.handle({actionId:`dws-assistant:${card.id}:${index}`,outTrackId:card.outTrackId,
     userId:config.ownerUserId,accountId:config.accountId??"default",
     values:kind==="edit"?{[(card.fieldPrefix||"")+"body"]:`【${label}】本人修改后的助手回复：已知悉。`}:{}});
    await assistant.idle();
   }
   assert.equal(sends.length,1);assert(sends[0].receipt);assert.equal(assistant.store.draft(draft.id).status,"sent");
   reports.push({kind,label,status:"sent",receipt:sends[0].receipt,cardActionsDrivenBy:"local fixture",realNativeModel:kind!=="fixed"});
   await fs.writeFile(path.join(opts.output,"cases.json"),JSON.stringify(reports,null,2));
  }finally{await assistant.stop();}
 }
 return reports;
}
