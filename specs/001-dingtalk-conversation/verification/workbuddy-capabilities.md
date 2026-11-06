# WorkBuddy 能力实验：阶段性结果

日期：2026-11-05；后续记录更新至 2026-11-06。产品：Linux 桌面 WorkBuddy 5.6.2；后续自有运行进程的正常注册元数据已独立确认 CLI 2.147.0，早期 ACP 握手缺失版本的记录保留。
环境：安装包静态检查、临时回环桌面诊断、正常账户 API、独立空目录中的合成文本任务。

2026-11-06 补充：显式初始化自有启动 Harness 会话后，同一 ACP 连接再次新建取得不同标识；生产适配器执行、正常断连/load 和原上下文恢复均已独立复现。早期首次新建被冲突保护拦截的样本保留，但不能扩大为不存在独立 ACP 执行路径；见本文末尾及[接口补充调查](interface-research-2026-11-06.md)。
同日另修复问题能力握手；原始 ACP 单选题、一次答案明确接收和原 Run 输出所选标签已由显式入口独立复现。完整权限与恢复链路仍缺证。
后续原始 ACP 拒绝实验已观察一次 deny 明确接收及原 Run cancelled；未观察到工具取消标记，不编造。生产 cancelled 待答撤销已修复；见本文末尾和[拒绝记录](permission-denial-2026-11-06.md)。
普通 Hook 已另行观察原 Run、Stop 完整正文和 completed 的 FinalStop；转录在 Stop 时可能尚未持久化本轮回答，分类与片段仍缺证，见 [Hook 调查](hook-output-2026-11-06.md)。

| 项目 | 实际结果 | 准入含义 |
| --- | --- | --- |
| 安装版本及桌面身份 | 随包元数据及正常桌面接口报告 5.6.2 | 不作为跨版本兼容性保证 |
| 正常账户查询 | 正确的正常调用入口为桌面提供的账户 API；本轮已观察 authenticated=true | 取代首次实验中“调用未跑通”的状态；没有查询令牌或复制账户详情 |
| 可复现实验入口 | probe:workbuddy 显式启用，配置正常可执行文件；临时虚拟显示及随机回环诊断连接 | 仍是实验手段，不是已支持的生产发现/激活流程 |
| 独立 Harness 会话 | 正常创建接口返回独立 Harness 会话，cwd 与新建的私有空目录相符 | 仅观察一个独立目录，未覆盖两用户和并发隔离 |
| 合成文本任务 | 向该 Harness 会话提交“不要调用工具或读写文件，只回复合成文本”的输入；正常 prompt 返回，isProcessing=false | 一次直接 Harness 实验，没有经过 Courier 或钉钉链路 |
| 输出与终态 | 初次 6 个、问题实验前置任务 2 个、恢复实验前置任务 25 个可见片段均有 codebuddy.ai/messageId；存在显式 stopReason | 不把片段数当逻辑消息数；未把流关闭或文本当完成，尚未完整核实所有失败终态 |
| 输出分类 | 上述样本的 progress/final 分类字段观察数均为 0 | 不能据此断言所有厂商接口永远不支持，但当前适配器没有可靠分类映射，仍为 unverified |
| 原生问题往返 | --question 创建合成单选问题，经正常 session:answerQuestion 提交选中项，后续输出包含该项；end_turn 且 isProcessing=false | 未调用可执行工具的批准 API；没有证明 Courier 的原始 ACP 答复链路、执行权限往返或恢复 |
| 原 Harness 会话恢复 | --resume 在正常终态后释放自身运行后端，再加载同一 Harness 会话；不重复合成标记也能复述；正常结束且未观察工具调用 | 是同一桌面进程内的原 Harness 会话加载，不是 Courier 进程重启验收，也不证明跨客户端写入权交接 |
| 结束清理 | 本轮自有临时桌面进程组已关闭；核实对应 WorkBuddy 可执行进程计数为零 | 原始诊断日志和运行端点未进入 Git |

账户查询及最小任务最初用临时诊断脚本跑通，随后由仓库内的
`tests/probes/workbuddy-capabilities.ts` 复现上述观察。退出 0 表示探测完成，不代表 G-H 已通过。
启动时曾遇到 renderer/daemon 尚未就绪；工具只重试无副作用的 target 发现和账户查询，不重试任务创建/执行。
前置任务或恢复结果不明时，不继续提交问题实验。

没有使用 token 查询接口、提取进程环境/内存凭据、读取个人文件或把其他 Harness 会话历史复制到仓库。
运行端点、安装路径、账户字段、Harness 会话 ID 和原始日志均不进入共享记录。

G-H、G-H-INTERACTION、G-H-OUTPUT 仍为 blocked/unverified，T031 未完成。
Courier 重启后的原 Harness 会话续接、跨客户端写入权交接、完整运行状态与输入形态覆盖、
原始 ACP/Courier 问题与执行权限完整往返、独立逻辑消息/稳定片段身份及权威核实仍需验证并补齐映射。
未准入适配器代码可编写并做离线契约测试，但不能用这些观察启用真实服务。

## 生产映射与内部 interruption 的独立实测

两个新的独立合成问题分别经 `--question` 和 `--question-interruption` 完成：

- 问题的标准权限请求和 interruption 广播实际都被观察到，`mappedSourceCount=2`；生产 `interaction` 与 `mergeInteraction` 将其合并为一个原问题。
- 问题所用工具在原 Harness 会话历史中只有一个原 Run 归属；生产 `prepareInteractionAnswer` 生成了有效答复字段，未根据最近一次聊天猜测原请求。
- `--question` 经正常 `session:answerQuestion`；`--question-interruption` 经正常 `session:resolveInterruption`，仅向原生 AskUserQuestion 提交明确的合成选项答案，未批准其他工具。
- 两次都观察到答复确认、选中项输出、正常终态及空闲状态；内部 interruption 实验还观察到 `noOtherToolsObserved=true`。可执行工具批准次数均为 0。

这些实验直接复用了生产问题解析与答复字段转换，但传输仍通过正常桌面 API；
没有证明 Courier 原始 ACP 连接的 RPC receipt、执行权限批准/拒绝、断连恢复或真实钉钉往返。
桌面 API 返回的是布尔确认，不能补造成原始 RPC 的 resolved/queued 明细；G-H-INTERACTION 仍为 unverified。
安装包中存在 native result / next_step_final_output 结构，但尚未证明它们会携带所需分类及稳定标识经桌面 ACP 输出，不能据此补齐输出分类。

## 原始 ACP 接入与写入权冲突

`--acp-process-surface` 在本次独立合成任务正常结束后，只依据该测试运行进程的目录或显式原 Harness 会话参数、厂商入口和监听 socket 归属识别回环地址。
该入口不读取进程环境或内存，不打印进程参数、运行端点和 Harness 会话标识。
协议预检只建立并关闭自己的 ACP 订阅，不提交 Agent 输入；不以公开 REST 元数据是否可读推导 ACP 是否可用。

实际生产 `AcpConnection` 与 `WorkBuddyAdapter` 已完成 HTTP 200、SSE 订阅和 initialize。
加载原测试 Harness 会话明确被拒绝，错误为 `writer_occupied`；没有换建 Harness 会话或再次提交任务。
这证明当前原始适配器可连接该实验目标且保留写入权冲突，尚未证明正常交接、ACP 执行或及时 steer。
初始化结果没有独立确认 CLI 版本，保持 unknown；未补造版本或准入证据。
新增三项离线探测测试通过，覆盖原会话日志匹配、进程/监听归属约束及仅订阅不提交 Agent 命令。

`--acp-handoff` 随后在新的独立测试中复现相同写入权冲突，再经正常桌面 session:requestYield 调用请求释放本次空闲原 Harness 会话。
该调用明确返回 false，因此没有第二次 load，也没有新建替代 Harness 会话。不能把方法存在或调用完成当作成功交接。
新增离线用例还验证外来原会话、非空闲状态和外来快照不会触发 yield；未知结果不重放。

## 执行权限拒绝的未完成观察

`--permission-denial` 只将本次新建的 Harness 会话配置为 default 权限模式，不修改全局设置。
它要求一个仅打印随机合成标记的 Python 命令，通过生产请求解析器关联原工具/Run，
仅在完整命令及明确拒绝选项均匹配时调用正常 session:resolveInterruption 的 deny；没有批准分支或通道回退。

