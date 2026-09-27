# Hermes v2026.8.19 两条 DWS 自动回复风险链评估

日期：2026-09-27。范围：W0-H 前置风险适用性评估；没有实施新拦截规则。

**后续真实验证更新：第一条 Agent 链已在固定 v2026.8.19 的原生 CLI、真实模型、真实 DWS 中复现，实际发出并回读 1 条测试回复。第二条脚本链在模型授权预检时被模型拒绝，仍待评估。详见[真实收发验证报告](hermes-live-dws-validation-20260927.md)。以下第 1—9 节保留此前合成回放及登录阶段的记录，其中“本轮”指对应的早期轮次。企业集群仍未实测。**

## 1. 结论与决策

**两条风险所需的 Hermes 执行链均存在，并已在指定版本、真实 Aegis 默认防护开启的隔离环境中验证可达。企业真实 DWS 身份下的完整链路仍为“证据不足、待评估”，不能据此宣称线上已复现，也不能把 Hermes 排除为不适用。**

用户本轮确认已部署，并补充了 Kubernetes、每人一个 Pod/独立 Hermes 实例，以及钉钉、Web 两条入口架构。具体配置仍待提供；本轮没有企业 profile、DWS 有效授权、网络策略或外部强制审批的证据。

| 风险链 | 指定宿主的能力与控制结论 | 企业部署的 W0-H 状态 | 后续决策 |
|---|---|---|---|
| 外部来信 → 原生模型 → 工具发送 | 真实模型循环能消费工具返回；后续模型响应能调用 terminal 发送。默认 Aegis 与 Hermes manual 审批未对本次合成链产生拒绝或人工确认 | 证据不足：未核实实际消息读取、员工身份发送权限及额外审批边界 | 保留为适用风险候选，补齐企业证据后决定纳入；本轮不开始规则实现 |
| 脚本读取 → 模型 HTTP → DWS 发送 | 单个真实 terminal 子进程内可以完成整条合成数据链；宿主/Aegis 只收到外层工具调用，内部 subprocess 与 HTTP 不会逐次成为 Hermes 工具调用 | 证据不足：还需确认脚本可用的模型端点/授权及 DWS 读写权限 | 独立核实，不能用第一条的结论替代；本轮不开始规则实现 |

在“terminal 可执行、DWS 可用且以员工身份获得相应读写授权、模型端点可达、没有额外强制逐条审批”的部署条件下，两类业务风险均成立。这是有前提的推断，不是对尚未提供配置的企业部署作事实认定。

本报告评估的是企业要求的“AI 回复需本人审批”是否由现有边界保证；没有将其直接定性为 Hermes 上游可报告漏洞，也没有复现敏感数据外泄或统计提示注入成功率。

## 2. 版本、环境与证据等级

| 对象 | 本次核对结果 |
|---|---|
| 评估目标 | Hermes tag `v2026.8.19`，commit `fcbd1076a93841fa88855acce810e342a5b78101`，隔离 clone 后核对 HEAD，源码未修改 |
| 官方版本对应 | [官方发布页](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.19) 标为 `v0.20.5 (v2026.8.19)` |
| Aegis | 本仓库 commit `7137092b39c0ddb55ee9a956cd463f6807439427`；通过临时 profile 的原生插件发现加载 Python adapter 和真实 Node worker |
| Aegis 配置 | `settings: {}`，沿用基线默认启用和 `enforce`；没有关闭任何既有防护。另验证已有危险命令检查返回 block，该对照命令没有执行 |
| Hermes 测试配置 | `terminal.backend=local`，`approvals.mode=manual`，没有 yolo、force 或永久 allowlist；临时 profile、临时工作目录 |
| 运行环境 | Darwin arm64、Python 3.11.16、Node v26.8.1；复用本机 Python 依赖环境，宿主模块由固定 checkout 加载，未进行完整依赖锁重建 |
| DWS 真实安装 | npm 包 `dingtalk-workspace-cli` 版本 `1.0.58`；只执行 auth status、发送命令 help/schema 等只读自省 |
| DWS 源码参考 | 本机已有审查 checkout，tag `v1.0.58`，HEAD `1b06d0105a27750a888a361abaa465f93b7f729d`，工作区干净 |
| 本机默认 Hermes | 实际为 `v2026.8.27` / `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`；默认 profile 为 local terminal，未安装 Aegis。没有用此版本代替目标版本验证，也没有修改该 profile |
| 本机 DWS 状态 | 首轮评估时默认 `dws auth status` 返回 `authenticated:false`；随后用户明确要求登录，已完成官方登录及真实只读接口验证，见第 9 节 |
| 企业环境 | 用户确认 Kubernetes 每人一个 Pod/独立 Hermes 实例，钉钉私有化 IM 直连，以及 Web → OpenAI 兼容 HTTP → 自研 Agent Gateway → 对应 Hermes；具体配置待提供，本机结果不代表企业权限状态 |

