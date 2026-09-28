# Gateway 与控制配置保护

AgentAegis 在 `before_tool_call` 中检查实际工具参数，并在宿主执行之前返回拒绝。

| 操作 | 策略模式 | 行为 |
| --- | --- | --- |
| OpenClaw `gateway.restart`、`gateway.update.run` | `commandBlockMode` | 限制 Agent 自主管理 Gateway |
| OpenClaw `gateway.config.apply`、`gateway.config.patch` | `selfProtectionMode` 与 `commandBlockMode` | 配置写入也可能触发重载/重启，取两项中更严格的模式 |
| 指定控制配置文件的修改 | `selfProtectionMode` | 保护创建、覆盖、追加、编辑、删除和替换 |

两项模式合并时，`enforce` 优先于 `observe`，`observe` 优先于 `off`。`allDefensesEnabled: false` 仍关闭全部防御。`observe` 记录命中而放行。管理员可通过 Agent 外的管理入口执行维护。

默认修改保护覆盖 `~/.openclaw/mcp-servers.json5`、`~/.openclaw/agents-list.json5`，以及 OpenClaw 可信 `runtime.state.resolveStateDir()` 返回目录中的同名文件。路径在运行时构造时绑定，不由工具参数指定。额外位置仍可通过既有 `protectedPaths` 注册，但该选项会同时保护读取。

这两项新文件规则允许读取、复制为普通备份、在文档中展示示例，以及修改其他目录中的同名文件。其他已启用的安全规则仍正常生效。Gateway 的 `config.get` 和 `config.schema.lookup` 不会被新增管理动作规则阻止；`note`/`reason` 中的描述不会改变动作分类。

文件检查识别 `write`/`edit`/`apply_patch`，shell 重定向、`tee`、`cp`/`mv`、`sed -i`、删除及已知 Python/Node 文件修改调用。它区分读源与写目标、heredoc 数据与执行的命令替换，以及写入符号链接目标与仅移除普通链接本身。直接文件工具按宿主工作目录解析，不接受额外 `workdir` 参数改变检查位置。OpenClaw 工具钩子省略目录时，使用可信生命周期上下文或明确的 Agent workspace 配置；多 Agent 的隐式目录依赖生命周期信息，不按其他 Agent 的目录猜测。

解析只分析有界、可静态确定的语法，不执行命令、读取外部脚本或查询模型。动态计算的路径、未知程序和复杂控制流不因无法解析而被一律拒绝；因此这些规则不是任意程序文件操作的沙箱。解析限长为 32 KiB，shell 嵌套最多三层，内联表达式另设深度及步数限制。

OpenClaw `2026.7.1-2` 的原生 Gateway 工具包含管理动作；`2026.8.1` 的原生同名工具只提供只读动作。插件在两版保留相同的管理操作策略。Hermes 适配器明确绑定自身宿主身份，普通同名 `gateway` 工具和 Hermes profile 中的同名文件不会被误认作 OpenClaw 管理入口或控制配置；访问上述真实 OpenClaw 目录仍受文件规则保护。

验证入口：`tests/control-config.test.ts`、`tests/test_hermes_integration.py`，以及 `tests/manual/control_config_native.mjs`。手工脚本调用已安装宿主的原生 hook 分发器、执行包装器和文件/终端工具。危险 Gateway 动作设置执行哨兵，防止测试实际重启服务；正常文件写入和读取实际执行。它不调用模型。
