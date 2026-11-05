# 数据模型与状态转换

**状态**：领域与持久化契约，已按此建立 SQLite 迁移并验证离线行为；真实能力尚未准入。字段使用英文，解释使用中文。
所有 ID 为不透明字符串；本地 ID 使用随机 UUID，不依赖正文、用户名或路径生成。
时间保存 UTC 时间戳，另以数据库分配的序号排序，不能用时间戳代替消息身份。

术语遵循 [术语与命名](../../README.md#术语与命名)。CourierSession 保存本地路由与策略，
HarnessBinding 保存到 Harness 实例及 Harness 会话的绑定；它们不构成 Courier 自有的 Agent 执行上下文。

## 标识所属层

| 字段或引用 | 归属与含义 |
| --- | --- |
| PlatformConversation.id | Courier 本地的平台会话记录 ID |
| PlatformConversation.platformConversationId / Recipient.platformConversationId | 平台提供的原始会话标识；钉钉适配器中来自 conversationId，须与平台范围及机器人共同解释 |
| CourierSession.platformConversationId / InboundInput.platformConversationId / PendingInput.platformConversationId | 指向本地 PlatformConversation.id，不能直接填入钉钉原始 conversationId |
| CourierSession.id / HarnessBinding.courierSessionId | 本地 Courier 会话 ID；后者引用前者 |
| HarnessBinding.harnessSessionId | 指定 Harness 实例内的 Harness 会话标识；不是 CourierSession.id |
| Run.id / Run.harnessRunRef | 前者为 Courier 的运行记录 ID，后者为 Harness 的运行标识；一条 Harness 会话可先后承载多个 Run |

保留现有字段名；描述和引用时使用限定到实体的名称，不能因字段末尾同为 SessionId 或 ConversationId 就混用。

## 实体与关系

| 实体 | 主要字段 | 关系与验证规则 |
| --- | --- | --- |
| PlatformIdentity | id, platformScope, robotId, senderId, enterpriseUserId? | 来源身份单独记录；enterpriseUserId 必须来自验证过的映射，不将 senderId 当企业 userId；不用于新增答复者权限模型 |
| Recipient | id, platformScope, robotId, platformConversationId, privateUserRef? | 只代表原私聊接收范围；绑定后不可因投递失败换成其他目标 |
| PlatformConversation | id, platformScope, robotId, platformConversationId, type=private, recipientId | UNIQUE(platformScope, robotId, platformConversationId)；群消息不建立此记录 |
| CourierSession | id, platformConversationId, harnessInstanceId, policyRevision, nextInputSequence, nextDeliverySequence, revision | 每个平台私聊一个；配置 Harness 后不提供聊天切换或迁移 |
| HarnessInstance | id, adapterKind, productVersion, cliVersion?, capabilityEvidenceId, readiness | 配置目标与运行发现分离；真实端点不能作为长期实例 ID |
| HarnessBinding | id, courierSessionId, harnessInstanceId, harnessSessionId?, status, createOperationId, revision | 每个 CourierSession 只有一个绑定；已建立时 UNIQUE(harnessInstanceId, harnessSessionId)，防止跨私聊共用上下文 |
| CapabilityEvidence | id, kind, adapterVersion, productVersion, scope, contextFingerprint, checkedAt, expiresAt?, invalidatedAt?, outcome, evidenceRef | outcome=unverified/passed/failed；scope 含状态与限制覆盖；有效性另按版本、上下文、期限与撤销判定，配置声明本身不是通过证据 |
| InboundInput | id, dedupNamespace, originalMessageId, platformConversationId, identityId, receivedSequence, textRef, mode, runId?, pendingInputId?, status, acceptedAt?, appliedEvidenceRef?, errorCode? | UNIQUE(dedupNamespace, originalMessageId)；命名空间必须经 V-05 验证；mode=start/steer/answer/invalid；相同正文新 ID 保留 |
| InboundReceipt | id, inputId?, transportMessageId, receivedAt, ackStatus | 保留推送尝试与业务输入的区别；重投只关联原输入；群消息只计匿名统计，不保存正文 |
| HarnessOperation | id, bindingId, inputId?, runId?, pendingInputId?, kind, expectedRunRef?, status, startedAt?, resultCode?, evidenceRef? | kind=create/load/start/steer/answer；对外调用前保存意图；operationId 不自动具有远端幂等性 |
| Run | id, courierSessionId, bindingId, initialInputId, harnessRunRef?, status, revision, policySnapshot, completionEvidenceRef?, startedAt?, finishedAt? | 每个 Courier 会话最多一个未决任务；steer 关联同一 Run；终态与投递状态无关 |
| PendingInput | id, runId, bindingId, platformConversationId, vendorRequestId, sourceMessageId, kind, publicCode, promptRef?, answerSchema?, options?, adapterMappingRef, validity, answerStatus, answerInputId?, revision | kind=question/permission；UNIQUE(bindingId, runId, vendorRequestId) 及 UNIQUE(runId, sourceMessageId)；publicCode 在同私聊历史范围不复用；原消息关联、问题字段模式与选项映射持久化，重启不重新猜测 |
| HarnessEvent | id, bindingId, runId, sourceEventKey, eventType, sequence?, payloadRef, processedAt | sourceEventKey 必须有可靠来源；无可靠重投标识时不能声称可以恢复重放整个流 |
| OutputMessage | id, runId, sourceMessageId, kind, userVisible, logicalSequence, completeness, selected, hiddenReason?, contentRef | UNIQUE(runId, sourceMessageId)；kind=progress/final/question/permission_request/error/message/tool_status/artifact；未知类型仅安全诊断 |
| OutputFragment | id, outputMessageId, sourceFragmentKey, fragmentIndex, textRef | UNIQUE(outputMessageId, sourceFragmentKey) 及 UNIQUE(outputMessageId, fragmentIndex)；从 0 连续编号，键/序号/内容不一致是协议冲突；相同正文不同片段保留 |
| OutboundDelivery | id, recipientId, runId?, inputId?, pendingInputId?, logicalMessageIds, deliverySequence, payloadRef, status, attemptCount, nextAttemptAt?, errorCode? | UNIQUE(recipientId, deliverySequence)；runId/inputId 至少一个且接收范围一致；消息内容/目标一经尝试即不可修改；系统限制提示可无 Run，须关联 inputId |
| DeliveryAttempt | id, deliveryId, attemptNo, routeId, startedAt, outcome, providerReceiptRef?, errorCode? | UNIQUE(deliveryId, attemptNo)，最多三次自动尝试；路由变化不重置预算 |
| DeliveryRoute | id, recipientId, kind, sensitiveCapabilityRef?, expiresAt?, verifiedLimits, capabilityEvidenceId, status | kind=sessionWebhook/oto；替代路径必须证明同原私聊；真实 URL 和密钥不进入共享记录 |

`textRef/contentRef/payloadRef` 指向本地私有存储中的正文，可与所属行同库保存；不是远端文件地址。
普通日志只记录本地关联 ID 和安全错误码，不输出正文、真实平台标识、路径或 URL。
共享导出将本地关联 ID 再映射为临时别名，避免把真实平台身份带出。

## 能力证据有效性

`outcome` 保存实验结果，不等于当前仍可使用。只有 passed、所需 scope 全部覆盖、
adapterVersion/productVersion 与当前目标一致、contextFingerprint 匹配、invalidatedAt 为空，
且 `checkedAt <= now`、`expiresAt` 为空或 `now < expiresAt` 时，才可用该证据准入。
无法核实当前版本或上下文时不能当作匹配；fake 证据只适用于 fake。

contextFingerprint 是以下验证上下文的规范 JSON（递归按键排序、集合排序去重）的 SHA-256：
`targetRef, cliVersion, transportKind, authorizationScope, limitProfile`。
targetRef 使用本地 HarnessInstance ID 或平台 scope/robot 的本地引用组合；
authorizationScope 是经正常接口或验证记录确认的权限集合，limitProfile 是已验证限额及规则。
不适用的项显式为 null；无法确认的适用项不能填 null 冒充匹配。
上下文原值只放私有证据，不能含凭据、运行端点或机器路径；共享材料对指纹也使用临时别名。
切换目标、CLI 版本、传输方式、授权范围或限额规则必须重新匹配；展示策略、日志设置、
同身份凭据轮换及临时 webhook 地址变化本身不改变该指纹，仍须检查当前认证与路由有效性。

expiresAt 若存在，必须晚于 checkedAt，且 evidenceRef 记录其来源：已知证据期限或操作者明确指定的复核期限。
没有明确期限就省略 expiresAt，首版不设置默认天数；checkedAt 不是隐含 TTL。
已确认回归或证据被撤销时写入 invalidatedAt，此后不能清空来恢复准入。
已登记记录的验证上下文、结果及 checkedAt/expiresAt 不可修改；invalidatedAt 只允许从空变为撤销时间。
到期、撤销或上下文不匹配时保留原证据，重新验证受影响的 scope 并生成新记录；
仅改时间戳、配置布尔值或重启服务不能延长或恢复证据。
每次启动、重连、配置重载及相关新副作用开始前检查有效性；当前认证/能力探测仍须通过。
证据失效只阻止受影响的新操作并报告限制，不改写既有执行事实、不取消任务或自动回答人工请求。

## 展示策略

`Run.policySnapshot` 包含 revision、progress、final、question、permissionRequest、error、
message、toolStatus、artifact、mergeAdjacentProgress。
默认 progress/final/question/permissionRequest/error=true，message/toolStatus/artifact=false，
mergeAdjacentProgress=false。扩展类型仅在适配器明确提供用户可见语义时可开启。
question 或 permissionRequest=false 为无效配置；error 默认 true，关闭只影响 Harness 展示事件，
必要的 Courier 故障、限制和交互阻塞提示仍须保留。

首轮 `received` 时为预留 Run 固定快照，后续 steer 不改变它；新一轮使用当前配置。
过滤不删除状态事件或人工请求。主动隐藏 final 不触发“无可交付内容”错误；
只有本轮按开启的策略本应有最终回答、却未产生可交付内容时才报告该限制。

## 状态转换

### 绑定与操作

- Binding：`reserved → creating → ready`；明确失败为 `blocked`，创建结果未知为 `unknown`。
  已知 Harness 会话 ID 不清空；`ready → unavailable/writer_conflict/unknown` 后只能恢复原绑定。
  查询证据证明原 Harness 会话仍可用才回到 ready；不自动创建替代 Harness 会话。
- Operation：`prepared → dispatching → accepted | rejected | unknown`。
  每次调用在 dispatching 落盘后才开始网络请求；超时/断连/进程中断不推导 rejected。
  unknown 仅凭权威查询变为 accepted/rejected；没有核实手段就保持 unknown。
  已核实未接收时也不自动重排旧普通输入；首版不提供人工“强制重放”入口。

### 入站输入与任务

- Input：`received → dispatching → accepted | rejected | unknown`。
  前置检查失败可 `received → rejected`；错误码说明未提交原因。
  received 记录不是工作队列；重启遗留的未派发输入记录 `rejected/recovery_interrupted`，
  不在之后自动执行。若本地无法证明未派发，则标 unknown。
- accepted 只表示对方接收。steer 的实际应用记录 `appliedEvidenceRef`，不能由接收时间补造。
- Run：`submitting → running ↔ waiting_input → completed | failed`；
  活动状态因失联可进入 `unknown`，仅在可靠核实后恢复活动或进入终态。
  初始提交明确未接收为 `not_started`，不能标成 Agent 执行失败。
  `submitting/running/waiting_input/unknown` 均占用该 Courier 会话唯一活动槽。
- `waiting_input` 仍允许受验证支持的 steer。有效人工答复优先转交；
  一个请求被答复不代表全部请求完成，须按仍有效的待答集合与 Harness 状态归约。
- 最终文本可以早于 completed；连接关闭、无可见输出或全部过滤不能产生终态。
  completed/failed 必须带权威完成依据；已发送内容不因后续失败撤销。
  任务终态后仍可处理带可靠归属的尾部片段，不丢弃已经开始的逻辑消息。

### 人工请求

- PendingInput.sourceMessageId 必填，原样保存 input.requested.messageId；与 OutputMessage
  以 `(runId, sourceMessageId)` 关联，一条请求正文只归属一个原请求，且绑定、Run 必须一致；
  请求类型 question 对应消息 question，permission 对应 permission_request。
  允许请求先到、OutputMessage 尚不存在：先持久保存映射，不伪造 message.started 或消息顺序。
  此时 promptRef 可空；正文完整后取关联 OutputMessage.contentRef，未取得正文引用不能投递请求。
  也允许正文先完整到达：question/permission_request 在原请求映射落盘前不得创建投递。
  两者齐备后，在 T4 中复用原编号并至多创建一条请求正文 OutboundDelivery，记录 pendingInputId
  与原 logicalMessageIds；重试复用该投递。重复事件不再分配编号或创建投递。
  同一原请求改指其他消息，或同一消息被另一请求占用，均为协议冲突，停止相关投递并报告限制。
  重启直接读取持久映射和已保存片段继续组装；只有经验证可重放的缺失事件才可补齐，
  不依赖“最近问题”或重新扫描历史猜测关系；正文无法补齐时保留请求并报告交互阻塞，不提交答案。
- `validity=open | withdrawn | expired | closed_by_run` 与
  `answerStatus=none | dispatching | accepted | rejected | unknown` 分开保存。
- 对 open 请求的第一条有效显式回答，以事务预留 answerInputId 后提交一次；
  重复业务消息、重复决定或其他私聊请求不再调用 Harness。
- rejected 且明确未接收时可接受用户随后发来的新答复；unknown 时不能再次提交决定。
  用户文字不自动改变 validity；Harness 的明确撤销、过期或可靠终态才能使其失效。
- 同时发生 steer 撤销与答复时，用请求 revision 和权威结果处理竞态；
  stale 拒绝如实记录，不把同意转给新请求。Courier 不自设超时答案或默认授权。
- question 的 answerSchema 与字段、选项的 adapterMappingRef 保存原始不可变映射，
  text/form/permission 答复结构见 Harness 契约；原请求字段发生变化时应由适配器显式撤销旧请求并建立新请求，
  不能用新模式解释已经收到的旧决定。

### 输出与投递

- Message completeness：`assembling → complete | invalid`。需要明确消息边界和完整片段序列，
  不能靠静默超时封口。可靠重投只消除重复片段身份，不消除正常重复文字。
  控制状态不依赖完整消息拼装；例如问题先登记关联，正文完整后才投递。
- fragmentIndex 从 0 开始，completed 给出最后索引 N，完整集合必须为 0..N；
  空消息用 N=-1 且不得有片段。同键不同序号/内容、同序号不同键均为协议冲突。
  相同键、序号和内容的重复才可忽略；厂商原序号重映射也须保留可靠身份，不能仅按接收顺序重编号。
- `logicalSequence` 在逻辑消息开始时分配，后来的完成消息不能越过较早未封口消息；
  协议已证明片段缺失或任务终态后无法补齐则标 invalid、记录限制并放行后续完整消息。
  不能把缺片段的文本当完整回答发送。
- Delivery：`pending → sending → delivered | retry_wait | failed | unknown`；
  `retry_wait → sending` 仅用于确认未投递且可重试的结果；最多三次尝试。
  权限失效、超长、无可用路径等不进入盲目重试。
- `delivered` 表示平台确认接收成功，不代表用户已读。unknown 保留可能已投递的事实，
  暂停该私聊后续出站直至核实；其他私聊、输入和人工控制仍可工作。
  若提示也无法投递，只保留本地可查阻塞，不声称用户已获知。
- unknown 经权威确认已投递转 delivered；确认未投递且为可重试失败、原预算仍有剩余时转 retry_wait，
  原预算耗尽或不可重试时转 failed；无法核实则保持 unknown。
  核实成功解除对应顺序阻塞，核实、重启和换路径均不重置 attemptCount。
- 明确失败耗尽预算后标 failed，后续消息可继续；合并一条安全缺失提示，不递归生成无限错误提示。
  路径失效的 pending 消息可保留待同目标已验证路径恢复，但原任务不重跑。
- 相邻进度合并只作用于尚未创建发送尝试的完整 progress；保留有序的 logicalMessageIds，
  不跨 final、问题、权限或错误合并，不改变已经发送的消息。

## 事务边界与不变量

1. **T1 入站**：私聊唯一映射/接收人校验、可靠去重记录和必要限制提示 outbox 原子提交，再 ACK。
   同 ID 不同正文属于异常，不视为新输入；保留原记录并安全诊断。不能修复成正文去重。
2. **T2 转交准备**：读取最新绑定/任务 revision，预留 Run 或 PendingInput，写 Operation 和 input 状态。
   提交事务并释放短锁后才调用网络；等待整轮输出不能占住同一 Courier 会话的锁。
3. **T3 接收确认**：将 Operation、Input、Run 的确认一起保存；事件先于确认到达时按已登记关联归并。
   无法可靠关联的事件不能猜给“当前”任务，记录适配限制。
   晚到 accepted 只补充接收事实，不能把 completed/failed 回退为 running，
   不能重开 withdrawn/expired/closed_by_run 请求；重复终态为幂等归约。
   相互矛盾的权威证据记录协议异常并停止新的相关副作用，不静默用最后到达者覆盖。
4. **T4 事件**：事件重投识别、Run/PendingInput 更新、片段、过滤决定、outbox 创建和消费游标一起提交。
   请求的 sourceMessageId 映射与编号一并落盘；请求正文投递的唯一性也在该事务内校验。
   历史恢复只用于核实和已验证的事件重放，不重新执行输入；不能因 history 有问答就推导任务完成。
5. **T5 投递**：先登记 DeliveryAttempt 并将消息设 sending，事务外发送，再事务保存结果。
   启动时将遗留 sending 转 unknown；不能像 pending 一样自动发送。
6. 不在 ACK 前遗失已接受输入；数据库不可用时不提交 Harness。
   同机只允许一个 Courier 工作进程使用该状态库，status 使用只读方式。
   会更新核实结果的 reconcile 只能在服务停止后取得同一生命周期互斥锁执行。

## 恢复、保留与隐私

正常停止后恢复原绑定、策略及明确任务终态，下一轮仅 load 原 Harness 会话。
数据库损坏或关联不完整时停止相关路由，输出安全原因，不删库重建冒充恢复。
运行中不能自动判断的输入、人工答复和发送均保留 unknown，且后续无法安全处理的输入明确失败。

首版不自动删除去重键、请求编号、操作确认和三层会话映射；否则旧消息重投可能再次执行。
清理正文可另行设计，但必须保留必要 tombstone，不能清理成可重放状态。
状态库/日志/备份均为本地私有材料，目录限制为当前运行账号访问且不进入 Git。
备份必须使用 SQLite 一致性备份方式；不能单独复制活动数据库而漏掉 WAL。
原始平台 token、sessionWebhook、登录材料通过敏感存储引用访问，不作为共享数据模型示例值。
