# 显式 MCP 格式化输出来源

日期：2026-11-06。目标为桌面 WorkBuddy 5.6.2 / 内嵌 CLI 2.147.0。
本次实现并独立观察了一个新的输出来源：Harness 调用纯格式化 MCP 工具，Courier 从原始 ACP 工具事件归一化完整消息。
Harness 会话、输入、steer 和 Run 终态仍由 ACP 承载；MCP 不承担完整聊天协议，也不在 Courier 中增加 Agent loop 或模型调用。
这是未准入的显式模式，不改变真实服务门槛。

## 排除的 HTTP 结果路径

官方 [HTTP API](https://www.codebuddy.cn/docs/cli/http-api)提供独立的 Runs 入口；本机 Gateway 桥静态实现会等待原 Harness 会话空闲，再将权限模式设为 BypassPermissions。
该执行路径不符合本功能的及时 steer 和显式权限边界，本次没有调用它发起任务。

另对本次已归属的本机进程，在两轮自有任务完成后各作两次 `/internal/agent` 结果读取；请求没有 prompt。
四次结果均只有一行，所带 Harness 会话标识与原目标不符，全部按 identity_mismatch 拒绝，没有将它们借用为原 Run 输出。
静态结果视图还会新建 result.uuid，并从历史选择最后一条 completed assistant；不能将这个新 uuid 或最后一条历史当作可靠原消息身份。

## 纯格式化工具与显式配置

`formatter-server.ts` 提供 stdio MCP 服务，只有初始化、ping、列工具和调用格式化工具，不读取环境、配置或文件，不访问网络，也不直接发消息或决定权限。
`courier_format_message` 严格接收 kind=progress/final 与 text，返回带 schemaVersion=1 的同一份结构化数据；参数不能携带原 Harness 会话、Run 或权限决定。
工具的只读、幂等、非破坏及闭合范围注解描述这项纯计算；实际是否允许运行仍由 Harness 的原权限策略决定。
协议依据为 [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) 和 [初始化生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)。

适配器程序接口新增 `formatterLaunch={executable,entrypoint}`：创建和恢复 Harness 会话时均传入同一 MCP 描述，来源明确为 custom，工具不延迟展示，不写 allow 规则、不设置权限模式。
默认 mcpServers 仍为空；单独配置生产者也不自动切换输出来源。
只有额外选择 `typedFormatterOutput=true` 才启用归一化；没有显式生产者时拒绝该组合。
这些参数还没有接入日常 CLI/私有配置契约，不能通过修改配置布尔值开放真实服务。

服务实现按行处理 JSON-RPC，支持 UTF-8 跨块输入，单行上限 1 MiB，错误和不完整 EOF 不回显原始内容；stdout 只有协议响应。
没有采用 MCP 传输请求 ID 或由模型填写的身份字段作为消息身份。

## 输出归一化

`FormatterOutput` 仅处理精确工具名及原 Run 已关联的原生 toolCallId。
类型来自显式 kind，正文来自 completed 后经过严格解码且与原参数相同的结果回显；不从普通回答、reasoning 或文本内容猜测分类。
本版本实际 rawOutput 是含 text 的对象；解码支持直接 payload JSON，以及单元素 MCP 文本数组中的 payload JSON，拒绝多候选、未知字段或错误结果。

首次可核实类型时登记逻辑顺序，部分参数不产生正文片段；原工具完成后才输出一次完整快照。
Courier 消息身份包含原生工具调用 ID，快照片段键也由该身份派生；两个不同调用的相同正文分别保留，同一完成快照重投不重复创建消息。
失败、结果不匹配或缺少完成事实时关闭尚未完成的空消息位置并报告 output_unsupported；已完成内容发生冲突时保留原记录并停止后续类型输出；完成后又出现 failed/cancelled 也必须报告矛盾，不能被重复事件分支忽略。
final 消息只完成自身；Run 仍须等待原 session/prompt 的权威终态。
问题、权限请求和控制事件保持原处理路径。

格式化工具的拥有者延续复用已核实的 steer 注入关系，并额外要求 messageRequestId 匹配原 Run；仅有当前活动任务、控制接收回执或新原生 requestId 不足以接纳。
同帧 requestId/conversationRequestId 矛盾时不能建立工具归属，成员/历史/外来 Harness 会话及未核实拥有者仍被隔离；无 Run 字段的完成更新也必须匹配此前已核实的原工具。

## 真实独立样本

早期恢复后样本仅观察到两次 ToolSearch，没有格式化调用，typedToolRoundtripObserved=false，保留未通过结果。
随后明确 custom/非延迟配置并在初始连接观察到两次格式化往返；该实验插在基础探测两轮之间，使基础探测的“总工具数为零”条件不成立，contextRoundtripObserved=false 保留，不作为完整基础流程通过。
再于 session/load 明确提供同一配置后也观察到两次往返；不能将早期失败单独归因为配置丢失，配置和实验阶段均有变化。

初次临时结果采集器没有解开嵌套文本数组，resultEchoMatched=false 保留。
仓库实现依据实际结构解码，并使用编译后的 Node 服务另作独立复现，结果回显匹配；没有把旧结果改成通过。

最终三条输出样本使用仓库编译服务、生产适配器的创建/恢复配置与 typed 归一化；临时驱动只在新 Run 前显式选择模式并发起合成任务。
基础两轮的独立创建/恢复及上下文标记检查成立，再在同一原 Harness 会话追加一轮类型输出任务：

| 检查 | 结果 |
| --- | --- |
| 原生工具调用 | 两次相同正文的 progress，再一次 final；三个不同 toolCallId |
| 原 Run 关联 | 三个调用均匹配本轮原始 Run |
| 完成与回显 | 三个 completed；kind/text 与结果回显均精确匹配 |
| 归一化逻辑消息 | progress、progress、final，共三条，身份均匹配原生工具调用 |
| 正文 | 三条合成正文均匹配；两个相同 progress 均保留 |
| 普通未分类文本 | 没有归一为 message |
| final 与 Run 终态 | final 消息先完成，随后原 Run completed/end_turn |
| 权限请求与决定 | 此样本请求数 0，批准数 0；未改权限设置 |
| 记录完整性 | 本轮 218 个原始 ACP 帧，未截断 |

基础流程记录 new=2、load=1、prompt=2；另追加一次类型任务 start，所以该样本实际共有三次 prompt。
前一组两消息编译实现样本也观察到 progress/final 两条、完整回显、原生身份匹配及零普通 message。
这些是独立 Harness 观察，没有发送钉钉消息，也没有证明平台三条投递、完整 Courier 重启或全部运行状态。

## 正式探测入口与受控 steer 负面样本

新增 `--acp-bootstrap-owned-formatter`，通过仓库代码正常选择第三个 typed 适配器并 load 原 Harness 会话，不再依赖临时修改适配器对象。
正式流程的基础两轮创建/恢复/上下文检查通过，类型轮观察到三个原生格式化调用及三个 completed；归一化 progress、progress、final 的身份、正文、单快照与顺序均匹配，final 先于原 Run end_turn。
本轮 283 个原始帧，记录完整；new=2、load=2、prompt=3，没有额外工具或人工请求，执行权限批准数为零。正式探测不自动提升任何能力证据。
探测采集有界，并独立观察原 session/prompt 响应；错归属、冲突字段、工具名变化、结果不匹配、人工请求、连接丢失及未知接收均不能获得通过，也不重试。

另用 Git 外驱动单独执行八条 progress 后一条 final，并在原提交仍未返回时连续提交两条不同补充；这与三消息正式探测是不同实验，不能共用通过条件。
两次样本均收到原 Run 的两条接收与 applied 回执，但七个后续原生工具调用没有所需的原输入归属，适配器只归一化前两条 progress，后续保持隔离并报告输出限制。
最新字段观察共 798 帧，九个格式化工具均 completed，后续七个为已知延续拥有者；messageRequestId 既不匹配原 Run，也不匹配本次两个补充输入标识。原 Run 最终 end_turn，但原生 final 未包含两条补充标记，不能报告该实验的补充生效或类型桥接通过。
没有人工请求、权限批准或钉钉发送；最终结果 unverified，不按活动 Run 或工具正文猜测归属。
较早私有采集器会被后续仅含状态的 completed 更新覆盖结果标记，故该次“原生 final 无标记”不单独作为正文证据；新采集器保留已有合法结果并另作独立观察，没有改写旧报告。

## 未准入范围与后续工作

- Agent 目前需要明确使用格式化工具；还没有完成面向任意普通输入的正常 Harness 配置与日常 CLI 接入。
- 正式仓库三消息探测入口已实现并独立复现；日常配置和证据指纹仍待完成，受控 steer 字段观察仍是 Git 外实验。
- steer 产生的厂商拥有者延续、历史重放/交叠、真实 Courier 重启、全部人工/权限及异常分支仍需适配和验证。
- 只用原始未扩展 ACP 文本的模式仍缺少明确分类；不能将新来源的证据套给它。
- typedVisibleOutput、messageAssembly、humanInteraction 仍由代码强制保留 unverified；T031/T069 等任务不因本次局部结果而勾选，真实 serve 继续关闭。

新增十三项离线回归覆盖纯格式化、严格协议/结果结构、stdio 边界、创建/恢复配置、显式生产者约束、同文不同调用、重复完成、初始逻辑顺序、部分参数、错误/冲突、内部内容隔离及 final/Run 分离。
随后新增六项正式探测回归及两项生产归属回归，覆盖错 Harness 会话/Run/成员、独立终态、缺失/重复/冲突消息、字段及工具名矛盾、人工请求和 unknown 不重试，以及已核实 steer 延续与原输入同时成立的条件。
最新完整离线套件 181 项通过、0 失败，build/typecheck 通过；编译后应用非空/非注释行覆盖 3396/3930（86.41%）。
