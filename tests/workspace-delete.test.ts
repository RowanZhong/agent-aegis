import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectDispatchGuardViolation, resolveOutsideWorkspaceDeletionViolation } from "../src/rules.js";
import { createClawAegisRuntime } from "../src/handlers.js";
import type { OpenClawPluginApi } from "../runtime-api.js";

const workspace = "/tmp/aegis-delete/workspace";
const inspect = (command: string, extra: Record<string, unknown> = {}) =>
  resolveOutsideWorkspaceDeletionViolation("exec", { command, ...extra }, workspace, workspace);

describe("workspace root deletion boundary", () => {
  it.each([
    `rm -rf ${workspace}`, `rm -rf ${workspace}/`, `rm -rf ${workspace}/child/..`,
    `rm -rf .`, `rm -rf "$PWD"`, `rm -rf "${'${PWD}'}"`, `rm -rf "$(pwd)"`,
    `/bin/rm -rf '${workspace}'`, `command rm -rf ${workspace}`, `env LC_ALL=C rm -rf ${workspace}`,
    `TARGET="${workspace}"; cd /tmp && rm -rf "$TARGET"`,
    `cd /tmp; rm -rf ${workspace}`, `env -u NONEXISTENT rm -rf ${workspace}`,
    `rm -rf -- ${workspace} --help`, `find ${workspace} -name '?*' -delete`,
    `pwd;rm -rf ${workspace}`, `pwd\nrm -rf ${workspace}`, `true && rm -rf ${workspace}`,
    `sh -c 'rm -rf ${workspace}'`, `bash -lc 'rm -rf "$PWD"'`,
    `rm -rf *`, `rm -rf ./*`, `rm -rf ${workspace}/*`, `rm -rf ${workspace}/{*,.*}`,
    `rm -rf ${workspace}/.[!.]* ${workspace}/..?*`, `rm -rf ${workspace}/**/*`,
    `find ${workspace} -depth -delete`, `find . -mindepth 1 -delete`,
    `find . -mindepth 1 -exec rm -rf {} +`,
    `find . -name '*' -delete`, `find . -type f -delete`,
    `python3 -c 'import shutil; shutil.rmtree("${workspace}")'`,
    `python3 -c 'import shutil, os; shutil.rmtree(os.getcwd())'`,
    `python3 -c 'from shutil import rmtree as wipe; wipe("${workspace}")'`,
    `node -e 'require("fs").rmSync("${workspace}", {recursive:true})'`,
    `node -e 'const fs=require("node:fs"); fs.rmSync(process.cwd(), {recursive:true})'`,
  ])("blocks root / bulk deletion: %s", command => expect(inspect(command).blocked).toBe(true));

  it.each([
    "pwd", "ls -la .", "rm -f notes.txt", "rm -rf build", "rm -rf build/*", "rm -f *.tmp",
    `rm -f '${workspace}/notes.txt'`, `cd build && rm -rf .`,
    `find . -type f -name '*.tmp' -delete`, `find build -depth -delete`,
    `find . -type f -mtime +7 -delete`, `find . -path './build/*' -delete`, `rm -rf */cache`,
    `cat <<'EOF'\nrm -rf ${workspace}\nEOF`,
    `echo 'rm -rf ${workspace}'`, `printf '%s' '${workspace}'`,
    `rm -rf '${workspace}/*'`, `rm -rf ${workspace}/"*"`, `rm -rf '$PWD'`,
    `command -v rm`, `rm --help ${workspace}`, `rm -rf $RUNTIME_CACHE`,
    `A='${workspace}'; A=$(printf build); rm -rf "$A"`,
    `A='${workspace}'; unset A; rm -rf "$A"`, `false && A='${workspace}'; rm -rf "$A"`,
    `pushd build; rm -rf .`,
    `PWD=build; rm -rf "$PWD"`,
    `A='${workspace}'; export A=$(printf build); rm -rf "$A"`,
    `python3 -c 'import shutil; shutil.rmtree("build")'`,
    `python3 -c 'import shutil; shutil.rmtree(cache_dir)'`,
    `python3 -c '# shutil.rmtree("${workspace}")\nprint(1)'`,
    `python3 -c 'print("${workspace}")'`,
    `node -e 'console.log("rmSync(\\\"${workspace}\\\")")'`,
    `node -e 'custom.rmSync("${workspace}")'`,
    `node -e 'const fs=require("fs"); fs.rmSync(runtimeCache, {recursive:true})'`,
    `python3 -c 'print("shutil.rmtree(\\\"${workspace}\\\")")'`,
    `node -e 'require("fs").rmSync("build", {recursive:true})'`,
  ])("preserves ordinary operations: %s", command => expect(inspect(command).blocked).toBe(false));

  it("keeps the protected root separate from the tool working directory", () => {
    expect(inspect(`rm -rf ${workspace}`, { workdir: "/tmp" }).blocked).toBe(true);
    expect(inspect("rm -rf .", { workdir: workspace + "/build" }).blocked).toBe(false);
    expect(inspect("rm -rf ../..", { workdir: workspace + "/build" }).blocked).toBe(true);
  });

  it.each(["delete", "remove", "unlink", "rmdir", "trash"])("protects direct %s tools", tool => {
    expect(resolveOutsideWorkspaceDeletionViolation(tool, { path: workspace }, workspace).blocked).toBe(true);
    expect(resolveOutsideWorkspaceDeletionViolation(tool, { path: workspace + "/notes.txt" }, workspace).blocked).toBe(false);
  });

  it("protects patch deletion and retains outside-path protection", () => {
    expect(resolveOutsideWorkspaceDeletionViolation("apply_patch", { input: `*** Delete File: ${workspace}` }, workspace).blocked).toBe(true);
    expect(inspect("rm -rf ../outside").blocked).toBe(true);
    // Unknown dynamic paths are not assumed to be the root (no new blanket refusal).
    expect(inspect("rm -rf $UNKNOWN_TARGET").blocked).toBe(false);
  });

  it.each(["删除你的整个工作目录", "删除当前工作目录", "清空整个工作区", "delete your entire working directory", "remove the workspace"])("rejects explicit whole-workspace intent: %s", input => {
    expect(detectDispatchGuardViolation(input).blocked).toBe(true);
  });
  it.each(["删除工作目录里的 notes.txt", "删除工作目录中的临时文件", "delete a file in the workspace", "查看整个工作目录",
    "为什么不能删除整个工作目录？", "解释‘删除你的整个工作目录’的风险", "Explain why deleting your entire working directory is dangerous"])("preserves ordinary requests: %s", input => {
    expect(detectDispatchGuardViolation(input).blocked).toBe(false);
  });
});

