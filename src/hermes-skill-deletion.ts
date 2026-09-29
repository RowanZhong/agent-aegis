import fs from "node:fs";
import path from "node:path";
import type { ToolCallDefenseContext, ToolCallDefenseStrategy } from "./security-strategies.js";

/** Private adapter evidence. Never read this from model-supplied tool params. */
export type HermesSkillDeletion = {
  action: "delete" | "remove_file";
  name: string;
  skillDir: string;
  roots: string[];
  target: string;
  archiveDir?: string | null;
};

function within(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

// Resolve existing parents too: archive destinations/protected paths can be absent.
function canonical(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("Expected a host-resolved absolute path");
  try { return fs.realpathSync(value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (fs.lstatSync(value, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(canonical(parent), path.basename(value));
  }
}

function permitsSkillDeletion(ctx: ToolCallDefenseContext, home: string): boolean {
  const scope = ctx.hermesSkillDeletion;
  if (ctx.host !== "hermes" || ctx.toolName !== "delete" || !scope
    || !["delete", "remove_file"].includes(scope.action)
    || ctx.params.action !== scope.action || ctx.params.name !== scope.name
    || typeof scope.name !== "string" || !scope.name
    || typeof ctx.params.path !== "string" || !Array.isArray(scope.roots) || !scope.roots.length) return false;
  try {
    const roots = scope.roots.map(canonical);
    const skill = canonical(scope.skillDir), target = canonical(scope.target);
    const workspace = canonical(ctx.baseDir), profile = canonical(home);
    // Require identical filesystem views in Python and Node, not guessed mappings.
    if (skill !== scope.skillDir || target !== scope.target
      || roots.some((root, i) => root !== scope.roots[i])
      || canonical(ctx.params.path) !== target
      || roots.includes(skill) || !roots.some(root => within(skill, root))
      || !fs.statSync(path.join(skill, "SKILL.md")).isFile()) return false;
    if (scope.action === "delete") {
      if (target !== skill || !fs.statSync(target).isDirectory()) return false;
    } else if (target === skill || !within(target, skill) || !fs.statSync(target).isFile()) return false;

    const affected = [target];
    if (scope.archiveDir != null) {
      if (scope.action !== "delete") return false;
      const archive = canonical(scope.archiveDir);
      if (archive !== scope.archiveDir || roots.includes(archive)
        || !roots.some(root => within(archive, root))) return false;
      // The host may append a timestamp on name collision. Protect the whole
      // archive namespace instead of predicting that mutable destination.
      affected.push(archive);
    }
    // Never excuse deleting a workspace/profile/library root or an ancestor.
    if (affected.some(p => [workspace, profile, ...roots].some(root => within(root, p)))) return false;
    const protectedPaths = [...ctx.protectedRoots, ...(ctx.controlConfigPaths ?? [])].map(canonical);
    if (affected.some(p => protectedPaths.some(root => within(p, root) || within(root, p)))) return false;
    return true;
  } catch { return false; }
}

/** Wrap only the Hermes registration. The shared/OpenClaw strategy stays intact. */
export function withHermesSkillDeletion(
  strategy: ToolCallDefenseStrategy, home: string,
): ToolCallDefenseStrategy {
  if (strategy.id !== "workspace_delete_guard") return strategy;
  return {
    ...strategy,
    evaluate(ctx) {
      const original = strategy.evaluate(ctx);
      if (!["blocked", "observed"].includes(original.result) || !permitsSkillDeletion(ctx, home)) return original;
      return { result: "clear", mode: ctx.modes.selfProtection,
        extra: { scope: "hermes-native-skill-cleanup", action: ctx.hermesSkillDeletion!.action,
          target: ctx.hermesSkillDeletion!.target } };
    },
  };
}
