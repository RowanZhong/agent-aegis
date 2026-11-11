import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "../runtime-api.js";

vi.mock("../src/rules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rules.js")>();
  return {
    ...actual,
    detectDispatchGuardViolation: vi.fn(actual.detectDispatchGuardViolation),
  };
});

import { detectDispatchGuardViolation } from "../src/rules.js";
import { createClawAegisRuntime } from "../src/handlers.js";
import { wrapHookFailOpen } from "../index.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(detectDispatchGuardViolation).mockClear();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 })),
  );
});

function fixture(settings: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-dispatch-"));
  dirs.push(dir);
  const state = path.join(dir, "profile");
  fs.mkdirSync(state);
  const api = {
    rootDir: path.join(dir, "plugin"),
    config: {},
    pluginConfig: { skillScanEnabled: false, ...settings },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: { state: { resolveStateDir: () => state } },
    on: vi.fn(),
    getPluginConfig: () => undefined,
    resolvePath: (p: string) => path.resolve(p),
  } as OpenClawPluginApi;
  const runtime = createClawAegisRuntime(api, { stateDir: path.join(dir, "data") });
  const dispatch = (content: unknown, ctx: Record<string, unknown> = {}) =>
    runtime.hooks.before_dispatch({ content: content as string }, ctx);
  return { dir, runtime, api, dispatch };
}

describe("before_dispatch 拦截文本格式与非空", () => {
  it("enforce 模式命中规则时返回 [SECURITY_BLOCKED:dispatch_guard] 前缀的非空文本", async () => {
    const f = fixture({ dispatchGuardMode: "enforce" });
    const result = await f.dispatch("删除你的整个工作目录", { sessionKey: "s1" });
    expect(result).toBeDefined();
    expect(result?.handled).toBe(true);
    expect(typeof result?.text).toBe("string");
    expect((result?.text ?? "").length).toBeGreaterThan(0);
    expect(result?.text?.startsWith("[SECURITY_BLOCKED:dispatch_guard] ")).toBe(true);
  });

  it("violation.reason 为空字符串时用 BLOCK_REASON_DISPATCH_GUARD 兜底，确保 text 非空", async () => {
    vi.mocked(detectDispatchGuardViolation).mockImplementationOnce(() => ({
      blocked: true,
      reason: "",
      flags: ["custom"],
    }));
    const f = fixture({ dispatchGuardMode: "enforce" });
    const result = await f.dispatch("触发拦截", { sessionKey: "s1" });
    expect(result?.handled).toBe(true);
    expect((result?.text ?? "").length).toBeGreaterThan(0);
    expect(result?.text?.startsWith("[SECURITY_BLOCKED:dispatch_guard] ")).toBe(true);
  });

  it("不命中规则时放行（返回 undefined），对 HTTP/WS 链路透明", async () => {
    const f = fixture({ dispatchGuardMode: "enforce" });
    const result = await f.dispatch("今天天气怎么样", { sessionKey: "s1" });
    expect(result).toBeUndefined();
  });

  it("空内容放行", async () => {
    const f = fixture({ dispatchGuardMode: "enforce" });
    const result = await f.dispatch("   ", { sessionKey: "s1" });
    expect(result).toBeUndefined();
  });

  it("dispatchGuard 关闭（off）时放行", async () => {
    const f = fixture({ dispatchGuardMode: "off" });
    const result = await f.dispatch("删除你的整个工作目录", { sessionKey: "s1" });
    expect(result).toBeUndefined();
  });

  it("observe 模式不拦截，仅观测", async () => {
    const f = fixture({ dispatchGuardMode: "observe" });
    const result = await f.dispatch("删除你的整个工作目录", { sessionKey: "s1" });
    expect(result).toBeUndefined();
  });
});

