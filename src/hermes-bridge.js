/** Private stdin/stdout JSONL transport for the native Hermes Python plugin. */
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createClawAegisRuntime } from "./handlers.js";
import { resolveClawAegisPluginConfig } from "./config.js";
import { buildDynamicPromptContext, detectHighRiskCommand } from "./rules.js";
import { TOOL_CALL_DEFENSE_STRATEGIES } from "./security-strategies.js";
import { normalizeHermesTool } from "./hermes-tools.js";
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Reuse the host-control command policy with Hermes' executable spelling.
// This copy is inspected only; executed tool arguments are never changed.
function hostPolicyText(text) {
    return text.replace(/\bhermes\b/gi, "openclaw");
}
const hermesCommandGuard = {
    id: "hermes_command_guard", modeSource: "commandBlock", order: 0, clearResult: "clear",
    appliesTo: (ctx) => ctx.modes.commandBlock !== "off" && ["exec", "bash"].includes(ctx.toolName),
    evaluate: (ctx) => {
        const translated = hostPolicyText(ctx.commandText ?? "");
        const reason = translated !== ctx.commandText ? detectHighRiskCommand(translated) : undefined;
        const mode = ctx.modes.commandBlock;
        return reason
            ? { result: mode === "enforce" ? "blocked" : "observed", mode, reason: reason.replaceAll("openclaw", "hermes") }
            : { result: "clear", mode };
    },
};
export function createHermesBridge() {
    let runtime;
    let home = "";
    let promptGuardEnabled = false;
    const deniedSessions = new Map();
    const log = (message) => process.stderr.write(`${message}\n`);
    return {
        async dispatch(method, payload) {
            if (method === "initialize") {
                if (runtime)
                    throw new Error("AgentAegis is already initialized");
                home = path.resolve(payload.home);
                const stateDir = path.resolve(payload.state_dir);
                await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
                const pluginConfig = { ...payload.config };
                pluginConfig.protectedPaths = [...(Array.isArray(pluginConfig.protectedPaths) ? pluginConfig.protectedPaths : []),
                    path.join(home, "config.yaml"), path.join(home, ".env"),
                    path.join(home, "auth.json"), ...(payload.protectedSkillPaths ?? [])];
                const api = {
                    rootDir, config: {}, pluginConfig,
                    runtime: { state: { resolveStateDir: () => home } },
                    logger: { info: log, warn: log, error: log },
                    getPluginConfig: () => pluginConfig,
                    resolvePath: (value) => path.resolve(value === "~" ? os.homedir()
                        : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value),
                    on: () => { },
                };
                runtime = createClawAegisRuntime(api, {
                    stateDir,
                    skillScanRoots: payload.skill_roots ?? [path.join(home, "skills")],
                    toolCallDefenseStrategies: [hermesCommandGuard, ...TOOL_CALL_DEFENSE_STRATEGIES],
                });
                await runtime.hooks.gateway_start();
                const config = resolveClawAegisPluginConfig(api);
                promptGuardEnabled = config.promptGuardEnabled;
                // Keep the shared policy while naming the actual host and config file.
                const staticContext = runtime.staticSystemContext
                    ?.replaceAll(".openclaw/openclaw.json", path.join(home, "config.yaml"))
                    .replaceAll(".openclaw", home).replaceAll("openclaw", "hermes");
                return { staticContext, enabled: config.allDefensesEnabled };
            }
            if (!runtime)
                throw new Error("AgentAegis has not been initialized");
            const sessionKey = payload.session_id || payload.task_id || undefined;
            // The same task/turn id can occur in independent gateway sessions.
            const runId = sessionKey ? JSON.stringify([sessionKey,
                payload.turn_id || payload.task_id || sessionKey]) : undefined;
            const ctx = { sessionKey, runId, workspaceDir: payload.workspace_dir };
            const toolEvents = () => normalizeHermesTool(payload.tool_name, payload.args ?? {}, { home, skillDir: payload.skill_dir, workspaceDir: payload.workspace_dir });
            switch (method) {
                case "pre_llm_call": {
                    const content = typeof payload.user_message === "string" ? payload.user_message : "";
                    if (sessionKey)
                        deniedSessions.delete(sessionKey);
                    const policyText = hostPolicyText(content);
                    const dispatch = await runtime.hooks.before_agent_reply({ cleanedBody: content }, ctx)
                        ?? (policyText !== content
                            ? await runtime.hooks.before_agent_reply({ cleanedBody: policyText }, ctx) : undefined);
                    if (dispatch?.handled && sessionKey) {
                        const refusal = dispatch.reply?.text ?? "[AgentAegis] Request blocked by dispatch guard.";
                        deniedSessions.set(sessionKey, refusal);
                        return { context: refusal };
                    }
                    runtime.hooks.message_received({ content }, ctx);
                    const result = await runtime.hooks.before_prompt_build({ prompt: content }, ctx);
                    return result?.appendSystemContext ? { context: result.appendSystemContext } : null;
                }
                case "pre_tool_call":
                    if (sessionKey && deniedSessions.has(sessionKey)) {
                        return { action: "block", message: deniedSessions.get(sessionKey) };
                    }
                    for (const event of toolEvents()) {
                        const result = runtime.hooks.before_tool_call(event, ctx);
                        if (result?.block)
                            return { action: "block", message: result.blockReason };
                    }
                    return null;
                case "post_tool_call":
                    for (const event of toolEvents()) {
                        runtime.hooks.after_tool_call({ ...event, result: payload.result,
                            error: payload.status && payload.status !== "ok" ? payload.status : payload.error_message,
                            durationMs: payload.duration_ms }, ctx);
                    }
                    return null;
                case "transform_tool_result": {
                    const original = typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result);
                    const toolName = toolEvents()[0]?.toolName ?? payload.tool_name;
                    const message = { role: "toolResult", toolName,
                        content: [{ type: "text", text: original }] };
                    const result = runtime.hooks.before_message_write({ message }, ctx);
                    const rewritten = (result?.message ?? message);
                    let text = rewritten.content.map((block) => block.text).join("\n");
                    // pre_llm_call runs only once per user turn. Surface tool findings in
                    // this new tool result so the very next model iteration sees them.
                    const notice = promptGuardEnabled && sessionKey
                        ? buildDynamicPromptContext(runtime.state.consumePromptState(sessionKey)) : undefined;
                    if (notice)
                        text += `\n\n[AgentAegis security context]\n${notice}`;
                    return text === original ? null : text;
                }
                case "transform_llm_output": {
                    if (sessionKey && deniedSessions.has(sessionKey))
                        return deniedSessions.get(sessionKey);
                    const content = payload.response_text ?? "";
                    const result = runtime.hooks.message_sending({ to: "hermes", content }, ctx);
                    runtime.hooks.llm_output({ assistantTexts: [result?.content ?? content],
                        sessionId: sessionKey ?? "", runId: runId ?? "", provider: "hermes",
                        model: payload.model ?? "" }, ctx);
                    return result?.content ?? null;
                }
                case "on_session_end":
                    if (sessionKey)
                        deniedSessions.delete(sessionKey);
                    runtime.hooks.agent_end({}, ctx);
                    return null;
                case "on_session_finalize":
                case "on_session_reset":
                    if (sessionKey)
                        deniedSessions.delete(sessionKey);
                    runtime.hooks.session_end({}, ctx);
                    return null;
                case "shutdown":
                    await runtime.scanService.stop();
                    return null;
                default:
                    throw new Error(`Unsupported AgentAegis bridge method: ${method}`);
            }
        },
    };
}
async function main() {
    const bridge = createHermesBridge();
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
        let request = {};
        try {
            request = JSON.parse(line);
            const result = await bridge.dispatch(request.method, request.payload ?? {});
            process.stdout.write(`${JSON.stringify({ id: request.id, result: result ?? null })}\n`);
        }
        catch (error) {
            process.stdout.write(`${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error) })}\n`);
        }
    }
    await bridge.dispatch("shutdown", {}).catch(() => { });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => { process.exitCode = 1; });
}
