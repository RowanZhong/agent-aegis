# 已改造 Agent Aegis 分支的 OpenClaw 兼容性核对

日期：2026-09-27。目标 feat/hermes-v2026.8.19-cache-safe，提交 7137092b39c0ddb55ee9a956cd463f6807439427。本地仓库无改动；前轮已核对 GitHub 分支同提交。

结论：该分支保留 OpenClaw 原生入口，不是 Hermes 专用版。当前提交在 OpenClaw 2026.7.1-2 与 2026.8.1 的关键 hook 回放通过。2026.8.1 还有历史真实 Gateway 专项验证；没有证据将此扩大为两版、所有能力、公司 Kubernetes 环境的完整真机验收。

## 入口与历史证据

package.json 的 openclaw.extensions 仍指向 index.js；Hermes 使用独立适配入口。当前入口保持同步 hook 同步返回，修复来源 d52fd003870066deb961589462ba55e5d6c2acc1。声明的 minGatewayVersion 只是兼容声明，不能替代逐版验证。

仓库 docs/live-validation-2026-09-18.md 记录真实 OpenClaw 2026.8.1 Gateway + 回环 OpenAI 兼容端点：静态系统提示完整前缀保留、动态提醒追加、假密钥在历史消息回放中被脱敏。它不包含真实外部模型推理或提供商缓存命中率，也不是当前所有功能的穷尽验证。未找到 2026.7.1-2 同等历史 Gateway 记录。后续误报优化记录以 Hermes 为主，不能全部计入 OpenClaw 覆盖。

## 本轮补测

使用当前提交导出的真实 index.js、src/*.js，以及两版已安装 OpenClaw 的真实 hook runner。注册通过测试 API 捕获后交给真实 runner，属于宿主 hook 级回放；没有经过真实插件加载器、Gateway、模型、钉钉/Web 或实际工具执行。所有状态、日志和源代码副本均在隔离临时目录。

两版均完成以下明确断言：
- before_tool_call 拒绝生效，允许不能覆盖另一检查器的拒绝。
- 同步 before_message_write 的脱敏修改被宿主接收，假密钥移除，不再返回 Promise。
- 工具结果不可信内容提醒/角色 token 清理的修改被宿主接收。
- before_prompt_build 保留静态 prependSystemContext，动态结果放入 appendSystemContext。
- message_sending 返回的脱敏正文被宿主接收。
- 仅打印保护路径通过，试图实际访问该路径的内联工具输入被拒绝；命令没有执行。
- agent_end 清理会话敏感值状态。
- 重复完全相同的 DWS 查询在同 run 第四次触发已有 loop_guard。

另记录了普通 DWS 命令、管道、脚本入口的允许结果；其中 Python 列表形式脚本执行案例是覆盖边界观察，不作为安全阻断通过项。没有新增运行时依赖或修改代码。

首轮测试把 Hermes 的英文安全提示标记误用于 OpenClaw 断言，因此在两版都失败。检查真实 OpenClaw 实现后改为断言中文不可信内容提示和角色前缀移除，再回放通过。这个修正是测试前提调整，不是产品修复。

## 必要配置与限制

两版源码均有非内置插件的 allowConversationAccess 授权检查；提示注入也受 allowPromptInjection 控制。建议在现有 plugins.entries.agent-aegis 条目中合并：

```json
{
  "enabled": true,
  "hooks": {
    "allowConversationAccess": true,
    "allowPromptInjection": true
  }
}
```

保留已有 config 等字段。缺少会话授权时，部分 hook 注册会被宿主拒绝，可能表现为“插件已安装但部分能力没生效”。完整部署验证必须包括注册诊断，不能用手工回放绕过权限来证明安装成功。

历史文档指出本地 agent --local 路径的初探没有执行这些 hook，已验证的是 Gateway 路径。当前没有将本地 CLI 路径新增标记为已保护。公司钉钉/Web 入口、容器负载、全部策略组合和长期资源情况仍待端到端验证。

## 原始回放证据

- [旧版](validation/openclaw-fork-20260927/result-old.json)
- [新版](validation/openclaw-fork-20260927/result-new.json)
- [测试脚本](validation/openclaw-fork-20260927/fork-replay.mjs)

脚本需在旁边放置该提交源码目录 aegis-fork，宿主路径按实际安装调整。当前没有修改仓库、生产插件或 OpenClaw 配置。
