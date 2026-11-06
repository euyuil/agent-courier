# 一次合成格式化权限往返

日期：2026-11-06。操作者已明确批准下述一次合成调用，真实观察已通过；该单次批准额度已使用。桌面 WorkBuddy 5.6.2，正常运行注册确认 CLI 2.147.0。此局部观察不构成完整人工能力或真实服务准入。

## 本次明确批准的准确范围

只在本次自有独占测试 Harness 会话执行一个合成 Run，请求纯 MCP 工具 mcp__courier_formatter__courier_format_message 一次，参数为 kind=final 和本次生成的 CourierFormatterPermission 合成标记。该工具只返回经过结构校验的文本数据，不发送消息、读写文件、读取环境、访问网络或执行命令。实现见 src/adapters/workbuddy-experimental/formatter.ts 与 formatter-server.ts。

实验仅向准确匹配该调用的原权限请求提交一次 allow-once 对应决定。它不修改权限模式或持久规则，不批准其他工具，也不发送钉钉消息。若没有原权限请求、只提供持续授权、实际工具或参数不匹配，则不批准，不把原 Run 换成新任务。授权只限这个独立实验，不开放普通真实 serve，也不作为后续调用的批准。

本入口需要明确批准的原因来自 AGENTS.md 的会话与事件语义："不得为了让流程继续而自动批准 Harness 的权限请求。" 现有允许使用已登录 WorkBuddy 的范围不被解释为该次工具批准。

## 显式入口与约束

每次必须有相应明确授权才可执行以下互斥模式，仍须提供新的 Git 外私有输出：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-automatic-managed-approve-one-formatter
```

直接调用 managedOutputExperiment 的 approved-formatter 场景时，也必须传入明确的 operatorDecision=approve-one-synthetic-formatter-call；缺少决定时，连状态目录、Harness、订阅和任务都不创建。其他既有模式仍不批准执行权限。

生产连接工厂继续核对实际 A 的 default 模式。实验再独立核对原 Run 的原生 tool_call 及 toolArgumentsComplete、标准请求与 interruption 广播的一致性、准确参数、唯一 allow-once 选项和完整人工请求。两个通道异步到达时先等待，不用第一个不完整请求立即批准。

发出决定前再次核对原请求仍待答、Run 未结束及观察期限。传输包装器在调用原网络方法之前拒绝错误参数、allowAll、错误请求、第二次决定及越界调用；最多向原准确工具发送一次 allow。未知回执不重试、不换通道；授权请求或工具原文不进入公开报告。

通过条件须同时包含明确的原始 resolved=true/queued=false、归一化原答案接收、原工具完成及结果回显、原消息完整正文，以及独立原生 prompt end_turn。只收到权限决定或出现最终文字不能通过。观察限 90 秒、2048 帧/事件及 8 MiB 原始帧；异常、冲突、取消、额外请求/工具或截断保持 unverified。

executionPermissionApprovals 记录实际向传输层派发的批准次数；permissionDecisionsSubmitted 单独记录向适配器提交的决定，二者都不是默认的服务器接收证明。原始接收与本地事件分别检查。

## 实际观察及修复依据

最初三份观察没有派发任何批准，均保留 unverified。不是权限决定未知后的重发：三份公开摘要分别明确记录 executionPermissionApprovals=0；每次新观察前还读取全部本次私有结果，只有原额度可证明未使用才继续。最终一次批准后不再运行批准入口。

| 样本 | 原始帧 | 批准派发数 | 结果 |
| --- | --- | --- | --- |
| 首份 | 未登记 | 0 | 匹配未通过；早期入口尚无完整脱敏诊断 |
| 第二份 | 159 | 0 | 诊断完整，仍停在原权限匹配 |
| 第三份 | 99 | 0 | 请求与工具均匹配，仍因增量参数检查未通过 |
| 最终样本 | 153 | 1 | observed，所有通过条件成立 |

只读核对已安装 CLI 代码及真实脱敏诊断后，修复了探测器的三个协议解释错误；生产适配器和真实服务准入没有因此放宽：

- interruption 广播可不包含 Run 元数据。只有原 Run 的已核实工具 ID、准确工具名和完整参数均匹配时，才可关联到原请求；显式冲突字段仍拒绝。
- 标准 session/request_permission 顶层 _meta 中的 codebuddy.ai/requestId 是此 Harness 权限请求自身生成的独立 UUID，不是运行任务 Run 的标识，也不是 JSON-RPC 的 id。仅在此具体消息类型按其实际语义保留；其他明确 Run 字段、工具身份及正文仍须一致，不用该 UUID 证明 Run 归属。
- 原生参数先以空对象和合法 kind/text 前缀增量发送，最终 tool_call 才带 toolArgumentsComplete=true。早期片段不能批准；准确完整标记必须出现。错误前缀、未知字段、冲突类型和完整后降级/变化仍拒绝。

最终样本使用普通 workBuddyManagedOptions、ManagedWorkBuddy、生产连接工厂与原 answer 接口：一个归一化 Harness 权限请求、两个一致的原生请求通道，原工具完整参数已明确标记完成。只向该原工具派发一次 allow；原始 _codebuddy.ai/resolveInterruption 返回 resolved=true、queued=false，归一化 input.accepted 对齐原操作和输入。

原格式化工具随后 completed，原生结果和归一化完整 final 正文均与合成输入一致；原 Run 独立 prompt 返回 end_turn。153 帧完整、未超时或截断，无额外请求、无越界决定。所有原始决定、接收、工具结果、消息正文与原 Run 完成检查均为 true，decisionScopeViolation=false。钉钉发送数为 0，未使用 allowAll 或改变持久规则。

## 离线验证与剩余范围

六项新增回归覆盖：默认缺授权零操作；精确合成原请求及一次范围；全部来源和原任务终态；异步双通道；撤销/外来/unknown 不重试和变化结果不通过；错误/持续/重复决定在传输前拦截。异步到达回归曾先失败，再补齐等待及派发前重读。CLI 的显式启用、与其他入口互斥和私有配置检查也已扩展。

上述准备阶段完整套件为 307 项通过。后续六项协议回归补齐无 Run 广播、独立权限相关标识、合法参数增量、原生参数完成标记、脱敏诊断及完整元数据组合；三类匹配错误均先由失败回归复现再修复。最终完整套件 313 项通过、0 失败/跳过，应用行覆盖 4373/5074（86.18%）；build、typecheck、build:test 和完整覆盖检查通过。相关定向 18 项通过。

本次只补充一次准确合成工具的执行权限批准往返。第二条补充的语义效果、完整输出/恢复、真实 Courier 应用和钉钉链路仍须分别完成，三项必需能力硬门槛不变，整项任务仍 66/80。FR-003/FR-009 保留原文；未读 .env、未发钉钉消息、未提交或推送。本次一次批准授权已使用，不自动批准后续格式化或执行请求。

最终脱敏复核未发现机器特有内容或失效相对链接；diff 空白检查通过。四份本次私有结果均为 0600、父目录为 0700，批准总派发数核对为 1。自有实验目录和相关进程均已清理为 0；.env 仅核对权限及 Git 忽略状态，未读取内容。需求清单仍只读保持 16/16，无扩展钩子。