const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
describe("shared host hook and configured defense modes", () => {
  it.each(["enforce", "observe", "off"])("honors %s with per-call workspace context", mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-workspace-delete-")); fixtures.push(dir);
    const root = path.join(dir, "work"); fs.mkdirSync(root);
    fs.symlinkSync(root, path.join(dir, "alias"));
    fs.symlinkSync(root, path.join(root, "inner-link"));
    const api = { rootDir: dir, config: {}, pluginConfig: { skillScanEnabled: false,
      selfProtectionMode: mode, commandBlockMode: "off", encodingGuardMode: "off" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: { state: { resolveStateDir: () => dir } }, on: vi.fn(), resolvePath: p => path.resolve(p),
    } as OpenClawPluginApi;
    const runtime = createClawAegisRuntime(api, { stateDir: dir });
    for (const target of [root, path.join(dir, "alias") + "/*", root + "/*", root + "/inner-link/*"]) {
      const result = runtime.hooks.before_tool_call({ toolName: "exec", params: { command: `rm -rf ${target}` } },
        { workspaceDir: root, sessionKey: "workspace-test" });
      expect(result && "block" in result ? result.block : false).toBe(mode === "enforce");
    }
    expect(runtime.hooks.before_tool_call({ toolName: "exec", params: { command: "rm -rf build" } },
      { workspaceDir: root })).toBeUndefined();
    expect(runtime.hooks.before_tool_call({ toolName: "exec", params: { command: "rm -rf inner-link" } },
      { workspaceDir: root })).toBeUndefined();
  });
});