首轮在工具检查处停止；探测已修正为允许工具开始帧暂时缺少完整参数，完整权限请求仍须逐字匹配。
随后的一个任务正常结束但没有匹配人工权限请求；最后一次直接要求调用工具的独立任务也正常结束，
观察到 2 个 tool_call 帧，其中 1 个携带完整匹配命令，但仍未观察到匹配人工权限请求。
这些是帧数，不当作两次实际命令执行；本轮 Courier 的可执行工具批准次数始终为 0。
没有实际提交拒绝，不能把无权限请求的正常终态记为批准/拒绝往返通过。
执行权限、原始 ACP/Courier 人工输入链路和恢复仍为 unverified。

## 运行中原子 steer 的独立观察

新增 `--steer-running`，复用生产 `AcpConnection` 和 `WorkBuddySteering`。
每次先完成基础文本任务，再由正常桌面入口提交一个无工具的合成目标任务；下表的提交/控制计数仅针对后者。
桌面保持原 Harness 会话写入权，独立 ACP 连接只 initialize 并提交一次 session/steer，不 new/load/prompt，也不调用队列或取消接口。
本轮没有批准可执行工具或发送钉钉聊天消息。

| 实验阶段 | 观察结果 | 含义 |
| --- | --- | --- |
| 普通桌面输入 | ACP 用户回显包含包装后的完整原输入；一次 steer 接收并出现匹配原操作、原输入和原 Run 的注入回执；后续输出使用不同 conversationRequestId | 桌面简化历史与原始广播不同；接收和注入不能单独证明原 Run 内容生效 |
| 预分配标识、尚未核实模型活动 | 正常桌面发送接口接受 codebuddy.ai/conversationRequestId；实际原始 ACP 输出使用该标识；控制请求曾返回归一化的 stale_run | 仅用户回显及桌面 isProcessing 不足以作为控制提交的执行中依据；明确拒绝没有重试 |
| 预分配标识且已观察模型活动 | 一次目标任务提交、一次 steer、零 load、零原始 prompt；接收确认 24 ms；匹配注入回执来自原始 ACP，观察时仍在运行；正常终态且未观察工具调用 | 后续原始 ACP 和桌面输出的 conversationRequestId 均与原 Run 不同，原 Run 内的替换内容检查没有通过 |

最终入口要求预分配标识对应的实际模型/工具事件；不会根据最近一条消息猜测 Run，内部思考只用于读取控制标识，不输出其正文。
输出检查按厂商消息 ID 分组，原始 ACP 和桌面历史分别记录；诊断仅输出匹配布尔值、计数、已知字段名和类型。
代表性接收耗时不是平台或应用 SLA。一次接收不证明两条补充输入、等待人工输入时的行为、恢复或 Courier/钉钉整条链路。

安装包中，注入流程缓存旧 ownerRequestId 用于 drain，并在模型输入和历史更新后广播原操作元数据；后续输出仍有各自的追踪标识。
该阶段只有静态路径，不足以建立可核实的跨标识延续映射；之后的实际轨迹和受限映射见下文。
`originalRunContinuationObserved` 检查要求原提交内内容、注入及终态均满足，未自动写入 passed 证据。
T031/T033 与 G-H 继续保持未完成/未准入，等待输入、权限和输出门槛也未因此得到豁免。

## 候选关联字段的当前边界

安装包静态路径在拥有者的输出转发中可写入 codebuddy.ai/promptRequestId，另有 unsolicitedTurn 的 background_drain 控制信号。
新的独立实验同时传入预分配 conversationRequestId 和正常发送接口支持的请求追踪元数据，再等待匹配模型活动后提交一次 steer。
接收与注入仍被观察到；后续原始 ACP 与桌面输出的 conversationRequestId 继续不同。
两条观察路径均未找到匹配原提交标识的 promptRequestId，promptLinkedFrames=0；已核对的末尾输出帧未提供该字段，也没有观察到 unsolicitedTurn/background_drain 帧。
缺少后台信号不能证明仍属原 Run；静态存在的字段没有补成实际关联证据，originalRunContinuationObserved 仍为 false。

当前安装包中的 agentPhaseInfo 描述 preparing、model_requesting、model_streaming、model_done、工具/人工等待和 idle 等执行阶段；
progress 控制消息也未提供各逻辑文本对应的类型与结束契约。这些候选字段不构成 progress/final 文本分类或稳定片段身份。
该阶段仍缺少原 Run 延续关系；后续已补齐的受限关系见下文。正常发现/写入权交接及输出契约仍不能由填写配置或重复发送合成消息补齐。

## 原提交与厂商运行标识的受限延续映射

同日增加仅含本次实验内临时别名的完整观察轨迹。首次轨迹 202 行、未截断；原始 ACP 注入回执同时带旧 conversationRequestId、新 requestId、原输入 messageRequestId 和原操作元数据。
后续文本的 conversationRequestId/requestId 指向新标识，messageRequestId 指向原提交；新标识的 session_end 明确 end_turn，随后原正常提交返回显式终态。
这条关系来自实际字段，未从最近会话、缺少后台信号或等待时长猜测归属。

| 事件 | conversationRequestId | requestId | messageRequestId | 其他证据 |
| --- | --- | --- | --- | --- |
| 原提交模型活动 | 原 Run | 原 Run | 原 Run | 仅用于确认正在执行，不保留思考正文 |
| 原操作注入回执 | 原 Run | 新厂商 owner | 原补充输入 | 完整原操作、原输入、原 Run 及 steer 来源匹配 |
| 后续可见文本 | 新厂商 owner | 新厂商 owner | 原 Run | 与补充输入要求一致的合成标记 |
| 原始 ACP 终态 | 无 | 新厂商 owner | 无 | session_end/end_turn；原正常提交也返回 end_turn |

据此增加生产 WorkBuddyRunReferences：只从已验证注入回执登记延续边，后续可见文本还必须携带原 messageRequestId；无证的新标识、错误来源、分叉及跨 Run 迟到内容不会归入当前 Run。
原 Harness Run 标识保持不变，后续 steer 的 expectedRequestId 使用当前厂商 owner；该阶段仅由合成传输验证连续推进和迟到回执不会回退 owner，实际连续两条的后续结果见下文。
这项关联不扩展人工控制映射或重启恢复。

修正后的独立实验复用生产传输、注入解析和运行关联器，轨迹 164 行、未截断。
一次目标任务提交、一次 steer、零 load、零原始 prompt、零工具调用；接收 31 ms，观察到执行中注入，两条路径均取得关联后的修改内容，原提交正常完成且进入空闲。
原始 ACP 的可见输出有 54 帧，未关联帧为 0；桌面历史有 55 帧，其中一帧未关联，未纳入修改内容判断。
探测按每个事件到达时已有的映射记录内容，不在最终检查时回填缺证的旧帧；originalRunContinuationObserved=true。

以上阶段仅证明该版本的一条 running steer 独立合成路径；两条补充输入的后续结果见下文。waiting_input、完整权限往返、输出分类、Courier 重启及钉钉整条链路仍未验证，T031/T033 与各真实能力门槛保持未完成/未准入。
可执行工具批准和钉钉聊天发送均为 0；轨迹不保留原标识、正文、思考、路径或未知元数据，stdout 只输出摘要。

## 连续两条运行中 steer 的独立观察

新增显式选项 `--steer-running-twice`。它复用生产 AcpConnection、WorkBuddySteering 和 WorkBuddyRunReferences，仍由正常桌面入口提交一个无工具目标任务；前置基础任务只确认正常登录与任务终态。
第一条补充要求先输出一个合成标记，再继续生成简短说明；第二条只在第一条已注入、已验证的新厂商 owner 实际输出该标记、原提交仍在执行且没有待处理人工请求时发送。
第二条按当前厂商 owner 校验，保留原 Run 关联，要求输出另一个合成标记。没有满足条件则不派发第二条；结果未知或明确拒绝均不重发、不改成下一轮输入。

2026-11-05，桌面 WorkBuddy 5.6.2 的独立真实样本如下；随包 CLI 版本仍未形成当前可靠读取结果，不补写版本值。

