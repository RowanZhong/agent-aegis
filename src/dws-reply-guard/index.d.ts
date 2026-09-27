import type { DefenseMode } from "../config.js";
export declare const DWS_REPLY_BLOCK = "\u68C0\u6D4B\u5230\u5916\u90E8\u6D88\u606F\u7ECF AI \u5904\u7406\u540E\u76F4\u63A5\u81EA\u52A8\u56DE\u590D\uFF0C\u8BF7\u901A\u8FC7\u4EE3\u56DE\u590D\u52A9\u624B\u5904\u7406\u3002";
export type ReplyContext = {
    sessionKey?: string;
    runId?: string;
    agentId?: string;
    toolCallId?: string;
    apiRequestId?: string;
    workspaceDir?: string;
    host?: "hermes" | "openclaw";
};
type Result = {
    block: true;
    blockReason: string;
} | undefined;
type Audit = {
    rule: string;
    result: "blocked" | "observed" | "skipped";
    reason: string;
    durationMs: number;
    runHash?: string;
    targetHash?: string;
};
/** Pinned OpenClaw PI loop: only the immediately preceding tool batch is used.
 * Cache pruning must retain its last assistant; custom assembly/limits are
 * unknown. This reads host configuration and never changes it.
 */
export declare function openclawTranscriptCompatible(config: unknown, agentId: string): boolean;
/** Independent, bounded evidence. No messages, scripts, secrets or owner text retained. */
export declare class DwsReplyGuard {
    private options;
    private runs;
    private counters;
    private fileReads;
    private metadataBytes;
    constructor(options: {
        mode: DefenseMode;
        now?: () => number;
        prompt: (session: string) => string | undefined;
        openclawContext?: (agentId: string) => boolean;
        audit?: (event: Audit) => void;
    });
    private now;
    private remove;
    private prune;
    private reserve;
    private get;
    begin(prompt: unknown, ctx: ReplyContext, owner?: boolean, senderId?: string, platform?: string): void;
    owner(confirmed: unknown, ctx: ReplyContext): void;
    invalidate(ctx: ReplyContext): void;
    end(ctx: ReplyContext, session?: boolean): void;
    clear(): void;
    ready(): Promise<void>;
    private count;
    private skip;
    snapshot(): {
        runs: number;
        messages: number;
        metadataBytes: number;
        metadataLimit: number;
        counters: {
            [x: string]: number;
        };
    };
    model(event: {
        callId?: string;
        outcome?: string;
        contextTokenBudget?: number;
    }, ctx: ReplyContext, ended?: boolean): void;
    /** Hermes adapter sends only bounded IDs extracted from the actual outgoing request. */
    apiStart(event: {
        id?: string;
        toolResultIds?: string[];
        toolResultFingerprints?: Record<string, string[]>;
        retry?: number;
        complete?: boolean;
    }, ctx: ReplyContext): void;
    apiEnd(event: {
        id?: string;
        toolCallIds?: string[];
        complete?: boolean;
    }, ctx: ReplyContext): void;
    private plan;
    transcript(message: Record<string, any>, ctx: ReplyContext): void;
    result(value: unknown, error: unknown, ctx: ReplyContext): void;
    private resultFor;
    private trustedOwner;
    before(event: {
        toolName: string;
        params?: Record<string, unknown>;
        toolCallId?: string;
    }, ctx: ReplyContext): Result | Promise<Result>;
    private hit;
    private script;
}
export {};
