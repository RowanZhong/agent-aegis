# Hermes Agent adapter

AgentAegis supports **Hermes Agent v2026.8.19**, tag commit
`fcbd1076a93841fa88855acce810e342a5b78101`, as a native, opt-in Python plugin.
It requires Python 3.11–3.13 (as required by Hermes) and Node.js 22 or newer.
The existing TypeScript engine performs detection; Python only connects the
host lifecycle and tool schemas to a persistent local Node process. No Hermes
source modifications, network service, extra model tool or LLM API key are needed.

> [!IMPORTANT]
> **Hermes v2026.9.14 is currently unsupported.** Use the pinned v2026.8.19 release
> for this adapter. No global hook-timeout override is required.

For step-by-step instructions with a pinned fork download, see the
[中文安装 README](README-hermes-install_zh.md).

## Install from a reviewed checkout

Place a reviewed copy of this repository, including the committed JavaScript
artifacts, in the active profile's plugin directory:

```bash
# Use the actual profile home if you run Hermes with a named/custom profile.
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
cp -R /absolute/path/to/reviewed/agent-aegis \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/agent-aegis"
hermes plugins enable agent-aegis
hermes plugins list
```

Restart the CLI/gateway after enabling or changing settings. Start a new
conversation to pick up a changed static policy. The checked-in runtime does
not need `npm install`; developers run `npm ci --ignore-scripts && npm test`
after changing TypeScript.

Hermes' v2026.8.19 generic Git installer scanner flags the repository's attack
signatures, UI descriptions and test fixtures as dangerous (for example,
destructive-command examples and injection-detection regexes). Consequently,
`hermes plugins install <repository>` is **not a supported installation route
for this release**, and `--force` does not override that verdict. Review the
source before using the documented user-plugin directory route above. This
adapter does not change or disable Hermes' installer scanner.

## Configuration

Merge this into the active profile's `config.yaml`; preserve other plugins:

```yaml
plugins:
  enabled:
    - agent-aegis
  entries:
    agent-aegis:
      settings:
        allDefensesEnabled: true
        defaultBlockingMode: observe
        selfProtectionMode: enforce
        commandBlockMode: enforce
        memoryGuardMode: enforce
        exfiltrationGuardMode: enforce
        protectedPaths:
          - /absolute/path/to/private-data
        protectedSkills:
          - important-skill
        protectedPlugins:
          - important-plugin
        # Optional; default is "node" resolved from PATH.
        nodeExecutable: /absolute/path/to/node
        # Optional; default 10 seconds for each bridge I/O phase.
        bridgeTimeoutSeconds: 10
```

Omit `nodeExecutable` if `node` is on the Hermes process's PATH. Existing
AgentAegis defense switches and `enforce`/`observe`/`off` modes keep their meaning.
`allDefensesEnabled: false` disables registration and does not start Node.
The legacy `skillRoots` option remains ignored: scan roots come from Hermes'
profile, configured external skills and trusted project directories available
at plugin registration. Settings are a startup snapshot, not hot-reloaded.

The adapter automatically protects its installation, runtime state, and the
active profile's `config.yaml`, `.env`, and `auth.json` when self-protection is
enabled. Named nested/external protected skills are resolved through Hermes.
State and JSONL security events live in
`ctx.state.data_dir/runtime` under the profile's `plugin-data/` namespace,
separate from the plugin's code. The existing WebUI remains an OpenClaw
configuration editor; it must not be pointed at Hermes' YAML configuration.

## Lifecycle mapping

| Hermes interface | AgentAegis behavior |
| --- | --- |
| `register_system_prompt_section` | Fixed policy, frozen by Hermes for the conversation |
| `pre_llm_call` | User-risk and skill review; dynamic findings returned as user context |
| `pre_tool_call` | Enforce/observe tool guards with Hermes-native block directives |
| `post_tool_call` | Record successful file/script artifacts and execution provenance |
| `transform_tool_result` | Inspect and mark untrusted results; append findings to the new result immediately |
| `transform_llm_output` | Redact the final response, audit refusal markers |
| `on_session_end` | End-of-turn cleanup (this Hermes hook fires every turn) |
| `on_session_finalize`, `on_session_reset` | Clear remaining session state |
| `on_unload` / process exit | Reap the Node worker and release pipes |

The dispatch guard's refusal is returned as context, enforced on subsequent
tool calls, and substituted for the final response. Hermes' `pre_llm_call`
cannot cancel inference: a refused turn can still make an LLM request.