| 检查 | 实际结果 |
| --- | --- |
| 正常账户、独立 Harness 会话和前置任务 | 均已观察；前置任务明确 end_turn |
| 目标任务与控制调用 | 一次正常目标提交、两次原子 steer、零 load、零原始 ACP prompt |
| 第一条接收/消费 | 接收 12 ms；匹配原操作注入回执，观察时原提交仍在执行；后续可见内容包含第一合成标记 |
| 第二条提交依据 | 第一合成标记来自已验证的新厂商 owner；原提交未返回，没有待处理人工请求 |
| 第二条接收/消费 | 接收 255 ms；独立原操作/输入的注入回执，观察时原提交仍在执行；后续内容包含第二合成标记 |
| 输出关联 | 原始 ACP、桌面均有 390 个可见帧；两条路径未关联帧均为 0，两个修改标记均在事件到达时的已验证映射内 |
| 显式终态 | 原始 ACP session_end/end_turn，原正常提交也返回 end_turn；isProcessing=false |
| 安全边界 | 工具调用 0、可执行权限批准 0、钉钉聊天发送 0，无队列/取消/替代 Harness 会话 |
| 完整性 | 脱敏轨迹 1029 行、未截断；bothControlsInOriginalRunObserved=true，protocolConflict=false |

第一条注入后厂商 owner 发生变化；第二条使用该新 owner，第二次注入没有再次改变它。没有假定每次补充必定产生新厂商运行标识，也没有回退到旧标识重试。
12/255 ms 是该样本接收耗时，不是 SLA，也不代替消费证据。
该阶段只补齐 running 状态下连续两条内容生效的独立观察；单条待答期间接收的后续观察见下文。真实 Courier 输入路由/重启、完整权限和输出分类等仍缺证，整项任务和真实服务准入保持不变。

## 待答期间补充与原问题续接

新增显式选项 `--steer-waiting`，仍使用独立合成 Harness 会话。正常桌面入口提交预分配标识的 AskUserQuestion 任务；原问题与其工具、Run、字段和选项经生产解析器确认后，辅助 ACP 连接只提交一次原子 steer。
补充要求保留原问题，答复后在原任务输出中包含指定合成标记；没有把普通补充当作问题答案。
答题前保留约 15 秒的只读观察，再核对原问题及字段仍完全一致，才通过正常桌面 answerQuestion 提交指定合成选项。发生问题变化、其他工具/权限或关联未知时不提交答案，不改走另一通道。

首个样本接收 24 ms，答题前观察中未见注入；提交原问题答案后才观察到注入、正确选项与补充标记，原任务正常完成。
该样本没有取得注入时原正常提交是否仍未返回的直接读数，不能仅从最终文本推定原任务时序通过。其报告中的较严格答题前布尔判断不作为能力失败结论。

规格 SC-009 与 plan 的及时定义是原任务结束前消费并影响后续工作，不要求必须在人工答复前消费，也未规定毫秒 SLA。
后续探测增加注入时的正常状态读取：必须直接观察到原提交仍未返回，或在原问题仍待答且原提交未返回的状态下看到消费；再结合原 Run 内修改内容、原问题答复与显式终态判定。
未改动规格，也未放宽接收确认与实际消费、原任务与新任务的区分。

2026-11-05，桌面 WorkBuddy 5.6.2 的补充样本如下：

| 检查 | 实际结果 |
| --- | --- |
| 原生问题 | 原工具/Run 关联及标准请求、广播两来源合并已确认，mappedSourceCount=2 |
| 待答期间接收 | 一次 steer，接收 67 ms；原问题保持未答，原提交未返回 |
| 答题前观察 | 约 15 秒内未见注入，consumedWhileOriginalQuestionPending=false；这是观察窗口，不是失败超时或 SLA |
| 原问题答复 | 原问题及字段保持一致，正常 answerQuestion 明确返回 true，selectedChoiceObserved=true |
| 注入时原任务 | 注入回执后直接读取 isProcessing=true、原 questionResult 尚未返回；appliedBeforeOriginalTaskReturnObserved=true |
| 后续内容与终态 | 已验证原 Run 关联的可见文本包含补充标记，原选项正确；原正常提交与 ACP 均明确 end_turn，最终空闲 |
| 观察结论 | waitingSteerRoundtripObserved=true；仅代表单条待答期间接收并在原任务结束前生效的独立路径 |
| 边界与完整性 | 零 load/原始 ACP prompt、零可执行权限批准、零其他工具、零钉钉聊天发送；轨迹 127 行、未截断，无协议冲突 |

注入是在答案提交开始后被观察到；不声称答题前已消费。约 15 秒观察内原问题没有被补充输入当作答案关闭。
本实验的答案仍走正常桌面 API，不是完整 Courier 或原始 ACP answer receipt 验证。该阶段尚未覆盖等待状态下连续两条/同文新输入、长工具步骤等；后续增量见下文，权限、撤销/恢复、正常接入和输出契约仍有缺口。
T031/T033/T059 与各真实门槛保持未完成/未准入，不把该局部结果写入完整 passed 证据。

## 另行创建 ACP 自有 Harness 会话的观察

新增显式 `--acp-owned-run`，独立于此前加载原 Harness 会话的实验。它不是 writer_occupied 后的新建回退，也不修改已有 Courier 绑定。
实验先由正常桌面入口完成独立目录中的基础任务，再向已归属的同一运行进程建立生产 ACP 连接；桌面启动用 Harness 会话标识被保留为已知归属。
只有 session/new 明确接受且返回不同标识，才允许提交合成记忆任务；首轮终态和内容确认后，才正常断连并恢复同一新 Harness 会话检查上下文。

当前安装包的 newSession 调用 initializeSession 时依赖 CLI 启动配置；首次新建可以带入启动时的 Harness 会话标识，不能只凭方法名或 cwd 参数认定新建了独立上下文。
2026-11-05，桌面 WorkBuddy 5.6.2 的实际回复如下：

| 检查 | 实际结果 |
| --- | --- |
| 前置范围 | 正常账户、独立目录和基础任务正常终态已观察 |
| 显式目标调用 | 一次 ACP session/new；零 session/load、零 session/prompt |
| 新建返回标识 | 与桌面启动用 Harness 会话标识相同，bootstrapReused=true |
| 本地处理 | 已知归属冲突保护返回 unknown/protocol_conflict，原本地关联不被覆盖 |
| 后续阶段 | 未提交目标 Agent 任务，未进行断连后的恢复/上下文检验 |
| 结论 | 当前启动方式未形成新的独立写入路径；不对其他启动配置或版本作普遍否定 |

这里的 protocol_conflict 来自本地关联保护，不能写成服务器明确拒绝了新建或 writer_occupied。
目标会话输出计数为零是因为没有进入目标任务，不能据此推导输出分类或片段协议不支持。
没有再次调用 new 强行得到不同标识，没有回退加载原桌面 Harness 会话或提交 prompt，也没有批准执行权限或发送钉钉聊天消息。

适配器已补上已知 Harness 会话标识保护，覆盖此前创建及正常恢复确认的标识；恢复不会覆盖原来已有的 Courier 归属记录。
源代码和实验入口仍未准入，独立创建、正常发现/激活与写入权交接需要可核实的接口及目标配置支持。

## 同文不同输入 ID 的连续补充

新增显式 `--steer-same-text`，复用运行中双输入路径。两次补充的正文逐字相同，使用两个不同的本地输入 ID 和操作 ID；第二条仍须等到第一条已注入、已关联可见文本出现合成标记且原提交仍在运行时才发送。
两个消费回执分别核对原操作/输入/Run；第二次注入后，原始 ACP 必须出现此前未出现的厂商消息 ID 分组并再次包含同一标记，两条观察路径也各核对至少两个标记消息分组。
旧消息尾片段、回显、思考、内部/历史帧、外来会话或跨消息片段拼接不充当新结果；正文不用于去重。

2026-11-05，桌面 WorkBuddy 5.6.2 的独立样本结果：

| 检查 | 实际结果 |
| --- | --- |
| 目标提交与补充 | 一次正常目标提交，两次原子 steer；零 load/原始 ACP prompt |
| 输入身份与正文 | distinctInputIds=true，identicalBodies=true，两个独立原操作各有匹配消费回执 |
| 接收与实际消费 | 分别接收 22/219 ms；两次消费均观察到原提交仍未返回且仍在执行 |
| 后续内容 | 原始 ACP 和桌面各有两个带同一合成标记的厂商消息 ID 分组；第二次消费后新增一个，newMarkerMessagesAfterSecond=1 |
| 关联完整性 | 原始 ACP 可见 417 帧、未关联 0；桌面可见 418 帧，其中 1 帧未纳入内容判定 |
| 终态与判断 | 原提交正常 end_turn、最终空闲；sameTextInputs.bothHandledObserved=true，bothControlsInOriginalRunObserved=true |
| 范围 | 轨迹 1134 行、未截断；无协议冲突、零工具调用/可执行批准/钉钉聊天发送 |