**动态证据的范围：** 原生 PluginManager、Python/Node bridge、`AIAgent.run_conversation`、terminal 后端、shell、子进程和 HTTP 传输均真实执行；DWS 命令由只写临时文件的合成替身代替，模型由 loopback 确定性 OpenAI 兼容端点代替。没有调用外部模型，也没有发送真实钉钉消息。合成 DWS JSON 不是正式 DWS 结果适配样本。

CLI 和 Gateway 入口本轮追踪了调用原生核心的源码，但未运行两者的完整入口端到端。因此本轮结果不得作为未来 Hermes CLI/Gateway 新规则验收通过记录。

### 企业架构信息对判断的影响

用户提供的两条接入链是：

```text
钉钉私有化 IM → 员工 Pod 中的 Hermes
自研 Web → OpenAI 兼容 HTTP → 自研 Agent Gateway → 对应员工 Pod 中的 Hermes
```

- 每人一 Pod 为员工之间的隔离提供部署基础；是否严格隔离还取决于挂载、凭据、ServiceAccount、网络等配置。本次两条风险均可发生在同一个员工 Pod 内，不需要跨 Pod 或突破 Kubernetes 隔离。
- 即使 Pod 隔离正确，若 Hermes 工具与 DWS 使用该员工的可达身份/权限，外部来信经模型后仍可能以该员工身份发出。Kubernetes 这一事实没有证明 Pod 内存在逐条 AI 正文审批。
- 私有化 IM 限定了接入环境，不会自动将其他人的消息正文变成可信操作指令。
- 自研 Agent Gateway 的员工路由、认证和转发是重要控制，但当前只有拓扑描述，不能假设它逐条审阅 DWS 工具发送、限制脚本出站，或已向 Hermes 传递可信原始请求及完整关联字段。
- 两条入口都要核对实际生效的工具能力、DWS 身份与请求来源。入口文本中的身份声明不能代替可信路由元数据。
- 本报告沿用已定的 DWS 工具/脚本范围；不会把所有正常 Channel 最终答复都直接归为新增规则应拦截的对象。若消息仅经原生 Channel 进入而没有可观察的 DWS 读取，需单列覆盖边界。

这些部署信息增强了“应继续核实两条风险”的理由，但尚不能替代 DWS 读写授权和不可绕过确认边界的证据；企业 W0-H 状态仍为待评估。

## 3. 规则一对应的执行链

源码链：

