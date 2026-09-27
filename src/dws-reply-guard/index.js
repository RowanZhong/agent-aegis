import { promises as fs, constants as FS } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { MAX_INPUT, parseCommand } from "./command.js";
import { externalMessages, observePeople, sameDestination, verifiedIdentity } from "./events.js";
import { digest, ownerRequest } from "./owner-request.js";
export const DWS_REPLY_BLOCK = "检测到外部消息经 AI 处理后直接自动回复，请通过代回复助手处理。";
const TTL = 5 * 60_000, MAX_RUNS = 64, MAX_CALLS = 64, MAX_MESSAGES = 512, SOFT_MS = 50;
// Conservative allocation credits, not a V8 heap measurement. Count strings as
// UTF-16 and reserve object/collection overhead before retaining new evidence.
const MAX_METADATA_BYTES = 64 * 1024;
const stringBytes = (...values) => values.reduce((n, s) => n + (s?.length ?? 0) * 2, 0);
const validId = (s, max = 512) => typeof s === "string" && !!s && s.length <= max;
const contextKey = (c) => validId(c.sessionKey) && validId(c.runId) && (!c.agentId || validId(c.agentId)) ? JSON.stringify([c.agentId ?? "", c.sessionKey, c.runId]) : undefined;
const identityKey = (c) => c.profile ? JSON.stringify([c.executable, c.profile]) : undefined;
/** Pinned OpenClaw PI loop: only the immediately preceding tool batch is used.
 * Cache pruning must retain its last assistant; custom assembly/limits are
 * unknown. This reads host configuration and never changes it.
 */