本结果补齐 SC-009 中同文新输入在 Harness 控制层的独立观察；不是实际钉钉 originalMessageId 作用域、Courier 入站全链路或服务端幂等验证。
两个不同消息标识组也不证明稳定片段重放、独立结束信号或 progress/final 分类。该阶段长工具步骤、其他运行状态和完整真实链路仍缺证；后续受控长工具结果见下文，整项任务与真实准入不变。

## 受控长工具步骤中的连续补充

新增显式 --steer-long-tool，使用正常 default 权限模式下的独立合成 Harness 会话。正常桌面入口提交预分配 Run 的任务，由 WorkBuddy 的 Bash 执行一次 sleep 12；命令不读写文件或访问网络。
只有生产事件解析确认原 Bash 工具、原 Run 与完整命令，且本次独立目录中恰有一个精确匹配的等待进程时，才提交两条独立控制输入。两次提交前及接收确认后分别重新观察该进程；任何人工权限请求、其他工具、范围变化或未知关联均停止，不自动决定权限。
进程观察限于精确匹配的 comm、cwd、argv，不读取进程环境或内存，也不导出进程号、命令正文、路径或运行端点。

早期两个独立样本使用内联 Python 合成命令，实际工具命令未满足精确范围检查，均在提交补充前停止；其中诊断确认原 Bash/Run 匹配但 command_mismatch。未保留真实命令正文，不能猜测具体差异或据此断言 Python 不受支持。
后续另行测试更简单的等待命令；仅允许精确命令或等价的本次独立目录 cd 前缀，没有放行其他命令，也没有重试未知控制操作。

2026-11-05，桌面 WorkBuddy 5.6.2 的实际结果：

| 检查 | 实际结果 |
| --- | --- |
| 工具范围 | 原 Bash 工具/Run 与命令匹配，唯一等待进程实际存活；没有其他工具或未处理人工请求 |
| 目标与补充 | 一次正常目标提交，两条不同输入/操作 ID 的补充；第二条只给出第二标记，不重复第一标记 |
| 接收 | 分别 accepted，接收耗时 14/9 ms；两次提交前及接收确认后的等待进程观察均为 true |
| 消费时序 | 两个独立注入回执均匹配原操作/输入/Run；各自直接读取原提交仍未返回且 isProcessing=true |
| 后续工作 | 原 Run 已关联输出包含两个互补标记，changedOutputs=[true,true] |
| 终态 | 原正常提交明确 end_turn、最终空闲；longToolSteerRoundtripObserved=true，无协议冲突 |
| 范围与完整性 | 脱敏轨迹 269 行、未截断；零 load、零原始 ACP prompt、零可执行权限批准、零钉钉聊天发送 |

两个消费回执在等待工具返回后、原任务结束前出现；SC-009 要求的是原任务结束前消费并影响后续工作，不要求等待工具尚未返回时就消费。
接收耗时只描述这个样本，不是 SLA，进程复查耗时也不计作 RPC 接收耗时。两个注入共享同一已验证厂商 owner 延续关系，仍分别核对原输入/操作，未假定每条补充都产生新 owner。
本结果补充长工具状态的独立观察；其他等待/临近完成状态、完整权限往返、输出分类/片段语义、正常生产接入及 Courier/钉钉链路仍缺证。T031/T033 等整项任务不勾选，不据此开放真实服务。

## 同一原问题待答期间的两条连续补充

新增显式 --steer-waiting-twice，扩展单条等待实验。正常桌面入口仍提交独立合成 AskUserQuestion 任务；每条补充前重新核对原问题、字段、原 Run 和待处理请求范围。
两条补充使用不同输入/操作 ID 和不同标记；第二条要求保留此前补充，但不重复第一标记。分别核对生产消费回执、注入时原正常提交仍未返回及各自标记输出，不能用一条成功代替另一条。
任一请求拒绝或未知就停止，不重放、不转为新任务；原问题答案仅限本次指定合成选项，不批准执行权限。

2026-11-05，桌面 WorkBuddy 5.6.2 的独立结果如下：

| 检查 | 实际结果 |
| --- | --- |
| 原问题 | 原工具/Run、两来源合并和原选项已确认；两次补充前原问题有效，originalQuestionHeldBeforeAnswer=true |
| 控制身份与接收 | 两条不同输入/操作 ID，各调用一次；接收分别 accepted，12/13 ms |
| 答题前观察 | 约 15 秒未观察到任一注入；两条 consumedWhileOriginalQuestionPending 均为 false，没有把观察窗口当 SLA |
| 原问题答复 | 正常 answerQuestion 返回 true，原指定选项正确，未触发其他工具 |
| 各自消费 | 两个独立原操作/输入的注入回执；两次直接读取均确认原提交未返回且仍在运行 |
| 后续内容 | 原 Run 已验证关联输出分别包含两个互补标记，两个 linkedChangedOutputObserved 均为 true |
| 终态和结论 | 原正常提交明确 end_turn、最终空闲；waitingSteerRoundtripObserved=true，controlCount=2 |
| 完整性与范围 | 轨迹 161 行、未截断，无协议冲突；零 load、零原始 ACP prompt、零可执行权限批准、零钉钉聊天发送 |

两次注入都在原答案提交开始后、原任务结束前被观察到；不声称答题前就已消费。这个样本补齐同一原问题等待期间两条补充各自生效的局部观察。
权限等待/撤销/恢复、临近完成竞态、正常生产接入、逐文本分类和稳定片段身份及完整 Courier/钉钉链路仍缺证；原始 ACP 人工答复回执也不由正常桌面答复结果代替。
不创建完整 passed 能力证据，真实服务与任务整项状态保持不变。

## 原任务明确结束后的补充拒绝

新增显式 --steer-after-completion，正常桌面入口在独立合成 Harness 会话中完成一个无工具文本任务，使用生产相同的预分配 Run 元数据。
只有正常返回明确 end_turn、原 Harness 会话空闲且没有人工请求，原始 ACP 中原 Run 的可见输出也包含完整合成标记时，才派发一次指向旧 Run 的原子控制。
随后只读观察原始事件和桌面历史，不再提交普通输入、队列项、新任务或另建 Harness 会话。

两个早期独立样本直接用桌面历史做原始事件关联校验，没有满足前置条件，控制派发均为 0。原始订阅已见原 Run 的标记和 end_turn；第二样本正常快照也确认原会话、正常终态、空闲及无人工请求，但历史帧未通过同一字段判断。
没有保留足够字段说明两个来源的具体差异，不能把该现象归为服务器拒绝 steer，也不能仅从终态推导原历史的标识语义。
后续修正为保存到达时的原始 ACP 帧用于输出关联，正常桌面历史只用于比较变化；这是新的独立合成样本，不是重放此前未知控制。另行补上经核实的会话容器可限定无事件会话字段的测试，不把这一通用情况写成前两样本的已证原因。

2026-11-05，桌面 WorkBuddy 5.6.2 的实际结果：

| 检查 | 实际结果 |
| --- | --- |
| 原任务前提 | 正常桌面任务返回 end_turn、原 Harness 会话空闲且无人工请求；原始 ACP 28 帧，原 Run 输出包含合成标记，无外来会话标识 |
| 显式控制 | 一次原子 steer，指定已经结束的原 Run；零 load、零原始 ACP prompt |
| 服务器结果 | steered=false、reason=idle；生产解析为 rejected/stale_run/definitelyNotAccepted=true，接收耗时 16 ms |
| 后续观察 | 约 5200 ms、23 次只读检查；原始事件与桌面历史均未变化，原 Harness 会话仍空闲，无消费回执 |
| 局部结论 | completedRunRejectionObserved=true，无协议冲突；没有改用下一轮输入或重新提交控制 |
| 范围与完整性 | 轨迹 33 行、未截断，原始缓冲未截断；零可执行权限批准、零钉钉聊天发送 |

5.2 秒是该样本的观察范围，不能证明未来永久不会有新工作；16 ms 不是 SLA。这个样本证明正常完成后的 idle 拒绝边界，不代替临近完成时两条补充在原任务内消费的竞态验证，也不推导所有 stale 原因均已覆盖。
原始/桌面输出交叠、完整权限往返、正常接入及写入权、分类和片段语义及 Courier/钉钉链路仍按既有未验证边界处理；真实服务不开放，T031/T033 等整项任务不勾选。

## 运行中的合成斜杠输入拒绝