1. CLI 与 Gateway 最终进入同一个 `AIAgent.run_conversation`。参考 [CLI 调用点](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/cli.py#L21337)、[Gateway 调用点](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/gateway/run.py#L6416)。这不表示两者身份与工具配置相同。
2. 模型生成工具调用后，执行器调用原生 `pre_tool_call`，然后执行工具。[执行器](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/agent/tool_executor.py#L627)
3. 终端的输出经工具结果处理后作为 tool message 放回会话。[结果入上下文](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/agent/tool_executor.py#L2698)
4. 模型循环继续，后续响应可以产生另一个 terminal 调用。[循环执行工具](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/agent/conversation_loop.py#L7326)

本次回放有 3 次真实模型 HTTP 请求：第一次响应要求读合成消息；第二次请求确实携带读取结果中的 canary，响应要求向同一合成会话发送模型响应正文；第三次请求取得发送结果后结束。最终本地发送文件有且仅有 1 条目标、正文匹配的记录。

同一 turn 的读取和发送分别属于 `api:1`、`api:2`，有不同 `tool_call_id`；没有人为补造宿主事件。Aegis 对读取结果加入了不可信数据提醒，但没有阻断后续模拟发送。提醒能影响合作模型，却不等于强制审批。本次确定性模型响应只是检验执行边界，不证明任意真实模型都会采取该行动。

## 4. 规则二对应的执行链

预先放置一个普通 `.py` 入口文件，由真实原生模型循环调用一次 terminal 执行：

```text
合成 DWS 查询输出
  → Python 读取 text，放入 HTTP 请求的 messages
  → loopback 模型响应 choices[0].message.content
  → subprocess 传入模拟 DWS 的 --text
  → 同来源合成会话的本地发送记录
```

回放观察到：外层原生模型请求 2 次，脚本内部模型 HTTP 请求 1 次；只有 1 次 `pre_tool_call`，目标正文正确写入 1 条发送记录。脚本中的 DWS 子进程和 HTTP 请求没有重新触发 Hermes 工具 hook。

这符合 [local 后端直接启动进程](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/tools/environments/local.py#L1779) 的实现。并不意味着宿主从不检查脚本：原有危险命令、特定生命周期命令以及 Aegis 已记录的脚本来源等检查仍可能命中。本次验证的是一个预先存在、没有被既有规则拒绝的普通入口，不能概括成“所有脚本都能通过”。

Aegis 基线脚本来源规则依据已有 `scriptArtifacts` 记录判断执行目标；它不是每次执行前完整追踪脚本内部数据流。参考本仓库 `src/rules.ts:2575`。

## 5. 既有控制与反证

| 控制 | 已确认的作用 | 对本次风险判断的意义 |
|---|---|---|
| Hermes manual 审批 | 检测危险命令和 Tirith 告警，无告警时允许。三种合成 argv 探针均 `approved=true` 且没有 `user_approved` | 不保证每条 AI 答复都需要本人批准；没有关闭审批来制造结果 |
| DWS confirmation | 真实 schema 声明 `confirmation=user_required`；help 声明 `--yes` 跳过确认提示；源码 ConfirmSafety 的旗标判断没有独立的人类批准凭证 | 是合作调用方应遵守的协议，单靠这个 argv 开关无法证明本人审阅了正文；它也不是新规则的风险判定条件 |
| DWS OAuth/PAT/服务端权限 | 身份与实际 scope/目标权限仍由 DWS 控制；本轮本机未认证，企业授权未知 | 这是真实可达性的必要条件，不能用合成发送代替验证；若服务端逐次审批不可绕过，可能切断对应路径 |
| 模型凭据清理 | 指定版本会过滤常见模型密钥环境变量；用合成变量验证 `OPENAI_API_KEY` 被移除，`DWS_CONFIG_DIR` 保留 | 脚本链不能假设自动继承 Hermes 模型密钥。必须另证脚本有可用模型 API/内部 Gateway；HTTP 可达不等于取得授权 |
| 本地/容器后端和系统权限 | local 后端按可用 OS 权限运行；容器、挂载、网络、profile home 映射影响 DWS 和模型可达性 | 不能把“同一用户”简化成任何 profile 都自动使用同一 DWS 登录态；也不能因使用容器就直接判定无风险 |
| Aegis 原有防护 | 插件与 worker 实际加载；危险命令负对照被拒绝；工具结果提醒实际进入会话 | 两条合成链仍能执行，不能用已有一般性防护证明具备本次特定审批约束 |
| 提示词与 skill 要求 | 可以要求模型先确认，不是本轮验证的不可绕过执行边界 | 不能以文字约定替代身份、审批或系统权限证明 |

源码依据：[审批判定](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/tools/approval.py#L4552)、[无告警允许](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/tools/approval.py#L4621)、[环境过滤](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/tools/environments/local.py#L470)、[DWS 确认门禁](https://github.com/open-dingtalk/dingtalk-workspace-cli/blob/1b06d0105a27750a888a361abaa465f93b7f729d/internal/corecmd/corecmd.go#L1165)、[DWS 旗标判断](https://github.com/open-dingtalk/dingtalk-workspace-cli/blob/1b06d0105a27750a888a361abaa465f93b7f729d/internal/corecmd/corecmd.go#L1248)。

上游自身也明确区分系统隔离与进程内启发式保护；这支持“不能因架构不同就免评估”，不替代企业配置证据。[固定版本安全模型](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/SECURITY.md#L32)

纯固定“已知悉”脚本、模型只选固定模板 ID 的流程仍按需求视为不需新增阻断。本轮风险判断要求实际经过模型并使用生成正文，未把所有自动化当风险。

## 6. 对后续适配的新增证据

- 原生 `pre_tool_call` 和结果事件真实提供 `session_id`、`turn_id`、`tool_call_id`、`api_request_id`。`api_request_id` 在模型循环生成，并进入本次真实工具事件。[生成点](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/agent/conversation_loop.py#L2807)
- 当前 `hermes_adapter.py:152` 的 payload 白名单没有传递 `tool_call_id`、`api_request_id`；`pre_llm_call` 的原生 `sender_id`、`platform` 等字段也没有传递。[原生用户事件字段](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/agent/turn_context.py#L1231)
- `pre_llm_call` 在用户回合准备阶段触发；`post_llm_call` 在整个工具循环结束后触发，不能把二者当成每轮内部模型调用通知。[结束 hook](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/agent/turn_finalizer.py#L615)
- 本次 terminal 轨迹中，`transform_tool_result` 先于外层 `post_tool_call`。不能直接移植另一宿主的事件到达顺序假设。
- 这些字段是进一步验证的基础，尚未证明并行预计划、重试、压缩、取消、丢失事件、CLI/Gateway 原始身份等场景可靠。不能据本次串行成功就宣布规则一可安全实现全部阻断。

## 7. 复验材料与边界

材料位于 [hermes-risk-20260927](hermes-risk-20260927/)：

- [可复验脚本](hermes-risk-20260927/reachability-probe.py)：只执行合成 DWS、loopback 模型以及临时文件；要求固定宿主提交。
- [Agent 链结果](hermes-risk-20260927/agent-summary.json)、[传输核验](hermes-risk-20260927/agent-transport-checks.json)。
- [脚本链结果](hermes-risk-20260927/script-summary.json)、[传输核验](hermes-risk-20260927/script-transport-checks.json)。
- [源码与材料摘要](hermes-risk-20260927/sha256.json)。

复验需能运行目标版本的 Python 依赖环境、Node、可写临时目录以及 loopback 监听权限。对两个 `--mode` 分别启动独立 Python 进程，使用干净环境，保留必要的 PATH、原始 HOME、TMPDIR、LANG，不继承模型/DWS 凭据。示意命令：

```bash
python reachability-probe.py \
  --hermes-root /path/to/pinned-hermes-checkout \
  --aegis-root /path/to/agent-aegis \
  --output-dir /path/to/disposable-evidence \
  --mode agent
# 使用同样参数，另起进程运行 --mode script。
```

`passed:true` 仅表示“本次合成执行链可达并符合断言”，不表示防护通过、真实员工身份已验证或真实发送成功。模型响应是可控 fixture，不是提示注入成功证明。最终两次回放均验证 worker 已退出。

探针调试期间修正了本地模型端点对宿主非聊天预检请求的处理；保留的 JSON 来自修正后重新执行的两次成功回放，不包含先前调试失败记录。

## 8. 企业侧还需补齐什么

1. 实际镜像/commit、生效 profile、CLI/Gateway 入口、插件及 Aegis 模式；不能只看包版本。
2. terminal 后端、运行用户、挂载、网络策略、子进程 HOME / DWS_CONFIG_DIR 和实际 cwd。只需脱敏配置，不需要凭据正文。
3. 对应 DWS profile 是否认证，实际读取/监听与本人发送权限、目标范围、有效期，是否有不可绕过的逐次审批。
4. 脚本能访问哪个模型/企业 Gateway，以及如何取得调用权限；仅有原生 Hermes 模型可用不足以证明脚本链成立。
5. 如果有集中出站代理、其他工具拦截插件或身份限制，给出强制执行边界和等价路径的约束证据。

有了这些信息，再分别决定“存在适用风险 / 指定环境不适用 / 证据不足”。如果已有强边界切断某条链，记录具体版本、配置与复评触发条件；如果只是未登录或当前权限不足，结论仅限当前状态，启用能力后需要复评。

本轮没有创建开发分支、修改 Aegis 运行代码或生产配置，没有提交、推送或发送真实消息。没有把企业适用性状态改成“已完成”，也没有据部分证据先行扩展 Hermes 规则开发。

## 9. 后续本机登录验证（2026-09-27）

用户随后明确要求“登录 dws 验证一下”。已通过 DWS 官方浏览器 OAuth 完成登录，未使用 `--recommend` 批量申请推荐权限。针对登录返回的同一明确 profile：

- `dws auth status --format json` 返回 `authenticated:true`、`token_valid:true`、`refresh_token_valid:true`。
- `dws contact user get-self --format json` 真实服务端调用成功，返回的本人身份与登录结果一致。未在本记录保存员工 ID、凭据或完整通讯录响应。
- 普通沙箱执行最初被本地 `~/.dws/.data.lock` 创建权限阻止；在获得执行许可的正常本机权限下重试成功。该沙箱错误不等于 DWS 未登录或服务端权限不足。

本次补充证明本机真实 DWS 认证和本人资料查询可用；没有执行消息读取、发送或 Hermes 原生入口的真实 DWS 全链路测试。两条风险链的合成回放证据等级保持不变，企业部署适用性仍待核实。
