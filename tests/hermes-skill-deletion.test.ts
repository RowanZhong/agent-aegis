import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClawAegisRuntime } from "../src/handlers.js";
import { TOOL_CALL_DEFENSE_STRATEGIES } from "../src/security-strategies.js";
import { withHermesSkillDeletion, type HermesSkillDeletion } from "../src/hermes-skill-deletion.js";
import type { OpenClawPluginApi } from "../runtime-api.js";

const dirs: string[] = [];
afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(host: "hermes" | "openclaw" = "hermes", settings: Record<string, unknown> = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aegis-skill-"))); dirs.push(base);
  const home = path.join(base, "profile"), work = path.join(base, "project");
  const root = path.join(home, "skills"), skill = path.join(root, "team", "reporting");
  const file = path.join(skill, "references", "old.md");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(work);
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# Reporting"); fs.writeFileSync(file, "old");
  const api = { rootDir: path.join(base, "plugin"), config: {},
    pluginConfig: { skillScanEnabled: false, ...settings },
    runtime: { state: { resolveStateDir: () => home } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, on: vi.fn(), resolvePath: (p: string) => p } as OpenClawPluginApi;
  const runtime = createClawAegisRuntime(api, { host, stateDir: path.join(base, "data"),
    toolCallDefenseStrategies: host === "hermes"
      ? TOOL_CALL_DEFENSE_STRATEGIES.map(s => withHermesSkillDeletion(s, home)) : undefined });
  const ready = runtime.hooks.gateway_start();
  const scope: HermesSkillDeletion = { action: "delete", name: "reporting", skillDir: skill, roots: [root], target: skill };
  const call = async (evidence: HermesSkillDeletion | null = scope, params: Record<string, unknown> = {}, workspaceDir = work) => {
    await ready;
    return runtime.hooks.before_tool_call({ toolName: "delete", params: { action: "delete", name: "reporting", path: skill, ...params } },
      { workspaceDir, hermesSkillDeletion: evidence ?? undefined });
  };
  return { base, home, work, root, skill, file, api, runtime, ready, scope, call };
}

describe("Hermes native skill cleanup scope", () => {
  it("allows only the verified skill or individual supporting file", async () => {
    const f = fixture(); expect(await f.call()).toBeUndefined();
    expect(await f.call({ ...f.scope, action: "remove_file", target: f.file }, { action: "remove_file", path: f.file })).toBeUndefined();
    expect(f.api.logger.info).toHaveBeenCalledWith(expect.stringContaining("hermes-native-skill-cleanup"));
  });
  it("does not trust scope fields in tool params", async () => {
    const f = fixture();
    expect((await f.call(null, { hermesSkillDeletion: f.scope, skill_deletion: f.scope, trusted: true }))?.block).toBe(true);
  });
  it("does not grant the scope to shell or generic tools", async () => {
    const f = fixture(); await f.ready;
    for (const toolName of ["exec", "bash"]) expect((await f.runtime.hooks.before_tool_call(
      { toolName, params: { command: `rm -rf '${f.skill}'` } },
      { workspaceDir: f.work, hermesSkillDeletion: f.scope }))?.block).toBe(true);
  });
  it.each(["name", "action", "target", "root", "filesystem"])("rejects mismatched %s evidence", async kind => {
    const f = fixture(), scope = { ...f.scope };
    if (kind === "name") scope.name = "another";
    if (kind === "action") scope.action = "remove_file";
    if (kind === "target") scope.target = f.file;
    if (kind === "root") scope.roots = [f.skill];
    if (kind === "filesystem") scope.skillDir = "/different-container/skills/reporting";
    expect((await f.call(scope))?.block).toBe(true);
  });
  it.each(["workspace", "ancestor", "library", "profile"])("keeps the %s boundary", async kind => {
    const f = fixture();
    let work = f.work, scope = f.scope;
    if (kind === "workspace") work = f.skill;
    if (kind === "ancestor") { work = path.join(f.skill, "subproject"); fs.mkdirSync(work); }
    if (kind === "library") scope = { ...scope, roots: [f.skill] };
    if (kind === "profile") {
      fs.writeFileSync(path.join(f.home, "SKILL.md"), "# bad root");
      scope = { ...scope, skillDir: f.home, target: f.home, roots: [f.base] };
    }
    expect((await f.call(scope, { path: scope.target }, work))?.block).toBe(true);
  });
  it("preserves protected descendants as well as protected ancestors", async () => {
    const f = fixture(); await f.ready;
    for (const protectedPath of [f.file, f.skill, f.root]) {
      f.api.pluginConfig = { skillScanEnabled: false, protectedPaths: [protectedPath] };
      const runtime = createClawAegisRuntime(f.api, { host: "hermes", stateDir: path.join(f.base, "data"),
        toolCallDefenseStrategies: TOOL_CALL_DEFENSE_STRATEGIES.map(s => withHermesSkillDeletion(s, f.home)) });
      await runtime.hooks.gateway_start();
      expect((await runtime.hooks.before_tool_call({ toolName: "delete", params: { action: "delete", name: "reporting", path: f.skill } },
        { workspaceDir: f.work, hermesSkillDeletion: f.scope }))?.block).toBe(true);
    }
  });
  it("rejects a supporting-file escape through a symlink", async () => {
    const f = fixture(), outside = path.join(f.base, "outside.md"), alias = path.join(f.skill, "references", "alias.md");
    fs.writeFileSync(outside, "keep"); fs.symlinkSync(outside, alias);
    expect((await f.call({ ...f.scope, action: "remove_file", target: outside }, { action: "remove_file", path: alias }))?.block).toBe(true);
  });
  it("allows a verified archive directory but not a redirected one", async () => {
    const f = fixture(), archiveDir = path.join(f.root, ".archive");
    expect(await f.call({ ...f.scope, archiveDir })).toBeUndefined();
    fs.symlinkSync(f.work, archiveDir);
    expect((await f.call({ ...f.scope, archiveDir }))?.block).toBe(true);
  });
  it("keeps configured protected skills blocked", async () => {
    const f = fixture("hermes", { protectedSkills: ["reporting"] }); expect((await f.call())?.block).toBe(true);
  });
  it.each(["observe", "off"])("preserves %s behavior", async mode => {
    const f = fixture("hermes", { selfProtectionMode: mode });
    expect(await f.call()).toBeUndefined(); expect(await f.call(null)).toBeUndefined();
  });
  it("keeps OpenClaw blocking with forged Hermes context", async () => {
    const f = fixture("openclaw"); expect((await f.call())?.block).toBe(true);
    expect(await f.runtime.hooks.before_tool_call({ toolName: "delete", params: { path: path.join(f.work, "old.md") } },
      { workspaceDir: f.work, hermesSkillDeletion: f.scope })).toBeUndefined();
  });
});