新增显式 --steer-slash，复用独立正常桌面任务、原始 ACP 控制连接和生产 steer 解析器。
只有预分配原 Run 已实际产生执行事件、正常提交仍未返回且无待处理人工请求时，才提交一次随机合成斜杠文本；使用未知合成命令名，不调用现有产品命令。
拒绝或未知不改走普通 prompt、队列、下一轮任务或其他 Harness 会话，也不重试。

当前安装包的 handleSteer 在原 Run/活动状态检查前进行输入形式检查；不支持的形式可直接返回 steered=false 而没有 reason。
因此探测要求生产解析为明确输入拒绝，不能把 idle/stale 的完成后拒绝当作本场景通过。

2026-11-05，桌面 WorkBuddy 5.6.2 的独立结果如下：

| 检查 | 实际结果 |
| --- | --- |
| 派发前提 | 原预分配 Run 实际执行，派发时原提交未返回且 isProcessing=true，无待处理人工请求 |
| 控制次数 | 一次原子 steer；零 load、零原始 ACP prompt |
| 服务器/生产解析 | steered=false、无 reason；rejected/steer_rejected，接收耗时 54 ms |
| 消费与 owner | 没有消费回执或 owner 变化；没有改走队列/新任务 |
| 原任务输出 | 原始 ACP、桌面各 26 个可见帧，未关联均为 0；原标记保留，补充标记均未出现 |
| 终态 | 原正常提交明确 end_turn、最终空闲，slashControl.slashRejectionObserved=true |
| 完整性与范围 | 轨迹 131 行、未截断，historyIntegrity=true、streamTruncated=false、无协议冲突；零工具/可执行权限批准/钉钉聊天发送 |

54 ms 是单样本接收耗时，不是 SLA。原任务继续按原输入完成，不能把预期拒绝写成及时消费失败，也不能将它作为修改内容已生效的证据。
历史重置或外来事件、缓冲/轨迹截断均会使探测结论不通过；没有丢弃这些事实来凑通过。

本样本原始 ACP 终态在客户端约 9244 ms 被观察到；桌面历史的 model_done/idle 阶段只在随后约 9295 ms 的读取中被观察到。
这些是客户端观察时刻，不证明厂商实际生成时间的先后；当前控制连接未记录到提前可用的 model_done 帧，不能用这次已结束后的读取作为临近完成时仍可控制的锚点。
执行阶段仍不能代替逐文本分类或逻辑消息结束依据。该阶段尚未覆盖临近完成/权限等待等场景；后续受控报告后期结果见下文，其他必需能力与完整真实链路仍缺证，真实服务不开放，整项任务不勾选。

## 受控报告后期的两条补充

新增显式 --steer-near-completion。正常桌面入口提交预设 20 行的无工具报告；只有原 Run 同一条可见消息的前 17 行编号与第 18 行合成标记都匹配，原正常提交仍在执行且没有原始终态或人工请求时，才提交两条不同输入/操作的补充。
第一条明确接收后重新核对原任务，再提交第二条；两条仅调整原报告的收尾，第二条不重复第一标记且保留此前要求，没有另外安排长任务或人工等待来延长窗口。
标记用于触发这个受控实验，不是生产输出类型或任务完成判断；不能从它推导厂商 progress/final 或通用“临近完成”语义。

首个独立样本分别接收 13/9 ms，已观察两个消费回执、原提交未返回和两个修改标记，但脱敏轨迹达到默认 2000 行上限，truncated=true，整体结论没有记为通过。
后期实验随后显式使用 5000 行的有界轨迹容量，默认其他实验仍为 2000；构造器拒绝非正、非整数或超过 10000 的容量，触及上限依旧不能通过。
下述结果来自新独立样本，使用新输入/操作标识，不重放首个样本，也不反向改写其截断事实。

2026-11-05，桌面 WorkBuddy 5.6.2 的完整样本结果：

| 检查 | 实际结果 |
| --- | --- |
| 后期准备 | 原 Run 同一消息进入预设第 18/20 行，正常原提交仍在运行且未返回，未见原始终态 |
| 控制与接收 | 两条不同输入/操作，各提交一次；分别 accepted，接收耗时 45/36 ms |
| 两次消费 | 独立原输入/操作的消费回执，均早于原始终态，firstAppliedBeforeTerminal/secondAppliedBeforeTerminal=true |
| 正常原提交直接读取 | 两次注入后的直接读取均为 isProcessing=true、原正常提交未返回；两个 DirectPendingObserved 均为 true |
| 后续内容 | 原始 ACP/桌面各 862 个可见帧，未关联均为 0；两个互补标记都在已验证原 Run 的内容中 |
| 终态与结论 | 原始终态明确 end_turn，原正常提交也正常返回、最终空闲；nearCompletion.bothInputsInOriginalRunObserved=true |
| 完整性与范围 | 轨迹 2016 行、未截断，流缓冲未截断、历史完整、无协议冲突；零工具/执行权限批准/钉钉聊天发送，零 load/原始 ACP prompt |

客户端观察时钟中，后期标记及第一派发约在 7265 ms，第二派发约在 7419 ms；两次注入约在 8164 ms，直接读取分别约 8221/8232 ms。
原始 end_turn 约在 15155 ms 被观察到，正常返回在随后读取中确认。这些是客户端观察时刻及单样本耗时，不是 SLA 或厂商生成时间保证。
后续厂商 owner 变化只通过原注入边及原 messageRequestId 核对，未把新的厂商标识直接当作另一 Run，也未靠最新输出猜归属。

该结果补齐预设报告后期的独立控制观察，不证明所有临近完成竞态。权限等待、断连未知、正常生产发现/写入权、完整人工输入与输出语义及 Courier/钉钉链路仍缺证；T031/T033 等整项任务保持未完成，真实服务不开放。

## 预期 Run 不匹配与本机控制连接故障

新增显式 --steer-failure-boundaries，正常桌面入口在独立目录启动一个无工具合成任务；只在原 Run 已实际执行、正常提交未返回、无人工请求/工具或原始终态时，才提交控制。
第一条使用不同的有效格式预期 Run 标识，必须取得明确 stale 拒绝；接收、未知或 idle 均停止后续控制，不把它们当作 stale 通过。
重新核对同一原任务后，第二条使用不同输入/操作 ID 和正确目标。在启动真实 fetch 后、取得回执前立即关闭本次 Courier 控制连接；这是本机故障注入，不改动厂商运行进程或正常桌面写入者。

2026-11-05，桌面 WorkBuddy 5.6.2 的实际结果：

| 检查 | 实际结果 |
| --- | --- |
| 不匹配预期 Run | 一次控制，服务器 reason=stale；生产 receipt 为 rejected/stale_run/definitelyNotAccepted，接收 18 ms |
| 自有传输故障 | 另一正确目标控制启动 fetch 后关闭本连接；connectionLost=true，生产 receipt 为 unknown/state_unknown，本地形成 unknown 耗时 11 ms |
| 同句柄再次读取 | 返回同一个 receipt Promise，仍 unknown，没有新的 RPC 调用或 fetch POST |
| 持久意图 | SQLite 关闭/重开后原输入、操作和 unknown 内容完全一致；重建适配器对象仍返回 unknown/state_unknown |
| 不再次派发 | RPC 方法调用总数及 fetch POST 发起总数均为 2；重建后两者都未增加，noAdditionalRpcOrPost=true |
| 正常原任务 | 正常桌面原提交继续并明确 end_turn、最终空闲；没有新增普通任务、取消、队列或替代 Harness 会话 |
| 范围与完整性 | 轨迹 410 行、未截断，历史完整、无协议或清理异常；零工具/可执行权限批准/钉钉聊天发送，零 load/原始 ACP prompt |

18 ms 是明确拒绝的单样本接收耗时；11 ms 是客户端从派发到形成 unknown 的耗时，不是服务器接收确认或 SLA。
fetch 发起数不等于服务器收到的次数，故障输入在断开时是否被服务器接收保持未知，不能从 abort 推导未执行。
重建对象仍持有已关闭连接，但 RPC 方法调用计数也保持不变，证明在调用传输前由持久意图守卫拦截，而不是只依赖关闭连接阻止 POST。
该观察属于同进程数据库句柄重开及对象重建；没有声称完整 Courier 进程重启、自然网络故障、事件重放或服务器幂等已通过。
正常桌面读取只用于确认原任务生命周期，不作为故障操作的权威查询；目标可选查询仍明确不支持，不能据此盲目重发 unknown 操作。

