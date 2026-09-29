import type { PluginHookAfterToolCallEvent, PluginHookAgentEndEvent, PluginHookBeforePromptBuildEvent, OpenClawPluginApi, PluginHookBeforeMessageWriteEvent, PluginHookBeforePromptBuildResult, PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult, PluginHookMessageSendingEvent, PluginHookMessageSendingResult, PluginHookSessionEndEvent } from "../runtime-api.js";
import { type ToolCallDefenseStrategy } from "./security-strategies.js";
import { SkillScanService } from "./scan-service.js";
import { ClawAegisState } from "./state.js";
import { DwsReplyGuard, type ReplyContext } from "./dws-reply-guard/index.js";
export declare function createClawAegisRuntime(api: OpenClawPluginApi, options?: {
    /** Bound by the adapter, never inferred from untrusted tool arguments. */
    host?: "openclaw" | "hermes";
    now?: () => number;
    /** Host adapters can keep runtime data separate from installed plugin code. */
    stateDir?: string;
    skillScanRoots?: string[];
    scanRunner?: (request: import("./types.js").SkillScanRequest) => Promise<import("./types.js").SkillScanResult>;
    toolCallDefenseStrategies?: readonly ToolCallDefenseStrategy[];
}): {
    state: ClawAegisState;
    dwsReplyGuard: DwsReplyGuard;
    scanService: SkillScanService;
    staticSystemContext: string | undefined;
    hooks: {
        before_model_resolve: (event: {
            prompt?: string;
        }, ctx: ReplyContext) => void;
        before_agent_run: (event: {
            senderIsOwner?: boolean;
        }, ctx: ReplyContext) => void;
        model_call_started: (event: {
            callId?: string;
        }, ctx: ReplyContext) => void;
        model_call_ended: (event: {
            callId?: string;
            outcome?: string;
        }, ctx: ReplyContext) => void;
        before_compaction: (_event: unknown, ctx: ReplyContext) => void;
        before_reset: (_event: unknown, ctx: ReplyContext) => void;
        gateway_stop: () => void;
        gateway_start: () => Promise<void>;
        message_received: (event: {
            content: string;
        }, ctx: {
            sessionKey?: string;
        }) => void;
        message_sending: (event: PluginHookMessageSendingEvent, ctx: {
            sessionKey?: string;
        }) => PluginHookMessageSendingResult | undefined;
        before_prompt_build: (event: PluginHookBeforePromptBuildEvent, ctx: ReplyContext) => Promise<PluginHookBeforePromptBuildResult | undefined>;
        before_dispatch: (event: {
            content: string;
            body?: string;
            channel?: string;
            sessionKey?: string;
            senderId?: string;
            isGroup?: boolean;
            timestamp?: number;
        }, ctx: {
            channelId?: string;
            accountId?: string;
            conversationId?: string;
            sessionKey?: string;
            senderId?: string;
        }) => Promise<{
            handled: boolean;
            text?: string;
        } | undefined>;
        before_agent_reply: (event: {
            cleanedBody: string;
        }, ctx: {
            runId?: string;
            agentId?: string;
            sessionKey?: string;
            sessionId?: string;
            workspaceDir?: string;
            trigger?: string;
        }) => Promise<{
            handled: boolean;
            reply?: {
                text: string;
            };
            reason?: string;
        } | undefined>;
        before_tool_call: (event: PluginHookBeforeToolCallEvent, ctx: ReplyContext & {
            hermesSkillDeletion?: import("./hermes-skill-deletion.js").HermesSkillDeletion;
        }) => PluginHookBeforeToolCallResult | undefined | Promise<PluginHookBeforeToolCallResult | undefined>;
        after_tool_call: (event: PluginHookAfterToolCallEvent, ctx: ReplyContext) => void;
        llm_output: (event: {
            assistantTexts: string[];
            runId: string;
            sessionId: string;
            provider: string;
            model: string;
        }, _ctx: {
            sessionKey?: string;
            runId?: string;
        }) => void;
        agent_end: (_event: PluginHookAgentEndEvent, ctx: {
            sessionKey?: string;
            runId?: string;
        }) => void;
        session_end: (_event: PluginHookSessionEndEvent, ctx: ReplyContext) => void;
        before_message_write: (event: PluginHookBeforeMessageWriteEvent, ctx: ReplyContext) => {
            message: never;
        } | undefined;
    };
};
