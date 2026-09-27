import { MAX_INPUT } from "./command.js";
import { createHash } from "node:crypto";
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
/** Only exact JSON and native tool envelopes; never scrape JSON from logs. */
export function resultObject(value) {
    try {
        let obj = value;
        for (let depth = 0; depth < 4; depth++) {
            if (typeof obj === "string") {
                if (Buffer.byteLength(obj) > MAX_INPUT)
                    return;
                obj = JSON.parse(obj);
                continue;
            }
            if (!obj || typeof obj !== "object" || Array.isArray(obj))
                return;
            if (obj.error || obj.isError || obj.success === false || obj.ok === false || obj.errorCode)
                return;
            if ("exit_code" in obj) {
                if (obj.exit_code !== 0 || typeof obj.output !== "string")
                    return;
                obj = obj.output;
                continue;
            }
            if (Array.isArray(obj.content)) {
                if (obj.details?.status && obj.details.status !== "completed")
                    return;
                if (obj.details?.exitCode != null && obj.details.exitCode !== 0)
                    return;
                if (obj.content.length !== 1 || obj.content[0]?.type !== "text")
                    return;
                obj = obj.content[0].text;
                continue;
            }
            return obj;
        }
    }
    catch {
        return;
    }
}
export function verifiedIdentity(command, value) {
    const obj = resultObject(value);
    if (!obj || command.kind !== "auth" || !command.profile || obj.success !== true || obj.authenticated !== true || obj.token_valid !== true)
        return;
    if (!id(obj.corp_id) || !id(obj.user_id))
        return;
    if (`${obj.corp_id}:${obj.user_id}` !== command.profile)
        return;
    return { profile: command.profile, userId: obj.user_id, aliases: new Map() };
}
export function observePeople(identity, command, value, reserve = () => true) {
    const obj = resultObject(value);
    if (command.kind !== "people" || command.profile !== identity.profile || obj?.success !== true || !Array.isArray(obj.result) || obj.result.length > 32)
        return;
    for (const person of obj.result) {
        if (!id(person.userId) || !id(person.openDingTalkId))
            continue;
        const old = identity.aliases.get(person.userId);
        if (old && old !== person.openDingTalkId) {
            identity.openId = undefined;
            identity.aliases.clear();
            return;
        }
        if (!old && identity.aliases.size < 32) {
            if (!reserve(192 + (person.userId.length + person.openDingTalkId.length) * 2))
                return;
            identity.aliases.set(person.userId, person.openDingTalkId);
        }
        if (person.userId === identity.userId && identity.aliases.get(person.userId) === person.openDingTalkId)
            identity.openId = person.openDingTalkId;
    }
}
export function externalMessages(command, value, identity) {
    const obj = resultObject(value);
    if (command.kind !== "read" || command.listen || command.profile !== identity.profile || obj?.success !== true || !Array.isArray(obj.messages) || obj.messages.length > 32)
        return [];
    const result = [];
    for (const m of obj.messages) {
        if (!m || !id(m.messageId) || !id(m.conversationId) || typeof m.text !== "string" || !m.text || Buffer.byteLength(m.text) > MAX_INPUT)
            continue;
        // DWS 1.0.58 senderId is the open ID, not a staff/user ID.
        const open = id(m.senderOpenDingTalkId) ? m.senderOpenDingTalkId : undefined;
        const user = id(m.senderUserId) ? m.senderUserId : undefined;
        if (open && identity.openId ? open === identity.openId : user ? user === identity.userId : true)
            continue;
        if (open && m.senderId && m.senderId !== open)
            continue;
        const fingerprint = createHash("sha256").update(JSON.stringify([m.messageId, m.conversationId, open ?? null, user ?? null, m.text])).digest("hex");
        result.push({ messageId: m.messageId, conversationId: m.conversationId, senderOpenId: open, senderUserId: user, fingerprint });
    }
    return result;
}
export function sameDestination(command, source, identity) {
    const target = command.target;
    if (!target)
        return false;
    if (command.messageId && command.messageId !== source.messageId)
        return false;
    if (target.kind === "conversation")
        return target.id === source.conversationId;
    if (target.kind === "open")
        return target.id === source.senderOpenId;
    return target.id === source.senderUserId || identity.aliases.get(target.id) === source.senderOpenId;
}
export function targetKey(target) { return target ? `${target.kind}:${target.id}` : ""; }