Schema translation covers `terminal`, `read_file`, `write_file`, both `patch`
modes, single/batch `memory` updates (including omitted `action` and `new_text`),
all `skill_manage` actions, `web_extract` URL lists and `browser_navigate`.
Other tools retain their original names/arguments for generic scanning.
Relative paths use Hermes' session/worktree directory resolver, not Node's cwd.
Run keys include the session ID to isolate reused task/turn IDs.

## Prompt cache behavior

OpenClaw now receives invariant policy in `prependSystemContext` and dynamic
findings in `appendSystemContext`. A change in findings therefore preserves
the fixed policy and the entire host system prompt before it. Changing the
suffix can still invalidate tokens after that suffix; this is not a promise
of a particular provider's cache hit rate.

Hermes freezes fixed policy using its native section API. Dynamic user-risk
context uses the current user message's `api_content` path, whose bytes Hermes
preserves for later replay. Mid-turn findings are attached to newly produced
tool results. The adapter never rewrites the system prompt or older messages,
changes tool schemas, or inserts synthetic turns.

## Failure and host boundaries

- A missing/crashed/hung Node worker blocks tool calls and withholds uninspected
  transformed output. It is not automatically restarted mid-session because
  that would discard provenance and observed-secret evidence. Fix the runtime
  and restart Hermes. Requests/responses are limited to 8 MiB per frame.
- Hermes runs transform hooks in registration order; the first valid string
  wins. Put AgentAegis before other result/output transformers and check their
  interactions. It cannot override a transform result already chosen by Hermes.
- Final-response redaction runs after generation. Already streamed tokens,
  interim messages, provider reasoning, and host-internal persistence outside
  that final-response transform are not retroactively redacted. Do not treat it
  as a streaming DLP boundary.
- Tool-result transformation covers the host's `transform_tool_result` seam.
  Host-internal tools that do not fire that seam still receive pre-tool guards,
  but cannot have their results rewritten through it.
- The plugin does not sandbox the host. Remote/container filesystems cannot be
  canonicalized against local symlinks, and arbitrary custom tools or other
  in-process plugins can expose paths not covered by these schemas. Use Hermes'
  own backend isolation and approvals alongside these runtime guards.

## Tests

```bash
npm ci --ignore-scripts
npm test
git clone --depth 1 --branch v2026.8.19 \
  https://github.com/NousResearch/hermes-agent.git /tmp/hermes-v2026.8.19
python3.11 -m venv /tmp/aegis-tests
/tmp/aegis-tests/bin/python -m pip install -r tests/requirements-hermes.txt
PYTHONPATH=/tmp/hermes-v2026.8.19 \
  /tmp/aegis-tests/bin/python -m pytest -q tests/test_hermes_integration.py
```

Tests use temporary profiles, the real Hermes plugin loader/dispatcher, real
system-prompt construction and a live Node worker. Dangerous commands are
inspection inputs only; the dispatch test substitutes the final tool executor.
No live LLM call or production profile is required. CI pins Hermes to the exact
release commit and checks the committed JavaScript against a fresh build.

Separate from these credential-free tests, the [2026-09-18 live validation](live-validation-2026-09-18.md)
ran real Anthropic inference and Hermes file/terminal tools, including a
model-generated write rejected by the pre-tool guard. It also inspected actual
OpenClaw Gateway HTTP requests to verify the dynamic system-context suffix.

The [expanded capability coverage](live-coverage-2026-09-18.md) distinguishes
real-model sessions, explicitly driven native tools/hooks, scanner processes
and browser checks. It records the inline-path and encoded-result issues found
and fixed during those runs, plus remaining host and coverage limits.
It also captures five actual Anthropic HTTP requests from one Hermes session:
system and tool schemas remain byte-identical while dynamic findings appear
only in the current user message or new tool result, with prior content preserved.
That transport probe uses a deterministic loopback endpoint and does not measure
provider cache hit rates.

## 中文说明

该适配以原生插件运行于 Hermes v2026.8.19，复用 AgentAegis 的 TypeScript
防护引擎。请先审阅源码，再将完整目录放入当前 profile 的 `plugins/agent-aegis`
并执行 `hermes plugins enable agent-aegis`。该版本 Hermes 的通用安装扫描器会
将本仓库里的攻击检测规则和测试样例标记为危险，因此不能直接使用 Git 安装命令。

配置写在 `plugins.entries.agent-aegis.settings`，支持原有开关和三种防护模式。
需 Node.js 22+；安装包已带编译产物。进程故障时拒绝工具执行，不会悄悄放行。
固定规则按会话冻结，动态指令追加到本轮消息或新工具结果；OpenClaw 的动态指令
已改到系统提示词尾部。输出脱敏只覆盖最终回复，不能撤回已流式发送的内容。
安装、测试方法及其余边界见上文。
