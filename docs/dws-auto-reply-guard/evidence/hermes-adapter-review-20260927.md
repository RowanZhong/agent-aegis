# Hermes v2026.8.19：新增验收范围与适配源码核对

日期：2026-09-27。类型：源码核对，不是新规则运行验证。基线：`7137092b39c0ddb55ee9a956cd463f6807439427`。

用户进一步明确：Hermes v2026.8.19 先评估风险适用性，有同类风险才开发和验收对应防护；有证据证明不适用则不增加该拦截。以下源码观察只说明“若实施时”的适配要求，不能证明 Hermes 本身存在或不存在该风险。详见 [实施方案](../requirements-and-implementation.md)。

## 已观察到的适配结构

- `hermes_adapter.py` 注册原生 Python hooks，通过一个已存在的私有常驻 Node worker 调用公共 Aegis 运行逻辑。调用持锁且同步等待，多个线程共享串行桥接。
- `src/hermes-bridge.ts` 的 pre_tool_call 当前同步调用公共 before_tool_call，并立即检查 result.block。公共检查新增异步文件读取后，桥接层需要等待完整结果，否则可能遗漏 Promise 中的拒绝。这是拟开发变更需要处理的兼容点，不是已复现的现有异步绕过漏洞。
- pre_llm_call 适配按用户回合处理；当前代码明确提醒它不对应每次内部模型迭代。transform_llm_output 是最终输出转换，也不能据此伪造模型轮次。新的规则一需要核对真实目标宿主的调用点、可用元数据和因果关系。
- 现有 runId 组合 session 与 turn/task；原始字段缺失时有回退。新规则不能只看到一个非空合成 ID 就认为其唯一对应模型轮次。
- 原生工具归一化由 `src/hermes-tools.ts` 执行；Python 侧用 Hermes 的会话目录解析器获取 cwd，需要验证新增脚本检查沿用正确目录。
- on_session_end 映射回合结束，finalize/reset 清理会话。新增状态需要覆盖这些路径以及异常与卸载。
- 现有 bridge 整体故障会阻断工具；新规则内部跳过策略不得把整体引擎失败改成放行。局部读文件失败等应在新模块内部处理，不导致整个桥接进入 failure 状态。
- `plugin.yaml` 与 Python 初始化共同负责 Hermes 配置入口。新增字段应验证 settings → Python → Node 的传递和模式，不能只更新 OpenClaw JSON schema。

## 验收与资源含义

应先核对目标 Hermes 核心执行链和实际部署权限；本次仅查看了 Aegis 适配源码，尚不足以作风险结论，当前为待评估。若证据证明不适用，则排除新增拦截，并记录条件及复评触发点；若存在风险并实施，需用真实 PluginManager、CLI/Gateway、terminal 和桥接链路验证，不能用 OpenClaw 回放替代，也不能把无法观察当成没有风险。

“新增常驻进程为 0”是相对于已有 Aegis 基线：Hermes 已有一个 Node worker，本次复用它，不新建第二个。测试需计入 Python 锁等待、IPC、Node 检查、并发会话延迟，以及两个进程的 CPU/内存增量；不能仅用 Node 微基准报告总影响。

仓库既有安装文档记录 Hermes v2026.8.19 的 CLI 版本可显示 v0.20.5 / 2026.8.19，宿主提交为 `fcbd1076a93841fa88855acce810e342a5b78101`。这是文档记录；本次没有重新运行 Hermes 或更换宿主版本，实际验收必须核实。

## 本次源码证据摘要

路径均相对于 Agent Aegis 仓库。以下是本次读到文件的 SHA-256，不修改此前的 OpenClaw 证据清单。

| 文件 | SHA-256 |
|---|---|
| `hermes_adapter.py` | `934b26dcee4beaff4d73c4305a8fdad69af80c7b4bd44ab89b52241ddd751bfb` |
| `src/hermes-bridge.ts` | `08e58f0c274781d3af488719fc9410e3653656b321c3a2f7104500a073d2e663` |
| `src/hermes-tools.ts` | `e4e2496968fd913d06f1ebcb5a5f6cf87e2684bb24b41b6e0c89648a85db9eba` |
| `plugin.yaml` | `b829c2de4e6d7ce4ede846b80a4ad8d98173e3d0ca3c48db689a025fe3f6f96d` |
| `docs/hermes.md` | `2c0a6567733fd83166ad1e2a02ded51fdab1f8f8886b4ff82a23de3c5d7fa7f1` |
| `docs/README-hermes-install_zh.md` | `0691dc356ce0b50404acd6db158fea3bdcf4918adcaeb8229377f3b9dc7f3b88` |
| `tests/test_hermes_integration.py` | `086a2ee5c2621a96dbb35fd27455bd34757b03d2d913953b52bf40c2e2663811` |

本次只修订文档，没有修改适配代码、安装配置、运行进程或历史测试结果。原始 OpenClaw 兼容性和上游性能记录保持不变。