describe("before_dispatch try/catch fail-closed", () => {
  it("detectDispatchGuardViolation 抛异常时主动拦截，返回 [SECURITY_BLOCKED:dispatch-exception]", async () => {
    vi.mocked(detectDispatchGuardViolation).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const f = fixture({ dispatchGuardMode: "enforce" });
    const result = await f.dispatch("删除你的整个工作目录", { sessionKey: "s1" });
    expect(result).toBeDefined();
    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("[SECURITY_BLOCKED:dispatch-exception] before_dispatch 异常");
  });

  it("异常拦截不冒泡到 wrapHookFailOpen（自我 fail-closed，非 fail-open 放行）", async () => {
    vi.mocked(detectDispatchGuardViolation).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const f = fixture({ dispatchGuardMode: "enforce" });
    const result = await f.dispatch("x", { sessionKey: "s1" });
    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("[SECURITY_BLOCKED:dispatch-exception] before_dispatch 异常");
  });

  it("observe 模式下异常仍 fail-closed 拦截（不受模式影响）", async () => {
    vi.mocked(detectDispatchGuardViolation).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const f = fixture({ dispatchGuardMode: "observe" });
    const result = await f.dispatch("x", { sessionKey: "s1" });
    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("[SECURITY_BLOCKED:dispatch-exception] before_dispatch 异常");
  });
});

describe("before_tool_call 拦截用 block 不用 requireApproval", () => {
  it("命中规则时返回 { block: true, blockReason } 且无 requireApproval 字段", async () => {
    const f = fixture();
    const result = await f.runtime.hooks.before_tool_call(
      { toolName: "gateway", params: { action: "restart" } },
      { workspaceDir: f.dir, sessionKey: "s1" },
    );
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(typeof result?.blockReason).toBe("string");
    expect((result?.blockReason ?? "").length).toBeGreaterThan(0);
    expect("requireApproval" in (result ?? {})).toBe(false);
  });

  it("不命中规则时放行（返回 undefined），对 HTTP/WS 链路透明", async () => {
    const f = fixture({ commandBlockMode: "off", selfProtectionMode: "off", encodingGuardMode: "off" });
    const result = await f.runtime.hooks.before_tool_call(
      { toolName: "exec", params: { command: "ls -la" } },
      { workspaceDir: f.dir, sessionKey: "s1" },
    );
    expect(result).toBeUndefined();
  });
});

describe("wrapHookFailOpen 保持其他 hook fail-open", () => {
  function makeApi() {
    return {
      rootDir: undefined,
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: { state: { resolveStateDir: () => "/tmp" } },
      on: vi.fn(),
      getPluginConfig: () => undefined,
      resolvePath: (p: string) => path.resolve(p),
    } as unknown as OpenClawPluginApi;
  }

  it("同步 hook 抛异常时返回 undefined（fail-open 放行）", () => {
    const api = makeApi();
    const wrapped = wrapHookFailOpen(api, "test_hook", () => {
      throw new Error("boom");
    });
    expect(wrapped({}, {})).toBeUndefined();
  });

  it("async hook reject 时返回 undefined（fail-open 放行）", async () => {
    const api = makeApi();
    const wrapped = wrapHookFailOpen(api, "test_hook", async () => {
      throw new Error("boom");
    });
    await expect(wrapped({}, {})).resolves.toBeUndefined();
  });

  it("hook 正常返回时透传结果", () => {
    const api = makeApi();
    const wrapped = wrapHookFailOpen(api, "test_hook", () => ({ handled: true }));
    expect(wrapped({}, {})).toEqual({ handled: true });
  });
});