failureBoundariesObserved=true 只描述这组有界实验。正常生产发现/独立会话/写入权、完整原始人工输入与可靠输出语义，以及真实 Courier/钉钉链路的门槛仍未满足；任务整项保持未完成，真实服务不开放。

## 2026-11-06：启动初始化后的独立 ACP 创建与恢复

根据本机 initializeSession 对首次新建与后续新建的不同处理，增加显式 `--acp-bootstrap-owned-run`。
先核对本次正常桌面测试 Harness 会话空闲；原始 ACP 启动初始化必须明确回传该已知标识，才执行另一个新建操作。
只有生产适配器取得不同的新标识并接受创建，才提交记忆任务；正常结束后断连，再用新连接 load 同一标识并核对未在续聊输入中重述的合成标记。
初始化未知/缺标识/不匹配均停止；没有 unknown 重试、加载失败后的新建回退、覆盖旧 Courier 绑定或强夺用户原 Harness 会话。

| 仓库入口的独立复现 | 结果 |
| --- | --- |
| 正常登录、版本、前置文本任务 | 已观察；5.6.2；end_turn 且空闲 |
| 启动初始化 | matched，仅匹配本次自有启动 Harness 会话 |
| 原始 RPC 数 | new=2、load=1、prompt=2 |
| 新建目标 | 与桌面启动用 Harness 会话标识不同 |
| 首轮任务 | accepted/completed/end_turn，合成标记匹配 |
| 正常断连及原目标恢复 | accepted |
| 续聊 | accepted/completed/end_turn，复述原标记 |
| 输出 | 61 个可见帧；类型、片段身份和 promptRequestId 帧均为 0 |
| 工具及执行权限批准 | 均为 0 |

此前临时调查封装的独立样本也观察到同一路径和上下文恢复，52 个可见帧；封装后的旧计数器只统计第二个新建，实际仍有两个新建 RPC。
本表使用仓库显式入口的计数，不把临时封装当作生产实现。
正常发现/激活与生命周期、桌面持有的原 Harness 会话写入权交接、两个私聊并发隔离、完整人工交互及 Courier 重启仍缺证。
输出语义仍未满足，真实服务不开放；完整调查与官方接口范围见 interface-research-2026-11-06.md。

## 2026-11-06：原始 ACP 单选题及原 Run 续行

修复前，生产适配器 clientCapabilities={}，本机 AskUserQuestion 的 ACP isEnabled 判断要求 question=true，因此真实问题任务直接结束，未观察到原生问题，答复数为 0。
已补充客户端问题能力声明，明确 fs 读写为 false；回归测试先复现原差异，再验证修复，完整人工准入状态保持不变。

显式 `--acp-bootstrap-owned-question` 真实复现 new=2、load=1、prompt=3；原始 ACP 合成单选题匹配，答案只提交一次，receipt=accepted、对应 input.accepted 已观察。
原 Run 最终 run.completed/end_turn，新的 Agent 正文精确输出所选标签；问题正文/选项回显不计作结果。
权限请求与执行权限批准均为 0；83 个可见帧仍没有 progress/final 分类或片段身份。
此前临时独立驱动也观察相同问答路径，仓库入口再次复现用于消除临时封装依赖。
这只证明本版本上的原始 ACP 单选问答及续行，不能关闭完整执行权限、待答恢复或 Courier/钉钉人工往返任务。

## 2026-11-06：原始 ACP 执行权限拒绝

新增显式 `--acp-bootstrap-owned-denial`，仅在自有目录配置 Bash ask 并核对本次 Harness 会话 mode=default，经过独立创建/恢复及上下文检查后请求一次合成打印命令。
只有原工具/Run、完整命令及可见拒绝选项匹配才答一次 deny；生产 receipt=accepted，原 operation/input 的 input.accepted 和原始 prompt.stopReason=cancelled 均已观察，归一为 run.failed。
未观察到额外工具 ID；执行权限批准为 0。57 个可见帧仍没有可靠类型或片段身份。

本机 handleResolveInterruption 的非问题 deny 分支直接 reject 原工具并终止 Run；该路径未观察到工具 permission_denied 取消标记或权限错误正文，两者保持 false。
原生工具取消帧来自另一 interrupt_result 路径，不能凭期待补造。两个早期探测样本继续保留 unverified；最终按原生拒绝契约另行独立运行，没有重放旧操作。
这只证明一次拒绝明确接收及原 Run 取消，不是完整权限批准、撤销/重连或 Courier/钉钉验收。

另修复适配器漏处理有效 tool_call_update.status=cancelled 的待答撤销；同一原工具的问题/权限取消只撤销一次，不确认答案，外来工具、错误 Run 和成员帧不能借用当前关联。
具体前提、RPC response 观察修正和五项拒绝保护测试见 permission-denial-2026-11-06.md。

## 2026-11-06：普通 Hook 与输出来源

新增显式 `--acp-bootstrap-owned-hooks`，仅在自有私有目录准备观察脚本和 Hook 配置，不返回决定、不读环境或转录内容；原生身份和正文只保留摘要。
仓库入口在首轮和正常恢复后的续聊中，各观察到原 Harness 会话和 generation_id 匹配的 UserPromptSubmit、Stop、FinalStop；Stop 正文摘要匹配预期合成回答，FinalStop 原因为 completed。
两组匹配 Hook 均为 3 条；身份字段只有 session_id/generation_id，没有 session 对象、逻辑消息或片段身份。session RPC new=2、load=1、prompt=2，57 个 ACP 可见帧，零工具和权限批准。

另一次限定已创建 Harness 会话、同名普通文件的只读转录元数据实验发现：续聊 Stop 时只有旧回答，到 FinalStop 才出现本轮完整 assistant 记录；generation 可区分相同正文的新旧回答。
记录有 id、completed 和 providerData.messageId/conversationRequestId，但被检查的进度/最终语义字段未出现。本次只验证 ID 存在，没有把它扩大为跨 Run 唯一性通过。
当前安装包未见新版 Mods 加载入口，不将最新 CLI 文档或服务网关代理当作本机原生事件接口。
完整输出桥接尚未实现/准入；详细字段、持久化时序及边界见 hook-output-2026-11-06.md。

### 追加转录结构观察与写入保护

新独立结构样本显示：首轮 Stop 和 FinalStop 时都没有完整 assistant 记录，正常断连/load 后续聊时才同时见到旧、新回答。
两轮原始终态均为 end_turn，上下文复述成立；这反驳将 FinalStop 当作转录刷新屏障的假设，不改变此前样本的实际时序记录。
原生 reasoning、file-history-snapshot、ai-title 已按白名单字段存在性区分，未读取或保存其正文/路径/标题；不能把这些类型当作用户进度或输出结束指针。
临时脚本的首个空采集样本按 matchedRows=0 判为未验证；修正且合成检查后的有效样本各三条原 Run Hook，new=2、load=1、prompt=2，55 个 ACP 可见帧，零工具与执行权限批准。

另已修复普通 Hook 采集只在汇总端限制容量的遗漏：文件锁内拒绝超过 1 MiB/4096 条记录、权限变宽和末行不完整的追加，单条编码扩张超限也不能创建输出。
两项新增回归先失败再通过；完整离线套件 160 项通过、0 失败，build/typecheck 通过，应用行覆盖 3151/3664（86.00%）。
完整分类、片段与原生事件桥仍未准入；详见 hook-output-2026-11-06.md。

## 2026-11-06：显式 MCP 格式化来源

四次不含 prompt 的 HTTP 结果读取均因 Harness 会话不符而拒绝；Gateway Runs 分支会等待空闲及设 BypassPermissions，本次没有调用它执行任务。
另沿正常 ACP mcpServers 配置纯格式化工具，类型来自 kind，消息身份和完成来自原生工具事件，权限策略保持原样。

仓库编译服务、创建/恢复配置及 typed 归一化已独立观察三个调用：两个相同正文的 progress 和一个 final，各有不同 toolCallId、原 Run 关联、completed 和精确结果回显。
归一化得到三条对应快照，普通未分类 message 为 0，final 先完成，原 Run 随后 end_turn；218 个原始 ACP 帧未截断，权限请求及批准均为 0。
基础创建/恢复两轮正常完成并复述标记，记录 new=2/load=1/prompt=2；另追加本轮类型任务一次，不将附加任务漏算为仅两次 prompt。