export function openclawTranscriptCompatible(config, agentId) {
    if (!config || typeof config !== "object")
        return false;
    const cfg = config, defaults = cfg.agents?.defaults;
    if (!defaults || typeof defaults !== "object")
        return false;
    const engine = cfg.plugins?.slots?.contextEngine;
    if (engine !== undefined && engine !== "legacy")
        return false;
    const pruning = defaults.contextPruning;
    if (pruning?.mode !== undefined && !["off", "cache-ttl"].includes(pruning.mode))
        return false;
    if (pruning?.mode !== "off" && pruning?.keepLastAssistants !== undefined &&
        (!Number.isFinite(pruning.keepLastAssistants) || pruning.keepLastAssistants < 1))
        return false;
    const agent = Array.isArray(cfg.agents?.list) ? cfg.agents.list.find((x) => x?.id === agentId) : undefined;
    return !defaults.contextLimits && !agent?.contextLimits && defaults.compaction?.midTurnPrecheck?.enabled !== true;
}
/** Independent, bounded evidence. No messages, scripts, secrets or owner text retained. */
export class DwsReplyGuard {
    options;
    runs = new Map();
    counters = {};
    fileReads = 0;
    metadataBytes = 0;
    constructor(options) {
        this.options = options;
    }
    now() { return (this.options.now ?? Date.now)(); }
    remove(r) { if (this.runs.delete(r.key))
        this.metadataBytes -= r.metadataBytes; }
    prune() { const t = this.now(); for (const r of this.runs.values())
        if (t - r.updatedAt > TTL)
            this.remove(r); }
    reserve(r, bytes) {
        if (this.metadataBytes + bytes > MAX_METADATA_BYTES) {
            r.invalid = true;
            this.count("capacity_exceeded");
            return false;
        }
        r.metadataBytes += bytes;
        this.metadataBytes += bytes;
        return true;
    }
    get(ctx) {
        if (this.options.mode === "off")
            return;
        this.prune();
        const key = contextKey(ctx);
        let r = key ? this.runs.get(key) : undefined;
        if (!r && key && !ctx.agentId) {
            const rs = [...this.runs.values()].filter(x => x.session === ctx.sessionKey && JSON.parse(x.key)[2] === ctx.runId);
            if (rs.length === 1)
                r = rs[0];
        }
        if (r)
            r.updatedAt = this.now();
        return r;
    }
    begin(prompt, ctx, owner = false, senderId, platform) {
        if (this.options.mode === "off")
            return;
        this.prune();
        const key = contextKey(ctx);
        if (!key)
            return;
        // Re-entering a run is a retry/recovery boundary, not a new user authorization.
        if (this.runs.has(key)) {
            this.runs.get(key).invalid = true;
            return;
        }
        if (this.runs.size >= MAX_RUNS) {
            this.count("capacity_exceeded");
            return;
        }
        const r = { key, session: ctx.sessionKey, agent: ctx.agentId ?? "", updatedAt: this.now(), metadataBytes: 0, host: ctx.host ?? "openclaw",
            owner, senderId, platform, cwd: ctx.workspaceDir, promptHash: typeof prompt === "string" && Buffer.byteLength(prompt) <= MAX_INPUT ? digest(prompt) : undefined,
            invalid: false, pending: new Map(), reads: new Map(), plans: new Map(), ordinal: 0, identities: new Map(), api: new Map(), models: new Map(), skipped: new Set() };
        if (!this.reserve(r, 2048 + stringBytes(key, r.session, r.agent, r.cwd, r.senderId, r.platform)))
            return;
        // Transcript hooks without a run ID cannot distinguish concurrent runs in one session.
        for (const old of this.runs.values())
            if (old.session === r.session && old.agent === r.agent) {
                old.invalid = true;
                r.invalid = true;
            }
        this.runs.set(key, r);
    }
    owner(confirmed, ctx) { const r = this.get(ctx); if (r)
        r.owner = confirmed === true; }
    invalidate(ctx) { const r = this.get(ctx); if (r)
        r.invalid = true;
    else if (ctx.sessionKey)
        for (const x of this.runs.values())
            if (x.session === ctx.sessionKey)
                x.invalid = true; }
    end(ctx, session = false) {
        if (session) {
            for (const r of this.runs.values())
                if (r.session === ctx.sessionKey)
                    this.remove(r);
        }
        else {
            const r = this.get(ctx);
            if (r)
                this.remove(r);
        }
    }
    clear() { this.runs.clear(); this.metadataBytes = 0; }
    async ready() { if (this.options.mode !== "off")
        await import("./script.js"); }
    count(reason) { this.counters[reason] = (this.counters[reason] ?? 0) + 1; }
    skip(r, reason) {
        this.count(reason);
        if (r && !r.skipped.has(reason)) {
            r.skipped.add(reason);
            this.options.audit?.({ rule: "dws_reply_guard", result: "skipped", reason, durationMs: 0, runHash: digest(r.key).slice(0, 16) });
        }
        return;
    }
    snapshot() { this.prune(); return { runs: this.runs.size, messages: [...this.runs.values()].reduce((n, r) => n + [...r.reads.values()].reduce((n, x) => n + x.messages.length, 0), 0), metadataBytes: this.metadataBytes, metadataLimit: MAX_METADATA_BYTES, counters: { ...this.counters } }; }
    model(event, ctx, ended = false) {
        const r = this.get(ctx);
        if (!r || r.invalid || r.host !== "openclaw" || !validId(event.callId))
            return;
        if (r.models.size >= MAX_CALLS && !r.models.has(event.callId)) {
            r.invalid = true;
            return;
        }
        if (!r.models.has(event.callId) && !this.reserve(r, 256 + stringBytes(event.callId)))
            return;
        const m = r.models.get(event.callId) ?? { started: false, ended: false, contextTokenBudget: event.contextTokenBudget };
        if (ended) {
            if (!m.started || m.ended || event.outcome !== "completed")
                r.invalid = true;
            m.ended = true;
        }
        else {
            if (m.started)
                r.invalid = true;
            m.started = true;
        }
        r.models.set(event.callId, m);
        r.lastModel = event.callId;
    }
    /** Hermes adapter sends only bounded IDs extracted from the actual outgoing request. */
    apiStart(event, ctx) {
        const r = this.get(ctx);
        if (!r || r.invalid || r.host !== "hermes" || !validId(event.id))
            return;
        if (!event.complete || event.retry !== 0 || r.api.has(event.id) || r.api.size >= MAX_CALLS) {
            r.invalid = true;
            return;
        }
        const ids = event.toolResultIds ?? [];
        if (ids.length > 128) {
            r.invalid = true;
            return;
        }
        if (!this.reserve(r, 256 + stringBytes(event.id) + ids.length * 64))
            return;
        r.api.set(event.id, { reads: new Set(ids.filter(id => {
                const read = r.reads.get(id), fingerprints = event.toolResultFingerprints?.[id];
                // Compression can retain a tool ID while deleting its content. Require
                // the actual outgoing body to retain every source row used by this read.
                return read && Array.isArray(fingerprints) && fingerprints.length <= 32 && read.messages.every(m => fingerprints.includes(m.fingerprint));
            })), ended: false });
    }
    apiEnd(event, ctx) {
        const r = this.get(ctx);
        if (!r || r.invalid || !event.id)
            return;
        const req = r.api.get(event.id);
        if (!req || req.ended || !event.complete) {
            r.invalid = true;
            return;
        }
        req.ended = true;
        this.plan(r, event.id, event.toolCallIds ?? [], req.reads);
    }
    plan(r, id, toolIds, reads) {
        if (toolIds.length > 32 || r.plans.size + toolIds.length > MAX_CALLS || toolIds.some(x => !validId(x) || r.plans.has(x)) || new Set(toolIds).size !== toolIds.length) {
            r.invalid = true;
            return;
        }
        if (!this.reserve(r, 256 + stringBytes(id, ...toolIds) + toolIds.length * 128 + reads.size * 64))
            return;
        const plan = { id, reads: new Set(reads), ordinal: ++r.ordinal };
        for (const toolId of toolIds)
            r.plans.set(toolId, plan);
    }
    transcript(message, ctx) {
        if (this.options.mode === "off")
            return;
        let r = this.get(ctx);
        if (!r && ctx.sessionKey) {
            const rs = [...this.runs.values()].filter(x => x.session === ctx.sessionKey && x.agent === (ctx.agentId ?? ""));
            if (rs.length === 1)
                r = rs[0];
        }
        if (!r || r.invalid || r.host !== "openclaw")
            return;
        if (message.role === "assistant") {
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                r.invalid = true;
                return;
            }
            if (!message.provider || !message.model || !Array.isArray(message.content))
                return;
            const ids = message.content.filter((b) => b?.type === "toolCall").map((b) => b.id);
            // A historical transcript is not proof of current model input. Keep only
            // the immediately preceding batch, which supported pruning retains.
            const reads = this.options.openclawContext?.(r.agent) === true
                ? new Set([...r.reads].filter(([, read]) => read.plan === `transcript:${r.ordinal}`).map(([id]) => id))
                : new Set();
            this.plan(r, `transcript:${r.ordinal + 1}`, ids, reads);
        }
        else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
            this.resultFor(r, message.toolCallId, message, message.isError === true);
        }
    }
    result(value, error, ctx) { const r = this.get(ctx); if (r?.host === "hermes" && ctx.toolCallId)
        this.resultFor(r, ctx.toolCallId, value, !!error); }
    resultFor(r, id, value, error) {
        const p = r.pending.get(id);
        if (!p || p.returned)
            return;
        p.returned = true;
        if (error || r.invalid)
            return;
        const key = identityKey(p.command);
        if (!key)
            return;
        if (p.command.kind === "auth") {
            r.identities.delete(key);
            const identity = verifiedIdentity(p.command, value);
            if (identity && r.identities.size < 8 && this.reserve(r, 512 + stringBytes(key, identity.profile, identity.userId)))
                r.identities.set(key, identity);
            return;
        }
        const identity = r.identities.get(key);
        if (!identity)
            return;
        if (p.command.kind === "people") {
            observePeople(identity, p.command, value, bytes => this.reserve(r, bytes));
            return;
        }
        const messages = externalMessages(p.command, value, identity);
        if (!messages.length)
            return;
        // Pinned live truncation keeps >=16K chars for the supported >=32K token
        // loop. This conservative cap also covers its 2x character estimator.
        if (r.host === "openclaw") {
            const text = value?.content?.[0]?.text;
            // Only model-visible text contributes; never stringify unbounded native
            // details/attachments just to size an already validated text envelope.
            if (typeof text !== "string" || Buffer.byteLength(text) > 8000)
                return;
        }
        if ([...r.reads.values()].reduce((n, x) => n + x.messages.length, 0) + messages.length > 32 || this.snapshot().messages + messages.length > MAX_MESSAGES) {
            r.invalid = true;
            this.skip(r, "capacity_exceeded");
            return;
        }
        if (!this.reserve(r, 256 + stringBytes(id, p.command.executable, identity.profile) + messages.reduce((n, m) => n + 256 + stringBytes(m.messageId, m.conversationId, m.senderOpenId, m.senderUserId, m.fingerprint), 0)))
            return;
        r.reads.set(id, { callId: id, plan: p.plan, executable: p.command.executable, profile: identity.profile, messages });
    }
    trustedOwner(r, identity) {
        if (r.owner)
            return true;
        // Only the authenticated native DingTalk route can bind a gateway sender to
        // the separately verified DWS self identity. API/body-supplied user fields cannot.
        return r.host === "hermes" && r.platform === "dingtalk" && !!r.senderId && [identity.userId, identity.openId].includes(r.senderId);
    }
    before(event, ctx) {
        if (this.options.mode === "off" || !["exec", "bash"].includes(event.toolName))
            return;
        const command = event.params?.command;
        if (typeof command !== "string")
            return;
        const start = performance.now(), parsed = parseCommand(command), r = this.get(ctx);
        if (parsed.kind === "other")
            return;
        if (event.params?.env && Object.keys(event.params.env).length)
            return this.skip(r, "unknown_identity");
        if (parsed.kind === "unknown")
            return this.skip(r, "unsupported_syntax");
        if (parsed.kind === "script")
            return this.script(parsed.script, event.params ?? {}, r, ctx, start);
        if (!r || r.invalid)
            return this.skip(r, "missing_context");
        const id = ctx.toolCallId ?? event.toolCallId;
        const plan = id ? r.plans.get(id) : undefined;
        if (!id || !plan)
            return this.skip(r, "ambiguous_model_order");
        if (ctx.apiRequestId && ctx.apiRequestId !== plan.id)
            return this.skip(r, "ambiguous_model_order");
        if (r.pending.has(id))
            return this.skip(r, "ambiguous_model_order");
        if (r.pending.size >= MAX_CALLS) {
            r.invalid = true;
            return this.skip(r, "capacity_exceeded");
        }
        if (parsed.kind !== "send") {
            if (this.reserve(r, 384 + stringBytes(id, parsed.executable, parsed.profile, parsed.target?.id, parsed.messageId)))
                r.pending.set(id, { command: { ...parsed, body: undefined }, plan: plan.id });
            return;
        }
        const key = identityKey(parsed), identity = key ? r.identities.get(key) : undefined;
        if (!identity)
            return this.skip(r, "unknown_identity");
        const owner = ownerRequest(this.options.prompt(r.session), r.promptHash, this.trustedOwner(r, identity), parsed);
        if (owner === "UNKNOWN")
            return this.skip(r, "owner_request_unknown");
        if (owner === "EXACT_OWNER_REQUEST")
            return;
        if (r.host === "openclaw" && (r.ordinal !== plan.ordinal || r.models.size !== plan.ordinal || [...r.models.values()].some(m => !m.started || !m.ended)))
            return this.skip(r, "ambiguous_model_order");
        if (r.host === "openclaw" && (!this.options.openclawContext?.(r.agent) ||
            !r.lastModel || (r.models.get(r.lastModel)?.contextTokenBudget ?? 0) < 32000))
            return this.skip(r, "model_input_unknown");
        for (const call of plan.reads) {
            const read = r.reads.get(call);
            if (read && read.plan !== plan.id && read.executable === parsed.executable && read.profile === parsed.profile && read.messages.some(m => sameDestination(parsed, m, identity))) {
                return this.hit(r, "dws_agent_reply", "external_result_later_model_same_destination", start, parsed.target?.id);
            }
        }
    }
    hit(r, rule, reason, start, target) {
        const durationMs = performance.now() - start;
        if (durationMs > SOFT_MS)
            return this.skip(r, "budget_exceeded");
        const result = this.options.mode === "enforce" ? "blocked" : "observed";
        this.options.audit?.({ rule, result, reason, durationMs, runHash: r ? digest(r.key).slice(0, 16) : undefined, targetHash: target ? digest(target).slice(0, 16) : undefined });
        return result === "blocked" ? { block: true, blockReason: DWS_REPLY_BLOCK } : undefined;
    }
    async script(candidate, params, r, ctx, start) {
        if (!r || r.invalid)
            return this.skip(r, "missing_context");
        try {
            let code = candidate.code;
            if (candidate.file) {
                const dir = typeof params.workdir === "string" ? params.workdir : (ctx.workspaceDir ?? r.cwd);
                if (!path.isAbsolute(candidate.file) && (!dir || !path.isAbsolute(dir)))
                    return this.skip(r, "missing_context");
                const file = path.resolve(dir ?? "/", candidate.file);
                // No queue: at most four OS reads can remain outstanding after a timeout.
                // Late results never resume inspection and their handle is always closed.
                if (this.fileReads >= 4)
                    return this.skip(r, "capacity_exceeded");
                this.fileReads++;
                let expired = false, timer;
                const read = (async () => {
                    const handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
                    try {
                        if (expired)
                            return;
                        const before = await handle.stat();
                        if (expired)
                            return;
                        if (!before.isFile() || before.size > MAX_INPUT)
                            throw new Error("input_too_large");
                        const buffer = Buffer.alloc(before.size + 1);
                        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                        if (expired)
                            return;
                        const after = await handle.stat();
                        if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
                            throw new Error("file_changed");
                        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
                    }
                    finally {
                        await handle.close();
                    }
                })().finally(() => { this.fileReads--; });
                try {
                    code = await Promise.race([read, new Promise(resolve => {
                            timer = setTimeout(() => { expired = true; resolve(undefined); }, Math.max(0, SOFT_MS - (performance.now() - start)));
                        })]);
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
                if (expired)
                    return this.skip(r, "budget_exceeded");
            }
            if (code === undefined || Buffer.byteLength(code) > MAX_INPUT)
                return this.skip(r, "input_too_large");
            if (performance.now() - start > SOFT_MS)
                return this.skip(r, "budget_exceeded");
            const { analyzeScript } = await import("./script.js");
            const analysis = analyzeScript(code, candidate.language, candidate.stdin, command => {
                const key = identityKey(command);
                return key ? r.identities.get(key) : undefined;
            }, start + SOFT_MS);
            if (analysis === "match")
                return this.hit(r, "dws_script_reply", "external_message_model_body_to_dws", start);
            if (analysis !== "clear")
                return this.skip(r, analysis);
        }
        catch (error) {
            return this.skip(r, error instanceof Error && ["input_too_large", "file_changed"].includes(error.message) ? error.message : "unreadable_file");
        }
    }
}