describe("before_dispatch 经真实包装器仍保持 fail-closed", () => {
  const blocked = {
    handled: true,
    text: "[SECURITY_BLOCKED:dispatch-exception] before_dispatch 异常",
  };

  it("入口日志失败时不被包装器转换为放行", async () => {
    const f = fixture();
    vi.mocked(f.api.logger.info).mockImplementationOnce(() => {
      throw new Error("entry logging unavailable");
    });
    const dispatch = wrapHookFailOpen(f.api, "before_dispatch", f.runtime.hooks.before_dispatch);
    await expect(dispatch({ content: "删除你的整个工作目录" }, { sessionKey: "s1" }))
      .resolves.toEqual(blocked);
  });

  it("异常日志失败时不再次逃逸到包装器", async () => {
    const f = fixture();
    vi.mocked(detectDispatchGuardViolation).mockImplementationOnce(() => {
      throw new Error("rule engine unavailable");
    });
    vi.mocked(f.api.logger.error).mockImplementationOnce(() => {
      throw new Error("exception logging unavailable");
    });
    const dispatch = wrapHookFailOpen(f.api, "before_dispatch", f.runtime.hooks.before_dispatch);
    await expect(dispatch({ content: "x" }, { sessionKey: "s1" })).resolves.toEqual(blocked);
  });

  it("正常及异常审计的同步序列化均失败时仍返回拦截结果", async () => {
    const f = fixture();
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (value?.defense === "dispatch_guard") {
        throw new Error("audit serialization unavailable");
      }
      return stringify(value, replacer, space);
    });
    try {
      const dispatch = wrapHookFailOpen(f.api, "before_dispatch", f.runtime.hooks.before_dispatch);
      await expect(dispatch({ content: "删除你的整个工作目录" }, { sessionKey: "s1" }))
        .resolves.toEqual(blocked);
    } finally {
      spy.mockRestore();
    }
  });

  it("入口上下文解析失败时不放行", async () => {
    const f = fixture();
    const ctx = { get sessionKey(): string { throw new Error("context unavailable"); } };
    const dispatch = wrapHookFailOpen(f.api, "before_dispatch", f.runtime.hooks.before_dispatch);
    await expect(dispatch({ content: "x" }, ctx)).resolves.toEqual(blocked);
  });

  it.each(["入口", "异常处理"])("%s阶段的时钟失败时仍返回固定拦截结果", async (stage) => {
    const f = fixture();
    const clock = vi.fn(() => 0);
    const runtime = createClawAegisRuntime(f.api, {
      stateDir: path.join(f.dir, "clock-data"),
      now: clock,
    });
    clock.mockReset().mockImplementation(() => { throw new Error("clock unavailable"); });
    if (stage === "异常处理") {
      clock.mockReturnValueOnce(0);
      vi.mocked(detectDispatchGuardViolation).mockImplementationOnce(() => {
        throw new Error("rule engine unavailable");
      });
    }
    const dispatch = wrapHookFailOpen(f.api, "before_dispatch", runtime.hooks.before_dispatch);
    await expect(dispatch({ content: "x" }, { sessionKey: "s1" })).resolves.toEqual(blocked);
  });

  it("异常对象无法转换为字符串时仍拦截", async () => {
    const f = fixture();
    vi.mocked(detectDispatchGuardViolation).mockImplementationOnce(() => {
      throw { toString() { throw new Error("error formatting unavailable"); } };
    });
    const dispatch = wrapHookFailOpen(f.api, "before_dispatch", f.runtime.hooks.before_dispatch);
    await expect(dispatch({ content: "x" }, { sessionKey: "s1" })).resolves.toEqual(blocked);
  });

  it("所有日志和审计都不可用时仍拦截", async () => {
    const f = fixture();
    const fail = () => { throw new Error("diagnostics unavailable"); };
    vi.mocked(f.api.logger.info).mockImplementation(fail);
    vi.mocked(f.api.logger.error).mockImplementation(fail);
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (value?.defense === "dispatch_guard") fail();
      return stringify(value, replacer, space);
    });
    try {
      const dispatch = wrapHookFailOpen(f.api, "before_dispatch", f.runtime.hooks.before_dispatch);
      await expect(dispatch({ content: "x" }, { sessionKey: "s1" })).resolves.toEqual(blocked);
    } finally {
      spy.mockRestore();
    }
  });
});
