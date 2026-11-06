# Harness 适配器契约 v1

术语遵循 [术语与命名](../../../README.md#术语与命名)。本契约中的 `sessionRef` 指当前 Harness 实例内的
Harness 会话引用，对应绑定中的 `harnessSessionId`；`courierSessionId` 则是本地 Courier 会话 ID。
`runRef`/`expectedRunRef` 指 Harness 运行标识，`clientRunId` 指 Courier 的 `Run.id`，两侧标识不能互换。
`session/*` 保留厂商协议原名；连接、订阅和 Harness 会话各有独立生命周期，断开连接不等于 Harness 会话或 Run 已结束。

这是已建立的应用端口，目前由测试适配器验证；它不是 WorkBuddy 的公开 API 保证。
应用路由不得读取厂商 JSON-RPC、运行端点或进程状态；适配器不得执行 Courier 自有 Agent 循环。
关联与状态定义见 [data-model.md](../data-model.md)，研究证据见 [research.md](../research.md)。

## 能力与准入

`probe()` 返回 product/version、adapterVersion、authenticationStatus、capabilities、evidenceRefs、
limitations。探测本身不登录、不创建任务、不夺取写入权。
能力值为 `unverified | supported | unsupported`，不能以配置 true 替代真实证据。

| 必需能力 | 通过条件 |
| --- | --- |
| isolatedSessions | 不同 Courier 会话绑定独立的 Harness 会话及执行上下文 |
| createAndResume | 可创建 Harness 会话；正常 Courier 重启后 load 原 Harness 会话并续接 |
| writerOwnership | Courier 独占实际 Harness 会话；可区分可写、冲突与未知，冲突不强占；关闭自有连接后能按原引用恢复。不要求接管桌面已有用户会话 |
| timelySteer | 在声明的运行状态（包括等待人工输入）中影响当前任务后续工作；非排队、非取消后重启 |
| inputCorrelation | 能将 start/steer/answer 的确认与本地操作、原任务关联，区分未知结果 |
| explicitCompletion | 有可靠完成/失败证据，独立于流结束和可见文本 |
| typedVisibleOutput | 明确 progress/final 等展示语义；内部思考不能作为进度转发 |
| messageAssembly | 消息边界和片段归属可靠，正常重复正文不会被删除 |
| humanInteraction | 原任务的问题、批准、拒绝可完整往返；撤销和失效可辨识 |

可选能力为 `inspectOperation`、`replayEvents`、`serverIdempotency`，各自须有证据；
没有这些能力时保留 unknown 并停止重放，不影响该限制分支的正确性。
所有必需能力都验证通过才可声明适配器满足本规格；仅历史续接实验不能满足该条件。

## 操作端口

| 操作 | 输入 | 结果与约束 |
| --- | --- | --- |
| probe | instanceId | 无副作用探测，返回上述能力报告 |
| createSession | operationId, courierSessionId | 返回新 sessionRef 或明确拒绝/未知；初次创建预留必须持久化 |
| resumeSession | operationId, sessionRef | 仅恢复指定原 Harness 会话，返回可用性/写入权；不得替换 |
| start | operationId, inputId, sessionRef, text, clientRunId | 注册本轮命令；接收确认及运行事件异步返回，不等待整轮完成才释放路由 |
| steer | operationId, inputId, sessionRef, expectedRunRef, text | 必须指向活动原任务；接收确认不代表实际消费 |
| answer | operationId, inputId, sessionRef, runRef, vendorRequestId, answer | 只转交该请求的文本或明确决定，不新增角色判定 |
| subscribe | sessionRef, verifiedCursor? | 长期事件订阅；游标恢复仅在已验证 replayEvents 时使用 |
| inspect | sessionRef, operationId?, runRef?, vendorRequestId? | 只读核实；unsupported/unknown 是有效结果，不能据此推导未执行 |
| disconnect | instanceId | 关闭 Courier 自己的连接；不取消任务或关闭桌面客户端 |

每个修改操作快速返回本地 command handle；其 receipt 异步解析为：

- `accepted`：包含可靠的 Harness 会话、运行任务和原请求关联与 receiptEvidence；不代表执行完成或 steer 已生效。
- `rejected`：包含 errorCode、`definitelyNotAccepted=true` 和安全说明；没有该证明不能返回 rejected。
- `unknown`：保留原关联和安全原因，不能重试为新操作。

传输写入成功只更新本地派发状态。若底层 `session/prompt` 直到整轮结束才返回，
不得等这个响应才开放处理其他输入；只有可靠且有任务关联的通知可提前证明原任务已接收。
若无法确定原活动任务，新的输入报告真实关联阻塞，不暗中缓存至下一轮。
网络层和 SDK 必须关闭对修改操作的隐式自动重试。

`answer` 的权限值为 `decision=approve|deny` 及对应 vendorOptionId（如平台需要）；
批准范围只能是用户看到并确认的选项。多种批准范围必须让用户明确选择，不能默认“始终允许”。

答复数据使用明确联合类型：`{kind:text, text}`、`{kind:form, values}` 或
`{kind:permission, decision, optionCode?}`。表单 values 为字段编号到字符串或字符串数组的映射。
question 请求必须提供 `answerSchema={mode:text|form, fields?}`；form 的每个字段含
`fieldId, label, required, valueType=text|choice|choices, options?`，选项含公开 code 与 label。
choice 只接受一个有效选项码，choices 接受不重复的有效码数组；文本不被解释为权限决定。
适配器持久保留公开字段/选项到厂商原请求的映射，权限的 optionCode 也仅映射到原允许选项。
缺字段、未知字段、类型或选项不符时先澄清，不提交；重启后使用保存的原模式与映射。
请求模式一旦改变，必须失效旧请求并生成新关联，不能重新解释旧答复。

## 归一化事件

公共信封：`schemaVersion=1, eventKey, sessionRef, runRef, sourceSequence?, occurredAt?, payload`。
adapter 为 source 字段提供经验证的身份语义；不能在每次收到重投时随机生成新 eventKey。
控制事件与展示消息分开，不支持的内部事件仅记录类型限制而不输出私有正文。

| eventType | payload 的必要字段 | 语义 |
| --- | --- | --- |
| input.accepted | operationId, inputId, receiptEvidence | 首次/steer/人工答复接收，不等于实际生效 |
| input.applied | inputId, appliedEvidence | 可选；只有可证明实际应用才发出，不用本地发送时间伪造 |
| run.started | clientRunId, runRef | 原任务开始 |
| run.waiting_input | requestIds | 更新等待集合，不阻止受支持的 steer |
| message.started | messageId, kind, userVisible, logicalOrder | 为一个逻辑消息建立顺序；kind 须有厂商语义依据 |
| message.fragment | messageId, fragmentKey, fragmentIndex, text | 字符片段，不能直接变成一条平台消息 |
| message.completed | messageId, finalFragmentIndex | 明确逻辑消息边界；缺失片段不能静默截断 |
| input.requested | vendorRequestId, kind, messageId, answerSchema?, options?, adapterMappingRef | 问题须有 answerSchema；messageId 持久保存为 PendingInput.sourceMessageId，与同 Run 的 OutputMessage.sourceMessageId 一一关联；正文使用该逻辑消息，不重复创建两条投递 |
| input.invalidated | vendorRequestId, reason=withdrawn|expired | 原请求失效，不能继续提交旧决定 |
| run.completed | completionEvidence, stopReason | 可靠执行终态，不能由 final 文本代替 |
| run.failed | errorCode, safeReason, completionEvidence | 已确认失败；保留已投递输出 |
| connection.lost | unresolvedOperationIds | 仅说明连接中断，不是完成或明确失败 |

厂商直接提供完整逻辑消息时，适配器可归一化成单片段及明确 completed；
只能在真实边界可靠时这么做。最终文本先到而完成信号未到，任务仍在运行或待核实。
权限/问题关联要先于其用户可见投递提交；重播 input.requested 不重复提示同一请求。
input.requested 与关联正文可先后到达，但正文完整且原请求映射落盘后才创建一条请求正文投递。
同请求换 messageId、同消息换原请求或绑定/Run/类型冲突均拒绝映射并报告协议限制；
适配器不得用“当前最近问题”修补。请求事件先落盘而正文未完成时重启，必须使用保存的
sourceMessageId、编号和片段恢复关联；只有可靠重放能补齐缺失内容，不能新造请求或重复提示。
fragmentIndex 归一化为从 0 连续递增；finalFragmentIndex=N 时须收齐 0..N，空消息 N=-1。
同片段键的序号/内容改变或同序号出现不同键均为协议错误，不能用正文消重解决。
允许乱序到达再组装，但不能用到达次序给重投生成新序号；重映射必须保留厂商可验证的身份关系。

## steer 与完成竞态

1. 用原 Harness 绑定与运行任务的 revision 和原 runRef 登记操作，再释放短锁调用 steer。
2. 若原任务已结束且 Harness 明确未接收，记录 rejected/stale_run；
   不以 start 重新提交该条、不另开 Harness 会话、不要求正常运行中的所有用户消息稍后重发。
3. 若已接收，保持同一 Run，不因客户端稍后看到终态而再提交。
4. 若接收未知，先核实；新的普通输入无法安全转交时记录具体阻塞，不构建输入恢复队列。
5. 人工答复不与普通 steer 共用“当前最近请求”推断；其原请求在并发 steer 中失效时明确拒绝。

## 错误契约

稳定错误码包括 `unconfigured`、`auth_required`、`resume_unsupported`、`session_missing`、
`writer_occupied`、`capability_unverified`、`steer_unsupported`、`steer_rejected`、`stale_run`、
`request_invalid`、`interaction_blocked`、`output_unsupported`、`state_unknown`。
每项包含输入是否明确未接收/已接收/未知、安全原因和下一步；
不把底层 exception、路径、凭据、其他 Harness 会话内容或运行端点直接发给用户。

写入权恢复只允许在原 sessionRef 上继续；首版不提供强制抢占或关闭其他客户端的方法。
桌面仅提供独立的空白启动宿主 H，不能把 H 绑定为用户上下文。Courier 创建并持有 A/B 等实际 Harness 会话；宿主可以按已验证生命周期更换，但原 A/B 及其三层关联不变。其他客户端意外持有 A/B 时，仍返回写入权冲突，不创建替代上下文。 自动模式仅在持久进程身份确认旧后端已结束后创建新空白宿主；端点不可达、身份未知或创建结果不明均不能触发重复创建。预热进程须由准确 PID/宿主注册记录及其实际 socket 共同证明归属。
普通输入不支持或失效为真实错误，不能发送例行“忙碌，请等待”回执来代替转交。

## WorkBuddy 实验映射

候选基础为 ACP `initialize/session/new/session/load/session/prompt/session/update`；
运行期间输入候选为包内 `session/steer`，映射 `expectedRunRef → expectedRequestId`，
`inputId → clientUserMessageId`。后者仅相关标识，不承诺幂等。
人工答复候选包括标准权限响应及内部 `_codebuddy.ai/resolveInterruption`，不得混淆传输请求 ID
和持久请求 ID；问答、权限选项和重连后有效性都必须真实验证。

当前 CLI 的标准 session/request_permission 顶层 _meta 中 codebuddy.ai/requestId 是 Harness 权限请求自身的独立相关标识，不是 Run 标识或 JSON-RPC 的 id；interruption 广播也可不带 Run 字段。关联必须来自原 Run 的已核实工具 ID、工具名和完整输入，不能凭当前活动任务或该权限相关标识猜测。独立一次批准探测另要求原生 toolArgumentsComplete=true；增量参数本身不授权。经操作者单次明确授权的 153 帧往返已观察原决定接收、原工具/消息完成和原 Run end_turn，仍不代表完整人工能力，见 verification/formatter-permission-2026-11-06.md（相对功能目录）。

运行发现和激活接口尚无受支持生产契约。实验入口只能通过操作者正常配置/公开流程获得，
不得提取进程内存或环境中的凭据。诊断实验如果后续使用本机调试端点，必须单独记录实验范围并结束后关闭。
静态方法存在不授予 supported 状态，也不为不可靠消息分类/片段补造证据。

### WorkBuddy 专用上下文连接组件

内部 contextSessionRef 只允许连接已有 Courier 归属的实际 Harness 会话；不创建用户上下文、不激活宿主或接管其他客户端。首次 load 原 A 后，显式 default 模式需从原生 configOptions 确认，配置未知时保留意图并阻止再次修改；缺失/冲突/未就绪不派发用户输入。组件角色进入证据指纹，不能把子连接当成完整 Harness 实例能力或真实服务组合已完成。

普通独占组合使用 ManagedWorkBuddy 实现完整 HarnessPort：管理连接仅初始化 H、创建 A/B，并在各自专用连接 load 前释放自己的连接；每个实际 Harness 会话保持独立连接，事件、steer 和人工答案只沿原引用转发。创建连接的短时串行控制不覆盖 Agent 运行期间，不阻塞其他上下文的运行或答案。关闭只释放本应用的连接，不取消任务、销毁后端或夺取外来写入权。

组合层持久记录创建归属、操作关联和各原 Run 的接收/终态事实；同一 operationId 重复调用不再次执行，同文不同 inputId 保持独立。创建、加载、运行或配置结果未知时保留原事实，不以新上下文或自动重发继续。重建时只有已确认空闲的原上下文允许重新 load。可选操作查询、事件重放和服务端幂等能力明确 unsupported；组合角色及实现内容另行绑定证据指纹，必需能力继续以真实证据准入。

自动模式按 Courier 会话隔离后端：各自的空白宿主生命周期记录分区，原实际 Harness 引用及归属仍在实例内唯一关联。A 等待人工答案时，B 的激活和运行不得改动 A 的后端状态。已知隔离路由缺失/损坏时停止，不能退回共享宿主；此前共享宿主上的原上下文保留原路径，不静默迁移。固定宿主模式不声明该隔离能力；自动/固定及后端隔离策略参与证据指纹。
