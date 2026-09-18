import type { PluginHookBeforeToolCallEvent } from "../runtime-api.js";
export type HermesToolContext = {
    home: string;
    skillDir?: string;
    workspaceDir?: string;
};
export declare function normalizeHermesTool(toolName: string, args: Record<string, unknown>, ctx: HermesToolContext): PluginHookBeforeToolCallEvent[];