早期只有 ToolSearch 的未通过样本、初始连接插入实验导致基础零工具检查为 false 的样本，以及临时回显解码 false 的样本均保留，不回填通过。
普通 ACP 文本、其他 MCP 工具或不同配置不能借用本次类型证据；日常配置/指纹、steer/重放/重启和完整交互仍未完成。
代码继续强制 typedVisibleOutput/messageAssembly/humanInteraction=unverified，真实服务关闭；实现与详细样本见 formatter-output-2026-11-06.md。

随后仓库 --acp-bootstrap-owned-formatter 正式入口独立复现上述三消息与原 Run 终态分离：基础上下文通过，283 帧完整，new=2、load=2、prompt=3，无额外工具或人工请求/权限批准。
格式化工具新拥有者仍须同时具备已核实 steer 延续与原输入关联；独立八进度实验中两条补充 accepted/applied，但七个后续调用缺少原输入关联，保持隔离。最新原生 final 未包含两条补充标记，受控实验不通过，不能据此宣称完整 steer 输出桥接。
正式探测及生产归属新增八项回归，最新完整离线套件 181 项通过；不提升真实能力状态。

补齐 typed 启动请求的 requestId/messageRequestId 后，新的独立八进度样本中七个延续调用均保留原 Run 的 messageRequestId；九个 completed 和归一化消息成立，两条补充均 accepted/applied 且影响原生及归一化 final，原 Run end_turn，1239 帧完整，零人工请求/批准。
这是修复后的局部观察，不改写前述缺字段/缺标记的旧结果。新增正式 --acp-bootstrap-owned-formatter-steer 后，首个样本的两条控制和拥有者关系成立，但十个调用（额外 final）及缺少两条标记不符合通过条件，仍 unverified。
后续明确实验指令的补充优先级并增加脱敏诊断；原消息数量、身份、回显、两条实际效果及独立终态条件均保留。新增六项回归后完整离线套件 187 项通过，真实硬能力仍 unverified，详细边界见 formatter-output-2026-11-06.md。

新指令的第二个正式样本也未通过：863 帧、九条格式化消息及八个延续调用，两条控制响应和 applied 成立，但原生 final 对原标记/第一补充/第二补充的匹配为 true/false/false；原始工具流有 request_metadata 矛盾，具体工具/阶段尚待核对。原 Run end_turn，无人工请求或权限批准；不放宽条件或改写旧报告。

新增脱敏诊断的 585 帧样本将不同请求字段定位为格式化工具参数流；final 参数/完成帧晚于两条注入，final 与普通可见文本都未含两条标记，保持 unverified。只记录到达次序、字段关系和布尔值；明细有界并报告截断，不推断模型内部参数生成时点。
另在原三消息基线完成后追加原生合成问答 Run。修正私有观察器过早要求完整参数的缺陷后，180 秒样本观察到：待答期间两条补充、补充实际触发第二题、两次答案分别明确接收、原 Run end_turn。追加 Run 869 帧，前置三消息 183 帧；实际总 prompt 为四，零执行权限批准或钉钉发送。最终正文合并标记检查仍未通过，报告保留 unverified。
该第二题工具的 conversationRequestId 属于原 Run，requestId 属于已核实后续拥有者，messageRequestId 保留原 Run；原生请求另有无 Run 字段的 session_info_update 及 request_permission 通道观察。生产及独立探测按每个字段已建立的证明链检查；未知字段登记工具和误撤销权限的回归先失败后修复，不能据此开放未知或成员/历史内容。
新增五项回归，完整 192 项离线测试通过，build/typecheck 通过，应用行覆盖 3417/3952（86.46%）。完整人工/权限、正文效果、恢复及正常生命周期仍缺证，三项硬门槛不变。

常规私有连接配置已接入 acp-text/courier-formatter 模式、客户端输出约定和相关固定代码/规则/Node 版本的证据指纹；实现变化或读取失败时当前探测的必需能力回到 unverified，历史记录不改写。静态配置校验同步解析非凭据 JSON；两模式的真实组合都仍因缺证拒绝。
新增 --acp-bootstrap-owned-formatter-contract，以正常构造器执行用户未提 MCP 工具名的普通请求。首个 owned 流程因 ACP 未回传 CLI 版本而未开始，保留原结果；独立输出观察改为显式 null 未知上下文，不能借作声明版本的证据。之后 463 帧三消息样本通过，new=2/load=2/prompt=3，原生身份、回显、顺序、归一化及原 Run end_turn 均核对，版本事实仍未验证。
待答组合在新约定下另追加 Run：前置普通三消息 224 帧通过；追加 509 帧内两条补充及两个答案都明确接收，原 Run end_turn，但 final 对原标记/第一选择/第二选择/额外标记的匹配为 true/true/false/false。前一旧约定逐项样本 815 帧为 true/true/true/false；均保留 unverified，不推断答案已被生成实际使用或完整任务边界已经证明。无执行权限批准或钉钉发送。
最新 build/typecheck 与完整 196 项离线测试通过，应用行覆盖 3482/4021（86.60%）；正常生命周期、CLI 版本核实、完整正文/权限/恢复及平台链路仍未完成。

## 正式两问两补充观察的增量

新增 --acp-bootstrap-owned-formatter-question-steer，直接调用正常适配器与原始连接，不依赖临时生命周期补丁。七项回归已核对原始权限/问题撤销/冲突停止、未知不重发、原生答案结果的有效性、完整注入与 final 效果、隐私/界限及显式 CLI 门槛；完整 207 项测试、build/typecheck 通过，应用行覆盖 3489/4024（86.70%）。

两个正式独立样本分别为 879、1083 帧，new=2/load=2/prompt=3。两条完整注入、两个明确答复及各自原生工具结果均匹配，原 Run end_turn；final 仍缺要求。分离后的新诊断明确来源/身份/快照匹配、全部内容效果未通过。二者均 unverified；CLI 运行版本、正常接入、写入权、权限、重启及平台边界不变，详见 formatter-output-2026-11-06.md。没有批准执行权限或发送钉钉消息。

## 正常后端释放的增量

桌面 requestYield 的 false 现只记 not_confirmed：安装桥接层可折叠异常，旧 raw 报告保持原样，不能认定为明确拒绝。新增 --acp-release-handoff 经正常接口只释放本次已确认空闲、无待答且原 load 明确写入权冲突的自有目标。真实样本在方法完成后观察原 ACP 关闭、自有运行进程计数零，没有第二次 load、额外 Agent 任务、权限批准或钉钉发送；这项正常释放没有提供所需写入权交接。

三项新增回归及完整 210 项离线测试、build/typecheck 通过，应用行覆盖 3489/4024（86.70%）。准入和 writerOwnership=unverified 保留；完整静态路径、观察与限制见 writer-lifecycle-2026-11-06.md。

## 已完成格式化 Run 的历史加载增量

实际历史 replay 带 codebuddy.ai.mode=history/offset，共享生产过滤已补齐，并以两项契约回归核对历史不得确认新 Run、发旧输出或修改人工/控制状态。正式 --acp-bootstrap-owned-formatter-history 使用正常输出构造器，先核对三条原格式化消息，再断开自有 ACP、以新适配器 load 同一个 Harness 会话、在新 Run 复现未重述的原 final。

独立真实样本首轮 222 帧；恢复有 16 帧历史、三个原工具及完成结果保持一致，旧逻辑消息重复为零；新 Run 115 帧、一个原 final 的新格式化工具、原始 end_turn。new=2/load=3/prompt=4，没有人工请求、执行权限批准或钉钉发送。局部 observed、总体 unverified；CLI 版本仍未知，自然迟到历史为零，实际 Courier 进程重启不在该样本范围。见 formatter-history-2026-11-06.md。

后续独立 Courier 子进程、SQLite 和 15 个 SIGKILL 窗口的通用恢复检查使用测试 Harness/平台；它不增加真实 WorkBuddy 能力证据，见 recovery-2026-11-06.md。当前完整离线套件 222 项通过，真实门槛保持。

## 两个原 Harness 上下文的隔离恢复增量

--acp-bootstrap-owned-isolation 已独立真实观察：同一已登录桌面实例通过生产适配器创建不同 A/B 标识，B 保存另一标记后正常断连，随后以不同适配器与连接分别 load 原 A/B。两次恢复各自只输出本会话的精确标记，未重复提供标记，也未出现另一会话标记；加上前置 A 保存/恢复与 B 保存，五个 ACP Run 均 end_turn，new=3/load=3/prompt=5。

