# AgentAegis：Hermes 安装 README

本文面向已经可以正常运行 Hermes 的用户，介绍安装、配置、验证和卸载 AgentAegis。命令适用于 macOS / Linux 的 Bash、Zsh。OpenClaw 用户请看[项目首页](../README_zh.md#-快速开始)。

> [!IMPORTANT]
> **当前只支持 Hermes v2026.8.19（CLI 显示 v0.20.5 / 2026.8.19）。暂不支持 v2026.9.14，也不承诺兼容其他版本。**
> **不需要配置 `plugins.hook_callback_timeout: 0`。** 新版兼容方案已回滚；不要通过关闭宿主超时来尝试兼容新版。
> 本文固定安装已验证的插件提交 `2d310ee7333469ac6b36fd9ad40d2f8adbf86834`，保留 Hermes 适配及 KV cache 注入位置修复。

## 1. 检查前提

```bash
hermes --version
node --version
git --version
```

需要：

| 项目 | 要求 |
| --- | --- |
| Hermes | [v2026.8.19](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.19)，源码提交 `fcbd1076a93841fa88855acce810e342a5b78101` |
| Python | Hermes 使用的 Python 为 3.11–3.13；不需要为插件另建虚拟环境 |
| Node.js | 22 或更高，且运行 Hermes 的进程能找到它 |
| 模型 | 沿用 Hermes 原有模型配置；插件不需要额外 API key 或模型服务 |

仓库已包含编译好的 JavaScript，普通安装**不需要 `npm install`、`npm run build` 或修改 Hermes 源码**。如果 Hermes 版本不符，先使用独立环境准备上述版本；本文不会自动升级或降级现有 Hermes。

以下步骤在同一个终端执行。先指定实际使用的 profile 目录：

```bash
# 默认 profile；已有 HERMES_HOME 时沿用它。
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
printf '本次安装的 Hermes profile：%s\n' "$HERMES_HOME"
```

如果使用命名 profile 或自定义目录，请将上面的值改为**该 profile 的实际绝对路径**，后续始终使用同一目录。插件安装在 `$HERMES_HOME/plugins/agent-aegis`，配置在 `$HERMES_HOME/config.yaml`；不同 profile 需要分别安装、启用。

## 2. 下载固定版本并审阅

当前适配通过 [PR #12](https://github.com/antgroup/agent-aegis/pull/12) 提供。以下命令从开发 fork 下载，避免误装尚未包含适配的上游版本：

```bash
(
  set -eu
  AEGIS_SOURCE_DIR="$HOME/agent-aegis-hermes"
  git clone --branch feat/hermes-v2026.8.19-cache-safe \
    https://github.com/RowanZhong/agent-aegis.git "$AEGIS_SOURCE_DIR"
  git -C "$AEGIS_SOURCE_DIR" checkout --detach \
    2d310ee7333469ac6b36fd9ad40d2f8adbf86834
  git -C "$AEGIS_SOURCE_DIR" rev-parse HEAD
)
```

最后应输出上面的完整提交 SHA。若下载失败或目录已存在，先解决该问题再继续，不要跳过版本核对。请在安装前审阅该提交和 PR，特别是 `hermes_adapter.py`、`src/hermes-bridge.js` 及防护规则。

**为什么不直接执行 `hermes plugins install <Git URL>`？** v2026.8.19 的通用安装扫描器会将本仓库里的攻击检测规则、界面描述和测试样例标记为危险；`--force` 也不能覆盖该结论。因此本适配采用审阅后的用户插件目录安装方式，不修改或关闭扫描器。

## 3. 安装并启用

下面从固定提交导出文件，不复制 `.git`、本地修改或 `node_modules`。若目标目录已存在，会停止，避免覆盖已有安装；请改用后文的更新步骤。

```bash
(
  set -eu
  set -o pipefail
  AEGIS_SOURCE_DIR="$HOME/agent-aegis-hermes"
  AEGIS_PLUGIN_DIR="$HERMES_HOME/plugins/agent-aegis"
  if [ -e "$AEGIS_PLUGIN_DIR" ] || [ -L "$AEGIS_PLUGIN_DIR" ]; then
    printf '插件目录已存在，请按更新步骤处理：%s\n' "$AEGIS_PLUGIN_DIR" >&2
    exit 1
  fi
  mkdir -p "$AEGIS_PLUGIN_DIR"
  git -C "$AEGIS_SOURCE_DIR" archive \
    2d310ee7333469ac6b36fd9ad40d2f8adbf86834 | tar -x -C "$AEGIS_PLUGIN_DIR"
  test -f "$AEGIS_PLUGIN_DIR/plugin.yaml"
  test -f "$AEGIS_PLUGIN_DIR/src/hermes-bridge.js"
  hermes plugins enable agent-aegis --no-allow-tool-override
  hermes plugins list --plain --no-bundled
)
```

列表中应出现 `agent-aegis`，状态为 `enabled`。`--no-allow-tool-override` 表示不授予替换内置工具的权限；本插件通过原生 hooks 工作，不需要该权限。启用命令也会清理该插件原有的 `plugins.disabled` 记录。

列表中的 `2026.3.14` 是插件自身的版本字段，不是 Hermes 版本；本文使用完整提交 SHA 标识实际安装的适配代码。

如果导出中途失败，目标目录可能是不完整的；先将它移出 `plugins/` 再重新安装，不能仅凭目录存在判断安装成功。

## 4. 配置防护

用文本编辑器打开 `$HERMES_HOME/config.yaml`，把以下设置**合并到已有的 `plugins` 节点**。保留原有模型配置、其他插件和授权字段；不要创建第二个 `plugins:`，也不要用整个示例覆盖配置文件。

```yaml
plugins:
  enabled:
    - agent-aegis
    # 保留已有的其他插件
  entries:
    agent-aegis:
      allow_tool_override: false
      settings:
        allDefensesEnabled: true
        defaultBlockingMode: enforce
```

这是按默认防护策略执行拦截的最小配置。插件在自保护开启时，会自动保护其安装目录、运行状态以及当前 profile 的 `config.yaml`、`.env`、`auth.json`。

按需在同一个 `settings` 节点增加以下字段；路径和名称仅为示例，必须替换成实际值，无需的字段直接省略：

```yaml
        protectedPaths:
          - /absolute/path/to/private-data
        protectedSkills:
          - important-skill
        protectedPlugins:
          - important-plugin
        # 只有 Hermes 进程无法从 PATH 找到 Node 时才需要：
        nodeExecutable: /absolute/path/to/node
        # 可省略；默认每个桥接 I/O 阶段最多等待 10 秒：
        bridgeTimeoutSeconds: 10
```

`protectedPaths` 会限制对目标及其子路径的访问，包含读取，并非只防止修改。只加入确实需要隔离的路径，不要把整个日常工作目录都加入。

`nodeExecutable` 可填写 `command -v node` 得到的绝对路径。尤其注意 Gateway 服务的 `PATH` 可能与交互终端不同。`bridgeTimeoutSeconds` 是插件的桥接等待设置，不是 Hermes 的全局 hook 超时，也不代表整个工具调用的总耗时上限。

| 设置 | 含义 |
| --- | --- |
| `defaultBlockingMode: enforce` | 对遵循该模式的防护项执行拦截，推荐用于正式使用 |
| `defaultBlockingMode: observe` | 对遵循该模式的防护项记录风险而不拦截，不能当作已经启用阻断 |
| `defaultBlockingMode: off` | 关闭遵循该模式的防护项；不等于关闭整个插件 |
| `allDefensesEnabled: false` | 停用整个适配器的防护注册，不启动 Node worker |

单项模式（如 `selfProtectionMode`、`commandBlockMode`）优先于 `defaultBlockingMode`。若已有单项 `enforce` 设置，仅把默认模式改为 `observe` 并不会让所有防护都变为观察模式。完整配置与边界见 [Hermes 适配说明](hermes.md#configuration)。

## 5. 重启并验证

### 重新加载

- CLI：退出正在运行的 Hermes，再从同一终端执行 `hermes`，开始新会话。
- Gateway：对实际使用该 profile 的 Gateway 执行 `hermes gateway restart`；若是手动启动的进程，则退出并按原方式重新启动。

启用、禁用及配置变更都需要重新加载。静态规则按会话冻结，修改后请新建对话。

### 检查启用状态与正常工具

```bash
hermes plugins list --plain --no-bundled
```

确认 `agent-aegis` 为 `enabled`，启动时没有 `AgentAegis startup failed`、`configuration failed` 或 `runtime unavailable`。在新会话中让 Hermes 执行一次无害工具操作，例如查看当前工作目录。应能正常执行；仅在列表中显示 enabled 并不能证明 Node 引擎已正常启动。

### 可选：用一次性文件验证保护

在普通终端创建一个不含真实数据的测试目录：

```bash
AEGIS_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aegis-install-check.XXXXXX")"
printf 'ORIGINAL\n' > "$AEGIS_TEST_DIR/canary.txt"
printf '请将这个绝对路径加入 protectedPaths：%s/canary.txt\n' "$AEGIS_TEST_DIR"
```

将输出的 `canary.txt` **完整绝对路径**添加到前述 `protectedPaths`，保留原有条目，重启并新建会话。用上面实际生成的路径替换下面的占位符，发送：

> 请使用 write_file 把 `INSTALL_OK` 写入 `<测试目录绝对路径>/normal.txt`，再尝试把 `CHANGED` 写入同目录的 `canary.txt`。这些是一次性测试文件；遇到拒绝或拦截就停止，不要改用其他方式。

在普通终端检查（不要让模型自证）：

```bash
cat "$AEGIS_TEST_DIR/normal.txt"
cat "$AEGIS_TEST_DIR/canary.txt"
find "$HERMES_HOME/plugin-data" -type f -name defense-events.jsonl -print
```

成功的工具拦截证据是：普通文件写入成功、`canary.txt` 仍为 `ORIGINAL`，并且相应事件文件新增记录包含 `defense: "protected_path_guard"`、`result: "blocked"` 和本次测试路径。事件是 JSONL，可在文本编辑器中查看最新记录。**如果模型或前置策略在工具调用前就拒绝，文件虽未改变，也不能算工具拦截测试通过**；不要为凑结果关闭防护。已有的原生工具与模型验证记录见[覆盖报告](live-coverage-2026-09-18.md)。

测试完成后，从配置中移除这条临时路径，重启并新建会话；一次性测试目录可自行删除。日志可能包含检测到的内容，不要直接公开包含真实业务数据的日志。

## 6. 更新、回退和卸载

### 更新或重装插件

先退出使用该 profile 的 CLI；Gateway 用户先执行 `hermes gateway stop`。备份旧插件及配置到 `plugins/` 之外，避免备份副本也被发现为插件：

```bash
(
  set -eu
  AEGIS_BACKUP_DIR="$HERMES_HOME/backups/agent-aegis-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$AEGIS_BACKUP_DIR"
  cp -p "$HERMES_HOME/config.yaml" "$AEGIS_BACKUP_DIR/config.yaml"
  mv "$HERMES_HOME/plugins/agent-aegis" "$AEGIS_BACKUP_DIR/agent-aegis"
  printf '备份位置：%s\n' "$AEGIS_BACKUP_DIR"
)
```

然后重新执行第 3 节安装、检查第 4 节配置，并按第 5 节重启验证。当前文档固定的 SHA 用于重装同一已验证版本；只有在后续发布明确说明兼容、且你审阅新提交后，才将下载和安装命令里的 SHA 一起替换。**不要对这份无 `.git` 的安装副本执行 `hermes plugins update agent-aegis`，也不要把更新插件等同于升级 Hermes。**

需要回退时：先停止 Hermes，将新插件目录移出 `plugins/`，把备份的 `agent-aegis` 目录移回原位置；仅在确有需要时恢复配置备份，避免覆盖之后的其他配置修改。运行状态和事件位于 `$HERMES_HOME/plugin-data/`，以上步骤不会删除它们。恢复后重新启用、重启并验证。

### 临时禁用

```bash
hermes plugins disable agent-aegis
```

重启并新建会话后生效。重新启用时执行 `hermes plugins enable agent-aegis --no-allow-tool-override`，再重启。

### 卸载

退出 CLI / 停止该 profile 的 Gateway，然后执行：

```bash
hermes plugins disable agent-aegis
hermes plugins remove agent-aegis
hermes plugins list --plain --no-bundled
```

卸载会删除插件安装目录，因此先备份需要保留的本地修改。配置中的该插件 settings 与 `plugin-data/` 中的状态、日志不会随代码目录删除；需要时可在备份后手动清理。之后再启动 Hermes。

## 7. 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 列表里没有插件 | 确认当前 profile，以及 `$HERMES_HOME/plugins/agent-aegis/plugin.yaml` 存在；不要多套一层目录 |
| 显示 disabled / not enabled | 用启用命令处理，而不是只手工添加 `enabled`；`disabled` 中的条目优先 |
| enabled 但所有工具报 runtime unavailable | 检查 Hermes 版本、Node 22+、服务 PATH / `nodeExecutable`、完整运行文件和启动日志；修复后重启 |
| Git 安装被扫描器拒绝 | 按第 2–3 节审阅并导出固定提交；不是增加 `--force` 或关闭扫描器 |
| YAML 改了但行为没变 | 确认改的是实际 profile；合并到 `plugins.entries.agent-aegis.settings`，检查单项模式，然后重启并新建会话 |
| 能否使用现有 WebUI 配置 Hermes？ | 不能；现有 WebUI 面向 OpenClaw，Hermes 请编辑 `config.yaml` |

Hermes 的固定规则保留在静态 system prompt，动态指令放到当前用户消息或新工具结果，不回写历史消息；OpenClaw 的动态指令已移至 system prompt 尾部。已验证注入位置与请求内容稳定性，**不承诺某个模型服务的实际 KV cache 命中率**。输出脱敏只覆盖最终回复，不能撤回已流式发出的内容；其余能力及限制见[适配说明](hermes.md)和[真机验证报告](live-validation-2026-09-18.md)。
