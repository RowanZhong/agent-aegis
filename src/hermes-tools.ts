import path from "node:path";
import type { PluginHookBeforeToolCallEvent } from "../runtime-api.js";
import { resolveProtectedPathCandidates } from "./rules.js";

export type HermesToolContext = {
  home: string;
  skillDir?: string;
  workspaceDir?: string;
};

/** Translate schemas for inspection only; never rewrite the executed arguments. */
function translateHermesTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: HermesToolContext,
): PluginHookBeforeToolCallEvent[] {
  const params = { ...args };
  switch (toolName) {
    case "terminal":
      return [{ toolName: "exec", params }];
    case "read_file":
      return [{ toolName: "read", params }];
    case "write_file":
      return [{ toolName: "write", params }];
    case "patch":
      return params.mode === "patch"
        ? [{ toolName: "apply_patch", params: { ...params, input: params.patch } }]
        : [{ toolName: "edit", params }];
    case "memory": {
      const operations = Array.isArray(params.operations)
        ? params.operations : [params];
      return operations.filter((op) => op && ["add", "replace"].includes(op.action))
        .map((op) => ({
          toolName: "memory_store",
          params: { text: op.content ?? op.new_text, category: params.target },
        }));
    }
    case "skill_manage": {
      const skillDir = ctx.skillDir ?? path.join(ctx.home, "skills",
        typeof params.category === "string" ? params.category : "",
        typeof params.name === "string" ? params.name : "");
      const target = params.action === "delete" ? skillDir : path.resolve(skillDir,
        typeof params.file_path === "string" && params.file_path ? params.file_path : "SKILL.md");
      const deleting = ["delete", "remove_file"].includes(String(params.action));
      return [{
        toolName: deleting ? "delete" : params.action === "patch" ? "edit" : "write",
        params: { ...params, path: target, content: params.file_content ?? params.content },
      }];
    }
    case "web_extract":
      return (Array.isArray(params.urls) ? params.urls : [params.url]).map((url) => ({
        toolName: "web_fetch", params: { ...params, url },
      }));
    case "browser_navigate":
      return [{ toolName: "web_fetch", params }];
    default:
      return [{ toolName, params }];
  }
}

export function normalizeHermesTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: HermesToolContext,
): PluginHookBeforeToolCallEvent[] {
  const events = translateHermesTool(toolName, args, ctx);
  const memoryRoot = path.join(ctx.home, "memories");
  for (const event of [...events]) {
    if (!["write", "edit", "apply_patch"].includes(event.toolName)) continue;
    const params = event.params ?? {};
    const paths = resolveProtectedPathCandidates(event.toolName, params, ctx.workspaceDir);
    if (paths.some((p) => p === memoryRoot || p.startsWith(`${memoryRoot}${path.sep}`))) {
      events.push({ toolName: "memory_store", params: {
        text: params.content ?? params.new_string ?? params.input,
      } });
    }
  }
  return events;
}