本样本零工具、人工请求、执行权限批准或钉钉发送，资源清理后自有运行进程/临时目录均为零。局部 observed，总体 unverified；未验证两个同时活动 Run、两个钉钉用户、实际 Courier 重启、桌面原写入权交接或 CLI 版本。不能把原生 Harness 隔离扩大为整条平台路由已验收，见 isolation-2026-11-06.md。

两项新增离线回归和 CLI 门槛扩展、build/typecheck/test:coverage 均通过，完整 224 项、0 失败/跳过，应用行覆盖 3529/4063（86.86%）。整项仍 66/80，真实服务关闭，无新增提交/推送。

## 操作者确认的 Courier 独占模式

按新决定，桌面只提供空白 H，Courier 独占实际 A/B；不再把桌面已有用户会话的接管作为首版前提。普通配置与生产适配器已接入宿主核对、初始化意图持久化、准确 H 回执，以及 A/B 原归属检查；宿主和未知引用不能承接用户输入，unknown/dispatching 不重发。原 spec.md 正文未修改，对照见 ownership-decision-2026-11-06.md。

生产独占模式真实样本中，A 首轮任务明确结束后正常释放 H，旧运行进程计数零；新空白 H2 上启动新后端，适配器初始化 H2 后 load 原 A 成功，续聊精确复现未重述的原标记。两轮各 32 个归一化事件、原始 end_turn、完整归属、零工具/权限批准/钉钉发送。原启动宿主 load 未确认空闲的较早样本保留未通过；没有把 H2 当作替代用户上下文。

CLI 握手版本仍缺失，另一个 HTTP info 路由返回 401 后停止，没有提取或绕过认证。宿主创建/发现仍由独立驱动提供；本样本没有重启实际 Courier 应用进程。完整限制见 courier-exclusive-2026-11-06.md。五项新增回归及完整 229 项测试、build/typecheck/test:coverage 通过，应用行覆盖 3602/4142（86.96%）；整体准入仍 unverified。

## 自动创建/发现与持久宿主复用

后续已把独占范围写入 spec.md，FR-003/FR-009 保留，并将自动激活/发现连接工厂接入普通组合。自动模式省略固定端点/宿主，正常桌面 session:create 只创建一次 H，创建意图持久化；发现按准确启动标识、同用户进程和所属回环 socket 核对。已知宿主不可确认时停止，不替换用户上下文或盲目新建宿主。

初始真实重连被宿主历史校验拒绝；诊断确认其中的 50 帧活动均来自 Courier 原 Run。修复持久归属后，独立真实样本在 SQLite 重开与新工厂构造后复用原 H，创建记录仍为 1，原 A load 明确接受并精确复现未重述标记；两轮各 28 个事件、原始 end_turn、完整归属、零工具/权限批准/钉钉发送。镜像 172 帧活动均关联原 Run，但不据此放行未知、矛盾或未绑定工具内容。

完整 237 项离线检查、build/typecheck/test:coverage 通过，应用行覆盖 3776/4377（86.27%）。CLI 版本、实际 Courier 应用进程重启和宿主丢失处理仍缺证；总体 unverified，整项仍 66/80。范围见 automatic-runtime-2026-11-06.md，无新增提交/推送。

## 自有后端结束后的自动恢复与运行版本

普通工厂已持久保存核实过的进程身份，只有确认旧进程结束才创建新空白 H2；未知/受限/创建结果不明仍停止。真实失败定位为预热进程没有启动宿主参数，正常 app:getConfigDir 定位的自有 PID 运行记录与宿主、实际回环 socket 共同补齐发现，未读取账号配置或环境。

修复后的真实样本完成 H/A 首轮、正常空闲后端结束、SQLite 重开、自动 H2 和原 A load/精确上下文恢复；两个 Run 各 31 个事件、completed/end_turn、零工具。当前进程 CLI 2.147.0 已核实；执行权限批准及钉钉发送为零。完整 247 项离线测试及 build/typecheck/test:coverage 通过，应用行覆盖 3893/4502（86.47%）。实际 Courier 应用重启与完整交互/输出/平台门槛仍未完成，见 runtime-recovery-2026-11-06.md。

### 2026-11-06：正式跨适配器进程恢复入口

新增 --acp-automatic-runtime，使用生产工厂、私有 SQLite 与三个实际独立且正常退出的子进程。正式真实样本通过首轮、原 H/A 复用，以及确认旧后端结束后自动 H2/原 A 恢复；三轮均为 29 个事件、精确上下文和 end_turn，无工具、执行权限批准或钉钉发送。五项新增离线回归及完整 252 项测试、build/typecheck/test:coverage 通过，应用行覆盖 3893/4502（86.47%）。范围见 verification/runtime-process-2026-11-06.md（verification 内文档同目录）。不是完整 Courier 应用/平台重启或全部准入，不增加整项任务勾选。

### 2026-11-06：启动模式与权限等待探测

新增显式拒绝型权限等待入口及可选 bootstrapPermissionMode=default，配置回读、缓存和证据指纹均区分；新增六项及扩展回归后，完整 build/typecheck/test:coverage 通过，258 项、0 失败/跳过，应用行覆盖 3901/4510（86.50%）。两个真实样本均因实际 A 未确认 default 而在任务开始前停止；显式 H 配置不能替代 A 回读，零执行任务/steer/决定/钉钉发送。范围见 permission-wait-2026-11-06.md（tasks 的引用在 verification 下）。不增加整项任务勾选或真实能力声明。

### 2026-11-06：专用实际 Harness 会话连接

工厂新增内部 contextSessionRef 路径，要求已确认 H 和原 Courier 归属，只复用现有后端、首次 load 原 A 并核对原生模式；不再次新建 H、不接管写入权，配置 unknown 不重发。正式 284 帧样本已确认 A 的 default、精确原权限、两条补充接收及一次拒绝/原 Run 取消；拒绝前两个实际效果仍缺证。十项新增回归及完整 build/typecheck/test:coverage 通过，共 268 项、0 失败/跳过，应用行覆盖 3986/4593（86.78%）。详情见 context-connection-2026-11-06.md（tasks 位于 verification 下）。普通真实组合尚未自动按 A/B 管理连接，不增加整项勾选或真实能力声明。


### 2026-11-06：普通连接管理与独立后端

ManagedWorkBuddy 已接入普通独占组合，保留每个原 A/B 的专用连接及持久操作/Run 结果。共享后端交错问题样本缺少原 A 续行；单 A 对照通过。自动模式改为按 Courier 会话隔离宿主/后端后，已观察 B 在 A 待答期间创建和运行、原 A 一次答案后正常结束，以及私有库重开后原 A/B 的未重述上下文。原关联不迁移或换建，未知不重放，固定宿主不复用该隔离结论。完整 287 项离线检查通过；真实观察及失败对照见 managed-connections-2026-11-06.md，必需能力仍未完整准入。


### 2026-11-06：每个 Courier 后端的退出及三个工作进程恢复

分区后的真实恢复已补充：B 原生问题待答期间 A 后端正常结束、旧进程死亡证明、新空白宿主恢复原 A，随后 B 原问题及原 A/B 续聊成立；三个独立适配器进程下，两次后续恢复均未新建用户上下文，仅替换已确认结束的 A 宿主，B 原后端保持不变。实际 Courier 应用、完整输出/权限及平台门槛仍未完成。结果及边界见 managed-recovery-2026-11-06.md，完整离线套件为 295 项通过。

自动管理的配置目标现已独立验证跨三个适配器进程及空白宿主替换不变；后端归属/版本核对仍逐连接执行。default 格式化样本 166 帧停在权限请求，原生普通文本双问答样本 402 帧中两条补充完整注入、两次答案明确接收，但最终仍缺第二条额外标记，均 unverified。核心人工请求/隐藏输出的投影阻塞已修复，完整离线套件现为 301 项通过。新入口、结果和静态代码核对的边界见 managed-output-2026-11-06.md；不开放真实 serve。

取得操作者对一次准确合成格式化调用的明确授权后，153 帧真实样本已观察一次 allow 的原始 resolved=true/queued=false、归一化原答案接收、原格式化工具/消息完成和原 Run end_turn。前三份未通过样本均为零批准；已修复探测器混淆权限相关 UUID、无 Run 广播及增量参数的问题，并要求完整参数原生标记。桌面 5.6.2 / CLI 2.147.0，当前完整离线套件 313 项通过；该单次授权已使用，不批准后续请求。详细边界见 formatter-permission-2026-11-06.md，三项硬能力继续 unverified，未执行真实 Courier/钉钉整条链路。
