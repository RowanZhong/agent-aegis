import { describe, expect, it } from "vitest";
import { normalizeHermesTool } from "../src/hermes-tools.js";

const ctx = { home: "/profiles/alice" };
describe("Hermes v2026.8.19 tool schema translation", () => {
  it.each([["terminal", "exec"], ["read_file", "read"], ["write_file", "write"],
    ["patch", "edit"], ["search_files", "search_files"]])("maps %s to %s without mutating args", (name, expected) => {
    const args = Object.freeze({ path: "x", new_string: "y", command: "pwd" });
    expect(normalizeHermesTool(name, args, ctx)).toEqual([{ toolName: expected, params: args }]);
  });
  it("maps V4A multi-file patches", () => {
    const patch = "*** Begin Patch\n*** Delete File: /sensitive/key\n*** End Patch";
    expect(normalizeHermesTool("patch", { mode: "patch", patch }, ctx)[0])
      .toEqual({ toolName: "apply_patch", params: { mode: "patch", patch, input: patch } });
  });
  it("inspects every memory batch write, including the new_text alias", () => {
    expect(normalizeHermesTool("memory", { target: "user", operations: [
      { action: "remove", old_text: "x" }, { action: "add", content: "safe" },
      { action: "replace", new_text: "unsafe" },
    ] }, ctx)).toEqual([
      { toolName: "memory_store", params: { text: "safe", category: "user" } },
      { toolName: "memory_store", params: { text: "unsafe", category: "user" } },
    ]);
  });
  it("uses the host-resolved nested/external skill directory", () => {
    const events = normalizeHermesTool("skill_manage", { action: "write_file", name: "ops",
      file_path: "scripts/run.py", file_content: "print('hi')" }, { ...ctx, skillDir: "/external/team/ops" });
    expect(events[0].params.path).toBe("/external/team/ops/scripts/run.py");
    expect(events[0].params.content).toBe("print('hi')");
  });
  it("inspects every web_extract URL", () => {
    expect(normalizeHermesTool("web_extract", { urls: ["https://example.org", "http://127.0.0.1"] }, ctx)
      .map((e) => e.params.url)).toEqual(["https://example.org", "http://127.0.0.1"]);
  });
});
