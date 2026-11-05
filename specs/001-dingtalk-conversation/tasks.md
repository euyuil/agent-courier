# 任务清单：通过钉钉机器人与指定 Harness 持续对话

**日期**：2026-11-05 | **当前分支**：`main` | **状态**：任务拆解完成，全部任务尚未执行。

**输入**：[spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、
[data-model.md](data-model.md)、[quickstart.md](quickstart.md)、
[Harness 契约](contracts/harness-adapter.md)、[平台契约](contracts/dingtalk.md)、
[配置契约](contracts/configuration.md)与[项目原则](../../.specify/memory/constitution.md)。

**测试依据**：规格明确要求各故事的独立验证、37 个验收场景及 SC-001 至 SC-009，
因此本清单包含有行为断言的契约、集成和必要单元测试任务。
各故事先编写其测试区段并确认其暴露缺失行为，再实现该故事；缺模块/导入错误不算有效的行为失败证据。
当前仓库无应用命令，只有 T001 完成后才引用实际 package.json 中经验证的命令。

## 格式与路径约定

- 每个任务为 `- [ ] T编号 [P可选] [US编号可选] 描述及文件路径`；编号唯一且连续。
- `[P]` 只表示满足所列前置依赖后，可以与同批不同文件的任务并行，不授权跳过依赖。
- Setup、Foundational 与最终阶段不加故事标签；故事阶段必须带对应 US 标签。
- 路径均相对仓库根目录；新增源码/测试/verification 路径是未来任务产物，本次只创建本清单。
- 模型任务在描述内逐字引用原字段和约束；字段名后的 `?` 保持可空/可缺省，
  其余字段必填，不擅加长度/额度常数。外键和跨字段约束也必须落实到事务或数据库校验。
- 任务完成需有实际产物/验证结果。真实实验不能运行时，记录 blocked/not_tested 并保持任务未勾选。
  阶段中的“离线核心检查点”不等于该阶段全部真实任务完成。
- 本次不实现应用、不运行真实实验、不安装依赖、不提交或推送；此清单也不新增发布/部署授权。

## 真实能力门槛

| 门槛 | 证据任务 | 适用工作与失败处理 |
| --- | --- | --- |
| G-H | T031 | WorkBuddy 当前目标的正常认证/发现/激活、原会话、写入权、运行中 timely steer、可靠关联和完成语义；不满足就阻塞真实适配，核心 fake 工作可继续 |
| G-H-INTERACTION | T031 的 V-04 子项 | 原问题/权限的答复、批准、拒绝及撤销/未知；无证据不启用真实人工交互 |
| G-H-OUTPUT | T031 的 V-03/V-05 输出子项 | 明确用户可见类型、消息/片段身份和完成边界；不能用文字猜测补齐 |
| G-D | T032 | 真实私聊接入、可靠原消息身份、适用限额与多消息发送；无依据不启用真实平台支持 |
| G-D-OTO | T032 的 V-02 子项 | 只有同原私聊且授权/企业用户映射已验证才启用 OTO；也可实现已证不可用的限制分支，此时必须明确不支持备用路径 |
| G-INTEGRATION | G-H、G-H-INTERACTION、G-H-OUTPUT、G-D、G-D-OTO 及已完成的 T075 | 仅用于 T077 的真实执行准入；完整真实适配已组合且对应测试操作获授权，G-D-OTO 仍允许已证不可用的限制分支；不作为 T075 的前置条件 |

T031/T032 是独立、显式启用的最小探测工具，避免“先启用受支持适配器才能验证其能力”的循环；
它们只使用正常配置与获准测试范围，不提供日常服务入口。V-05 的可选查询不支持时，
unknown/停止重放是正确限制；V-02 无备用路径时按 US2-9 验收限制分支，不假装支持该路径。
T075 只组合已满足各适配器门槛的入口；其完成后才可满足 G-INTEGRATION 并进入 T077。
所有用户故事仍属完整功能范围，P2 不表示可省略。


## Phase 1：Setup — 项目初始化

**目标**：建立单包项目和离线验证入口；本阶段才会产生应用依赖与实际构建/测试命令。

- [ ] T001 在 `package.json`、`package-lock.json` 固定 Node.js 24 LTS、兼容的 TypeScript（≥5.5）、Zod 4、dingtalk-stream、better-sqlite3 及必要类型依赖，配置真实可执行的编译、类型检查和 Node 内置测试脚本；核查驱动内嵌 SQLite ≥3.51.3，不加入 ORM、Web 框架、模型 SDK 或消息代理。 依赖：无。

- [ ] T002 [P] 在 `tsconfig.json`、`tsconfig.test.json` 配置严格模式与明确的源码/测试输出边界，按 plan 的单包目录布局处理 ESM 导入；产物不写入源码目录，验证 T001 实际脚本可编译测试。 依赖：T001。

- [ ] T003 [P] 更新 `.gitignore`，忽略编译产物、依赖、运行状态库/WAL/锁库、私有配置及真实验收原始材料；仅保留脱敏配置样例和合成 fixtures，验证已有 Spec Kit 共享文件规则不被覆盖。 依赖：T001。

- [ ] T004 [P] 在 `tests/fixtures/clock.ts`、`tests/fixtures/faults.ts` 建立虚拟时钟、可观察执行屏障与崩溃注入控制，所有正文和身份使用合成值；不得连接真实账号。 依赖：T001。


**检查点**：依赖已锁定，类型检查和空测试发现可运行；尚无产品能力。


## Phase 2：Foundational — 共享基础

**目标**：完成所有用户故事共同依赖的端口、持久基础、配置和测试适配器；真实能力实验不作为离线核心工作的阻塞条件。

- [ ] T005 在 `src/domain/common.ts` 定义不透明 ID、时间和序号基础类型；落实原文“所有 ID 为不透明字符串；本地 ID 使用随机 UUID，不依赖正文、用户名或路径生成。”及“时间保存 UTC 时间戳，另以数据库分配的序号排序，不能用时间戳代替消息身份。”，不把平台 ID 与本地 ID 混用。 依赖：T002、T003、T004。

- [ ] T006 [P] 在 `src/adapters/harness/port.ts`、`src/adapters/harness/events.ts` 定义契约 v1 的 probe/createSession/resumeSession/start/steer/answer/subscribe/inspect/disconnect、快速 command handle、accepted/rejected/unknown 及全部归一化事件；rejected 必须有 definitelyNotAccepted=true，能力值严格为 unverified/supported/unsupported。 依赖：T005。

- [ ] T007 [P] 在 `src/adapters/dingtalk/port.ts` 定义平台无关 NormalizedInbound、ACK、send 与 inspectDelivery 端口，保留 transportMessageId/originalMessageId 两种身份和原接收范围；发送结果严格为 confirmed/not_sent/unknown/route_unavailable，查询 unsupported 不等于未发送。 依赖：T005。

- [ ] T008 [P] 在 `src/config/schema.ts`、`src/config/load.ts`、`examples/config.example.json` 实现配置契约 v1：拒绝未知字段、schemaVersion≠1、重试上限>2及关闭人工消息；正常凭据引用与 Git 外相对配置路径可用，fake 模式不读取真实引用，默认实例变更不能迁移已有绑定。 依赖：T005。

- [ ] T009 [P] 在 `src/storage/database.ts`、`src/storage/migrate.ts` 建立 better-sqlite3 单写入连接、版本检查、外键、WAL/FULL 和按文件编号顺序执行的迁移；业务事务不跨 await/网络等待，拒绝已知网络文件系统与不可读/损坏数据库，不自动删库。 依赖：T005。

- [ ] T010 在 `src/domain/capabilities.ts`、`src/storage/migrations/001-capabilities.sql`、`src/storage/capabilities.ts` 建立 HarnessInstance 和 CapabilityEvidence 的完整模型、持久化与版本匹配查询；按数据模型“能力证据有效性”保存 contextFingerprint、明确期限和撤销事实，比较当前版本/上下文与 scope；缺失、失败、到期、撤销或不匹配均不能推导 supported，无明确期限时不自设 TTL，旧记录不能通过修改时间戳续期。 HarnessInstance 原文字段：`id, adapterKind, productVersion, cliVersion?, capabilityEvidenceId, readiness`；原文约束：“配置目标与运行发现分离；真实端点不能作为长期实例 ID”。 CapabilityEvidence 原文字段：`id, kind, adapterVersion, productVersion, scope, contextFingerprint, checkedAt, expiresAt?, invalidatedAt?, outcome, evidenceRef`；原文约束：“outcome=unverified/passed/failed；scope 含状态与限制覆盖；有效性另按版本、上下文、期限与撤销判定，配置声明本身不是通过证据”。 依赖：T006、T008、T009。

- [ ] T011 [P] 在 `src/domain/errors.ts`、`src/application/diagnostics.ts` 实现安全错误码、中文原因/执行事实/下一步模板及本地 ID 诊断；落实原文“普通日志只记录本地关联 ID 和安全错误码，不输出正文、真实平台标识、路径或 URL。”与“共享导出将本地关联 ID 再映射为临时别名，避免把真实平台身份带出。”，不直接转发底层异常。 依赖：T005。

- [ ] T012 在 `src/storage/instance-lock.ts` 实现独立锁文件数据库的生命周期排他事务，业务库仍只用短事务；二次 serve 拒绝启动、异常退出释放锁，status 只读；预留 reconcile 停服后取得同一锁的调用方式，不使用盲删 PID 锁恢复。 依赖：T009、T011。

- [ ] T013 [P] 在 `tests/fixtures/harness/fake-harness.ts`、`tests/fixtures/harness/scenarios.ts` 实现可计数 start/steer/answer、原运行内消费屏障、问题/权限、输出片段、完成及失败/未知事件；包含只能排队、不及时消费、writer_occupied、事件先于 receipt 的负面配置，不能用仅 ACK 伪造 steer 生效。 依赖：T006、T010、T012。

- [ ] T014 [P] 在 `tests/fixtures/platform/fake-platform.ts` 实现持久身份重投、同文本新消息、ACK 记录、按目标的可见投递记录、限额/过期和 confirmed/not_sent/unknown；提供带证据和不带证据的查询结果，测试预算不得冒充真实平台限额。 依赖：T007、T010、T012。

- [ ] T015 在 `tests/integration/foundation.test.ts`、`tests/contract/configuration.test.ts` 验证配置非法分支、正常凭据引用不被输出、数据库事务/迁移、二进程互斥、崩溃释放及 fake 不联网；按 T001 的实际脚本执行并修复到通过。 依赖：T008、T009、T010、T011、T012、T013、T014。

- [ ] T016 在 `src/adapters/harness/admission.ts`、`tests/contract/admission.test.ts` 检查全部必需能力及版本/状态覆盖，落实数据模型的统一有效性判定；以虚拟时钟验证无期限、到期边界、未来 checkedAt、非法期限、撤销、版本/上下文变化、无关配置变化及新证据只恢复其 scope；启动/重连/重载和每次相关新副作用前重新判断，不缓存永久 supported；probe 无登录/建任务/抢写副作用，模拟证据只准入 fake，inspectOperation/replayEvents/serverIdempotency 可缺失但必须保持 unknown 分支；不合及时 steer 的目标明确拒绝。 依赖：T006、T010、T013、T015。


**检查点**：T005–T016 完成后可进入故事实现；fake 模式独立运行且无外部连接，真实支持仍关闭。


## Phase 3：US1 — 一轮问答、上下文续接与及时 steer（P1）

**目标**：建立私聊的最小垂直链路，正常重启后续接原会话，运行中新输入在当前任务内生效。

**独立验证**：Q-01 至 Q-05：三轮同会话（含首轮后重启）、两个私聊隔离、群消息零动作；连续两条新输入在原 Run 完成前改变后续工作，相同文本的新消息也各一次；不合能力、拒绝和未知结果不排队回退。


### 测试任务

- [ ] T017 [P] [US1] 在 `tests/contract/harness-session.test.ts` 编写 create/load/start/steer/subscribe 的契约测试：接收与生效分离、快速 handle、不持锁等待整轮、expectedRunRef 失配、unknown 不重放及不支持/排队型目标拒绝；对应 US1-1、US1-2、US1-6、US1-7、US1-8。 依赖：T016。

- [ ] T018 [P] [US1] 在 `tests/contract/platform-ingress.test.ts` 编写平台范围校验、文本/空文本/附件、群及未知类型、ACK 与聊天回复分离的测试；缺可靠 ID 不执行，群在正文持久化前丢弃；对应 US1-3、US1-4、US1-5。 依赖：T016。

- [ ] T019 [P] [US1] 在 `tests/integration/conversation.test.ts` 编写 Q-01 至 Q-05 的独立用户旅程，用执行屏障观察两条 steer 在原任务内实际消费，验证三轮续接、正常重启、首次绑定竞争、上下文隔离和零忙时提示；记录 SC-001、SC-002、SC-009 的计数断言。 依赖：T016。


### 实施任务

- [ ] T020 [P] [US1] 在 `src/domain/platform.ts`、`src/storage/migrations/002-platform.sql`、`src/storage/platform.ts` 建立 PlatformIdentity、Recipient、PlatformConversation 模型与按完整私聊键原子查询/创建；字段与约束按下列原文落实，非可选字段持久化必填。 PlatformIdentity 原文字段：`id, platformScope, robotId, senderId, enterpriseUserId?`；原文约束：“来源身份单独记录；enterpriseUserId 必须来自验证过的映射，不将 senderId 当企业 userId；不用于新增答复者权限模型”。 Recipient 原文字段：`id, platformScope, robotId, platformConversationId, privateUserRef?`；原文约束：“只代表原私聊接收范围；绑定后不可因投递失败换成其他目标”。 PlatformConversation 原文字段：`id, platformScope, robotId, platformConversationId, type=private, recipientId`；原文约束：“UNIQUE(platformScope, robotId, platformConversationId)；群消息不建立此记录”。 依赖：T017、T018、T019。

- [ ] T021 [P] [US1] 在 `src/domain/session.ts`、`src/storage/migrations/003-sessions.sql`、`src/storage/sessions.ts` 建立 CourierSession 与 HarnessBinding 模型/仓储；绑定状态严格按“reserved → creating → ready”，明确失败 blocked、创建未知 unknown，已知 sessionId 不清空，unavailable/writer_conflict/unknown 只能恢复原绑定。 CourierSession 原文字段：`id, platformConversationId, harnessInstanceId, policyRevision, nextInputSequence, nextDeliverySequence, revision`；原文约束：“每个平台私聊一个；配置 Harness 后不提供聊天切换或迁移”。 HarnessBinding 原文字段：`id, courierSessionId, harnessInstanceId, harnessSessionId?, status, createOperationId, revision`；原文约束：“每个 CourierSession 只有一个绑定；已建立时 UNIQUE(harnessInstanceId, harnessSessionId)，防止跨私聊共用上下文”。 依赖：T017、T018、T019。

- [ ] T022 [P] [US1] 在 `src/domain/input.ts`、`src/storage/migrations/004-inputs.sql`、`src/storage/inputs.ts` 建立 InboundInput/InboundReceipt 模型与唯一插入；落实“received → dispatching → accepted | rejected | unknown”，前置拒绝可 received→rejected；同 ID 不同正文保留原记录并诊断，不退回正文去重。 InboundInput 原文字段：`id, dedupNamespace, originalMessageId, platformConversationId, identityId, receivedSequence, textRef, mode, runId?, pendingInputId?, status, acceptedAt?, appliedEvidenceRef?, errorCode?`；原文约束：“UNIQUE(dedupNamespace, originalMessageId)；命名空间必须经 V-05 验证；mode=start/steer/answer/invalid；相同正文新 ID 保留”。 InboundReceipt 原文字段：`id, inputId?, transportMessageId, receivedAt, ackStatus`；原文约束：“保留推送尝试与业务输入的区别；重投只关联原输入；群消息只计匿名统计，不保存正文”。 依赖：T017、T018、T019。

- [ ] T023 [P] [US1] 在 `src/domain/run.ts`、`src/storage/migrations/005-runs.sql`、`src/storage/runs.ts` 建立 HarnessOperation/Run 模型、revision 更新和单活动槽；操作严格“prepared → dispatching → accepted | rejected | unknown”，任务为“submitting → running ↔ waiting_input → completed | failed”，含 unknown/not_started；“submitting/running/waiting_input/unknown” 均占用活动槽。 HarnessOperation 原文字段：`id, bindingId, inputId?, runId?, pendingInputId?, kind, expectedRunRef?, status, startedAt?, resultCode?, evidenceRef?`；原文约束：“kind=create/load/start/steer/answer；对外调用前保存意图；operationId 不自动具有远端幂等性”。 Run 原文字段：`id, courierSessionId, bindingId, initialInputId, harnessRunRef?, status, revision, policySnapshot, completionEvidenceRef?, startedAt?, finishedAt?`；原文约束：“每会话最多一个未决任务；steer 关联同一 Run；终态与投递状态无关”。 依赖：T017、T018、T019。

- [ ] T024 [P] [US1] 在 `src/domain/output.ts`、`src/storage/migrations/006-output.sql`、`src/storage/output.ts` 建立 HarnessEvent、OutputMessage、OutputFragment 全量模型；保留所有类型与 nullable 字段，complete/invalid 与展示选择独立；本故事先消费明确完整的单片段消息，US4 扩展组装行为，不把其他形态伪装完整。 HarnessEvent 原文字段：`id, bindingId, runId, sourceEventKey, eventType, sequence?, payloadRef, processedAt`；原文约束：“sourceEventKey 必须有可靠来源；无可靠重投标识时不能声称可以恢复重放整个流”。 OutputMessage 原文字段：`id, runId, sourceMessageId, kind, userVisible, logicalSequence, completeness, selected, hiddenReason?, contentRef`；原文约束：“UNIQUE(runId, sourceMessageId)；kind=progress/final/question/permission_request/error/message/tool_status/artifact；未知类型仅安全诊断”。 OutputFragment 原文字段：`id, outputMessageId, sourceFragmentKey, fragmentIndex, textRef`；原文约束：“UNIQUE(outputMessageId, sourceFragmentKey) 及 UNIQUE(outputMessageId, fragmentIndex)；从 0 连续编号，键/序号/内容不一致是协议冲突；相同正文不同片段保留”。 依赖：T017、T018、T019。

- [ ] T025 [P] [US1] 在 `src/domain/delivery.ts`、`src/storage/migrations/007-delivery.sql`、`src/storage/delivery.ts` 建立 OutboundDelivery、DeliveryAttempt、DeliveryRoute 全量模型与原目标/递增顺序分配，nullable 关联执行交叉约束；重试调度在 US2 补齐，但初始持久记录不可省略未知结果。 OutboundDelivery 原文字段：`id, recipientId, runId?, inputId?, pendingInputId?, logicalMessageIds, deliverySequence, payloadRef, status, attemptCount, nextAttemptAt?, errorCode?`；原文约束：“UNIQUE(recipientId, deliverySequence)；runId/inputId 至少一个且接收范围一致；消息内容/目标一经尝试即不可修改；系统限制提示可无 Run，须关联 inputId”。 DeliveryAttempt 原文字段：`id, deliveryId, attemptNo, routeId, startedAt, outcome, providerReceiptRef?, errorCode?`；原文约束：“UNIQUE(deliveryId, attemptNo)，最多三次自动尝试；路由变化不重置预算”。 DeliveryRoute 原文字段：`id, recipientId, kind, sensitiveCapabilityRef?, expiresAt?, verifiedLimits, capabilityEvidenceId, status`；原文约束：“kind=sessionWebhook/oto；替代路径必须证明同原私聊；真实 URL 和密钥不进入共享记录”。 依赖：T017、T018、T019。

- [ ] T026 [US1] 在 `src/application/sessions.ts` 实现指定实例上的首次绑定预留、创建、原会话 load 和正常重启后的关联恢复；运行发现不进入应用层；“每个 CourierSession 只有一个绑定”，并发首建未核实阻塞后续输入，不双建、不换 Harness、不按历史摘要冒充续接。 依赖：T020、T021、T022、T023、T024、T025。

- [ ] T027 [US1] 在 `src/application/inbound.ts`、`src/application/dispatch.ts` 实现 T1–T3：短事务入站去重后 ACK、预留操作/Run 后释放锁、事务外 start 或按 expectedRunRef steer；固定接收时策略快照，人工答复端口优先而未实现时报告交互阻塞；正常输入不排队、不隐式批准、不额外发状态提示。 每次新转交调用前复核对应能力证据有效性，失效只阻止受影响的新操作并安全提示，不改写原 Run 或人工请求事实。 依赖：T026。

- [ ] T028 [US1] 在 `src/application/events.ts` 实现带可靠关联的事件归约及单片段完整逻辑消息的事务 outbox：先控制状态后展示；received/accepted/applied 分开，final 不代替 completed，晚到 accepted 不回退终态，矛盾权威证据停止相关副作用；未知内部类型只安全诊断。 依赖：T027。

- [ ] T029 [US1] 在 `src/delivery/dispatch.ts` 实现 T5 单条发送：持久化 sending/attempt 后事务外调用，确认保存 delivered、明确失败记录失败原因、未知保存 unknown；“delivered 表示平台确认接收成功，不代表用户已读”，不得重跑 Harness 或发送已成功消息，后续重试机制由 US2 接入。 依赖：T028。

- [ ] T030 [US1] 在 `src/main.ts`、`src/cli/serve.ts`、`src/cli/validate-config.ts` 组合配置校验、互斥锁、迁移、恢复、平台入站、Harness 事件和出站生命周期；fake 模式可跑全链路，真实模式须准入后才注册；退出只断开 Courier 自有连接，不取消 Harness 任务。 依赖：T029。

- [ ] T031 [P] [US1] 在 `tests/probes/workbuddy-capabilities.ts` 编写显式手动启用的最小能力实验，并将脱敏结果写入 `specs/001-dingtalk-conversation/verification/workbuddy-capabilities.md`：按 quickstart 验证 V-03、V-04、V-05 的 Harness 部分，覆盖当前版本、官方登录、发现/激活、写入权、各运行状态的 steer 实际消费、人工往返、分类/片段/完成与核实边界；协议探测客户端重连仅作底层续接证据，实际 Courier 重启与整条钉钉链路留给 T077；未实测不得记 passed，不提取凭据或固定诊断端点。 依赖：T016。

- [ ] T032 [P] [US1] 在 `tests/probes/dingtalk-capabilities.ts` 编写显式手动启用的私聊实验，并将脱敏结果写入 `specs/001-dingtalk-conversation/verification/dingtalk-capabilities.md`：验证 V-01/V-02/V-05 的官方限制、真实三条输出、msgId 重投作用域、过期后同私聊授权/映射与 unknown 核实；不高频探测上限，OTO 不可用时明确记录限制分支而非假定有同会话能力。 依赖：T016。

- [ ] T033 [P] [US1] 仅在 T031 所需准入项有证据后，在 `src/adapters/workbuddy-experimental/connection.ts`、`src/adapters/workbuddy-experimental/session.ts`、`src/adapters/workbuddy-experimental/steer.ts` 实现本机连接发现/正常激活/重连、原会话与控制事件、快速 receipt 及实验 steer 映射；clientUserMessageId 仅作关联，不当幂等键，拒绝/未知不改为排队；人工和多片段映射留给 US3/US4，未完成时不宣称完整支持。 真实门槛：G-H。 依赖：T016、T031。

- [ ] T034 [P] [US1] 仅在 T032 的可靠消息身份和私聊接入证据满足后，在 `src/adapters/dingtalk/client.ts`、`src/adapters/dingtalk/stream.ts`、`src/adapters/dingtalk/normalize.ts` 实现正常凭据获取/更新、SDK 生命周期、完整字段映射与持久登记后 ACK；区分 robotCode/chatbotUserId 和 senderId/senderStaffId，不将 SDK 内存去重当跨重启去重。 真实门槛：G-D。 依赖：T016、T032。

- [ ] T035 [US1] 仅在 T032 的发送边界明确后，在 `src/adapters/dingtalk/webhook.ts` 实现原私聊 webhook 发送、到期/长度/限额校验、业务码解析和显式超时；关闭修改请求隐式重试，私有保存 webhook 引用，不把超时认定未发送；单条失败/未知通过平台端口返回。 真实门槛：G-D。 依赖：T032、T034。

- [ ] T036 [US1] 运行 `tests/integration/conversation.test.ts` 与本故事契约测试，修复到 Q-01 至 Q-05 全部通过，并将真实执行命令、计数和模拟边界记入 `specs/001-dingtalk-conversation/verification/us1.md`；只依赖离线核心完成即可执行，真实实验/适配未完成仍保留对应任务未勾选。 依赖：T017、T018、T019、T030。


**检查点**：T036 是 US1 离线核心检查点，可作为开发 MVP；T031–T035 的真实分支如有阻塞仍保留未完成，不把离线通过报告为 US1 真实验收。


## Phase 4：US2 — 重投、投递失败与会话冲突（P1）

**目标**：保持重复输入、执行未知、出站重试和恢复的准确语义，提供可查询的失败事实。

**独立验证**：Q-06 至 Q-10、Q-18 的脱敏、Q-19/Q-20/Q-21 的执行与投递分支：同 ID 重投十次只提交一次，新 ID 相同文本仍执行；单条最多三次尝试，unknown 不盲重试，恢复不换会话、不回退终态。


### 测试任务

- [ ] T037 [P] [US2] 在 `tests/contract/delivery-outcomes.test.ts` 编写 webhook/OTO 结果适配契约：HTTP 200 仍检查业务结果、已读不等于未发送、路径/长度/权限失败区别于超时 unknown、未知不切换路径补发，fake 与实际传输替身遵守相同契约；覆盖 US2-3、US2-4、US2-5、US2-9、US2-12。 依赖：T036。

- [ ] T038 [P] [US2] 在 `tests/integration/recovery.test.ts` 编写 create/start/steer/send 调用前、对方已接收而本地确认前、确认落盘后的崩溃测试，覆盖数据库不可读、先 completed/failed 后 accepted 和冲突证据；对应 US2-6、US2-10、US2-11、Q-19、Q-21，人工请求分支在 US3 扩展。 依赖：T036。

- [ ] T039 [P] [US2] 在 `tests/integration/deduplication.test.ts` 编写原始消息重投十次与相同正文新 ID 的计数测试，覆盖并发重投、重启后重投、缺可靠 ID、同 ID 冲突正文及底层 answer 模式操作的重投抑制；原请求路由的完整往返由 US3 验证；对应 US2-1、US2-2、SC-004。 依赖：T036。


### 实施任务

- [ ] T040 [US2] 在 `src/application/input-ledger.ts`、`src/storage/inputs.ts` 固化命名空间去重与跨重启 tombstone 保留，整合 `src/application/inbound.ts`，保证“UNIQUE(dedupNamespace, originalMessageId)”只来自已验证标识；重投只关联原记录，不重复提示/提交；“首版不自动删除去重键、请求编号、操作确认和会话关联”。 依赖：T037、T038、T039。

- [ ] T041 [US2] 在 `src/delivery/scheduler.ts`、`src/delivery/retry-policy.ts` 实现每私聊串行调度及“pending → sending → delivered | retry_wait | failed | unknown”；“retry_wait → sending”仅用于确认未投递且可重试，首次后最多两次重试，遵守 Retry-After/已验证限额；耗尽后放行后续并生成有限缺失提示，unknown 只暂停原私聊出站。 依赖：T040。

- [ ] T042 [US2] 在 `src/delivery/routes.ts`、`src/delivery/limits.ts` 实现应用/机器人/接收人/路由各作用域预算、过期检查与同私聊路径选择；每次发送前分别检查平台能力证据有效性及路由期限，不把两者混用；替代路径仅有已授权/已验证同目标证据时可用，单条超长失败不截断；换路径不重置预算，未知不换路补发，无路径的 pending 保留可查。 依赖：T041。

- [ ] T043 [US2] 在 `src/application/failure-reporting.ts`、`tests/unit/failure-reporting.test.ts` 实现缺目标、writer_occupied、不可续接、失效登录、部分输出后失败、应有最终内容缺失及超长/路径失效的中文说明；引用“error 默认 true，关闭只影响 Harness 展示事件，必要的 Courier 故障、限制和交互阻塞提示仍须保留。”，过滤 final 不误报无内容，错误提示失败不递归。 依赖：T042。

- [ ] T044 [US2] 在 `src/application/recovery.ts` 接入 `src/cli/serve.ts`，将遗留 dispatching/sending 和无法确认的执行标 unknown，仅已确认未派发的旧普通输入记“rejected/recovery_interrupted”；保留 accepted 与原绑定，损坏数据不删库重建，未知任务占活动槽、后续不安全输入明确拒绝且不累积恢复队列。 依赖：T043。

- [ ] T045 [US2] 在 `src/application/reconcile.ts` 实现只读远端核实后原子保存：unknown 操作凭权威证据 accepted/rejected；投递确认已送达→delivered，确认未送达且可重试/预算剩余→retry_wait，否则 failed，无依据仍 unknown；“核实成功解除对应顺序阻塞，核实、重启和换路径均不重置 attemptCount。”且不直接重发任何输入/决定/消息。 依赖：T044。

- [ ] T046 [US2] 在 `src/cli/status.ts`、`src/cli/reconcile.ts` 实现脱敏只读状态及 operation/delivery 互斥参数；reconcile 必须停服并取得同锁后才写证据，服务运行时拒绝；落实契约退出码 0/2/3/4/5，status=0 不表示任务成功，无强制重放、接管或自动批准入口。 依赖：T045。

- [ ] T047 [P] [US2] 在 `src/adapters/workbuddy-experimental/inspect.ts`、`src/adapters/workbuddy-experimental/errors.ts` 映射登录、写入权、原会话/任务/请求查询与断连；只使用 T031 验证的查询事实，没有权威核实时返回 unsupported/unknown，不把历史存在或查询缺失推导成完成/未执行。 真实门槛：G-H。 依赖：T031、T033、T046。

- [ ] T048 [P] [US2] 在 `src/adapters/dingtalk/oto.ts`、`src/adapters/dingtalk/inspect.ts` 实现经 V-02 验证后的单元素 userIds 原机器人私聊备用路径及可证明的结果查询；无授权、缺企业映射或未证同私聊时禁用路径并返回限制，过程查询键/已读结果不能补造幂等或未发送证据。 真实门槛：G-D-OTO。 依赖：T032、T034、T035、T046。

- [ ] T049 [US2] 在 `tests/integration/delivery-recovery.test.ts` 验证三条有序消息第二条临时失败、三次耗尽、unknown 暂停与三种核实结果、路由切换不重置预算，以及其他私聊和 Harness 控制继续；覆盖 Q-07、Q-08、Q-10、Q-20、SC-005，断言额外 Harness 执行次数为零。 依赖：T041、T042、T045、T046。

- [ ] T050 [US2] 在 `tests/integration/session-failures.test.ts` 验证 writer_occupied、缺原会话、失效登录、无可交付内容和状态矛盾；使用合成敏感错误检查用户提示/CLI/共享导出的隐私，验证 Q-09、Q-18 和 US2-7、US2-8、US2-10、US2-13，不调用真实工具。 依赖：T043、T044、T046。

- [ ] T051 [US2] 执行 US2 的契约、去重、会话失败与崩溃/核实测试，将 Q-06 至 Q-10、Q-18 至 Q-21 的本故事分支结果记入 `specs/001-dingtalk-conversation/verification/us2.md`；记录实际命令及输入/执行/投递计数，真实适配结果单列，未执行不勾选真实任务。 依赖：T037、T038、T039、T040、T041、T042、T043、T044、T045、T046、T049、T050。


**检查点**：US2 核心可用合成消息与故障独立验证；人工请求生命周期的完整恢复由 US3 追加集成测试，不削弱既有 unknown 规则。


## Phase 5：US3 — 回答问题与明确批准/拒绝（P1）

**目标**：以原私聊、原任务、原请求关联转交人工输入，保持普通 steer 与人工决定分离。

**独立验证**：Q-11 至 Q-14，加 answer 崩溃与请求撤销/晚确认：问题、批准、拒绝各一次完整往返；歧义、跨私聊、重复、失效和未知结果不误授权，待答期间普通输入仍 timely steer。


### 测试任务

- [ ] T052 [P] [US3] 在 `tests/contract/harness-interaction.test.ts` 编写 answer、input.requested/input.invalidated 和不可变 answerSchema 映射测试，覆盖文本/表单、批准范围、拒绝、接收未知和过期/撤销；覆盖 input.requested 与正文先后到达、重投、同请求换消息/同消息换请求及绑定/Run/类型冲突；缺字段/非法选项不提交，resolved 不代替原任务后续状态。 依赖：T051。

- [ ] T053 [P] [US3] 在 `tests/integration/human-input.test.ts`、`tests/unit/reply-parser.test.ts` 编写 Q-11 至 Q-14：显式编号、歧义词、/补充、多个请求、其他私聊、无答复、重复决定、撤销、未知，以及等待人工输入时 steer 与有效答复优先；包括 US3-1 至 US3-8 的独立断言。 依赖：T051。


### 实施任务

- [ ] T054 [US3] 在 `src/domain/pending-input.ts`、`src/storage/migrations/008-pending-inputs.sql`、`src/storage/pending-inputs.ts` 建立 PendingInput 完整模型、原请求映射和原子 answerInputId 预留；按原文“validity=open | withdrawn | expired | closed_by_run”与“answerStatus=none | dispatching | accepted | rejected | unknown”分别保存，sourceMessageId 与原字段模式/选项映射持久化，编号不复用；原请求事件先到时允许正文尚不存在，正文到达后按同 Run 消息键校验，不伪造消息开始或顺序。 PendingInput 原文字段：`id, runId, bindingId, platformConversationId, vendorRequestId, sourceMessageId, kind, publicCode, promptRef?, answerSchema?, options?, adapterMappingRef, validity, answerStatus, answerInputId?, revision`；原文约束：“kind=question/permission；UNIQUE(bindingId, runId, vendorRequestId) 及 UNIQUE(runId, sourceMessageId)；publicCode 在同私聊历史范围不复用；原消息关联、问题字段模式与选项映射持久化，重启不重新猜测”。 依赖：T052、T053。

- [ ] T055 [US3] 在 `src/adapters/dingtalk/reply-parser.ts`、`src/domain/answer.ts` 实现 /答复、/批准、/拒绝、/补充 的明确语法与固定歧义词规则；按契约 text/form/permission 联合类型校验，form 字段 valueType=text/choice/choices、必填和选项码严格匹配；不把普通 JSON/同意猜成授权，不扩大批准范围，不新增身份/角色校验。 依赖：T054。

- [ ] T056 [US3] 在 `src/application/interaction-presenter.ts` 为原请求生成同私聊不复用编号、字段/权限选项说明及安全投递内容；复用持久 sourceMessageId/编号，只有正文完整且请求映射落盘后才在 T4 中创建唯一请求正文投递，记录 pendingInputId 与原 logicalMessageIds；正文先到则保留待关联，重投或重启均不再次编号/创建投递，冲突映射停止相关投递，不将问题/权限合并为进度。 依赖：T055。

- [ ] T057 [US3] 在 `src/application/pending-inputs.ts` 处理请求登记、失效、有效集合与 Run.waiting_input：Harness 明确撤销/过期/终态才关闭，缺答复不超时代答；“rejected 且明确未接收时可接受用户随后发来的新答复；unknown 时不能再次提交决定。”，schema 改变必须失效旧请求并建立新关联。 依赖：T056。

- [ ] T058 [US3] 在 `src/application/answer-routing.ts` 接入 `src/application/dispatch.ts`，先核对原私聊/绑定/Run/请求/revision 与当前证据有效性，再预留并转交一次答案；有效人工答复优先于尚未提交的普通输入，普通 steer 失败不能丢失原请求；steer 撤销竞态不将旧同意转给新请求，跨私聊即使含编号也不转交。 依赖：T057。

- [ ] T059 [US3] 仅在 T031 的 V-04 有对应证据后，在 `src/adapters/workbuddy-experimental/interaction.ts` 实现问题/权限事件和答复映射，区分传输 ID、持久 requestId 与选项范围，保存 adapterMappingRef；使用已验证的标准权限或内部 interruption 路径，明确实验边界，无法接收答复时报告阻塞。 真实门槛：G-H-INTERACTION。 依赖：T031、T033、T047、T058。

- [ ] T060 [US3] 在 `src/application/interaction-recovery.ts`、`tests/integration/interaction-recovery.test.ts` 接入 US2 恢复与核实，验证 answer 在调用前/对方接收后/确认落盘后崩溃及重启后 schema/映射保存；新增请求映射已落盘但正文未完成时的崩溃窗口，断言可靠补齐后原编号、原关联及请求正文投递均唯一、重复事件不双发，缺失内容无法可靠补齐则保留请求并报告阻塞；unknown 决定不重放、撤销后 accepted 不重开请求，完整覆盖 Q-19/Q-21 的人工分支与 US3-8。 依赖：T058。

- [ ] T061 [US3] 在 `src/main.ts`、`src/application/inbound.ts`、`src/application/events.ts` 注册人工解析/展示/生命周期/优先路由及恢复钩子；控制状态更新不经过展示过滤，question/permissionRequest=false 拒绝配置，运行期交互失效如实报阻塞；重复人工原消息只 ACK 不再次提交。 依赖：T060。

- [ ] T062 [US3] 执行 US3 全部模拟测试并重跑受影响的 US1 steer、US2 重投/恢复测试，将 Q-11 至 Q-14、Q-19/Q-21 的人工分支和 SC-006 结果写入 `specs/001-dingtalk-conversation/verification/us3.md`；真实 V-04 与钉钉完整往返在最终集成单独验收。 依赖：T052、T053、T054、T055、T056、T057、T058、T060、T061。


**检查点**：US3 离线完整往返通过；不引入答复者权限名单，运行时交互阻塞可查且不自动批准。


## Phase 6：US4 — 可配置的进度与最终回答（P2）

**目标**：将一轮中的多个逻辑消息可靠组装、过滤和有序投递，保持控制状态独立。

**独立验证**：Q-15 至 Q-18：两进度加 final 在四种配置下分别为 3/1/2/0 条普通输出；片段正常重复不丢失、重投只消除同身份；合并不碰人工/错误消息，活动任务策略不变，未知类型不外泄。


### 测试任务

- [ ] T063 [P] [US4] 在 `tests/contract/harness-output.test.ts` 编写明确类型、userVisible、消息开始/片段/结束、0..N 序号、重复键/索引冲突、尾片段晚于 Run 终态与不支持分类的契约测试；拒绝从正文、静默超时或 thought 片段猜 progress/final；对应 US4-4、US4-8。 依赖：T062。

- [ ] T064 [P] [US4] 在 `tests/integration/output-policy.test.ts` 编写四种展示组合、相邻合并、超长合并回退、运行中重载/steer 快照、问题错误默认保留、未知内容及真实终态独立的 Q-15 至 Q-18 测试；对应 US4-1 至 US4-8、SC-003。 依赖：T062。


### 实施任务

- [ ] T065 [US4] 在 `src/domain/display-policy.ts`、`src/application/policy-snapshot.ts` 完整实现 Run.policySnapshot 的 revision/progress/final/question/permissionRequest/error/message/toolStatus/artifact/mergeAdjacentProgress，落实原文“默认 progress/final/question/permissionRequest/error=true，message/toolStatus/artifact=false，mergeAdjacentProgress=false。”和“首轮 received 时为预留 Run 固定快照，后续 steer 不改变它；新一轮使用当前配置。”，关闭 question/permissionRequest 拒绝。 依赖：T063、T064。

- [ ] T066 [US4] 在 `src/delivery/assemble.ts` 实现“assembling → complete | invalid”；原文“fragmentIndex 从 0 开始，completed 给出最后索引 N，完整集合必须为 0..N；空消息用 N=-1 且不得有片段。”，同键异序号/内容、同序号异键为冲突；同文本不同身份保留，不依到达顺序重编号，终态尾片段仍接收，不靠沉默超时封口。 依赖：T065。

- [ ] T067 [US4] 在 `src/application/output-projector.ts` 接入 `src/application/events.ts` 的同一 T4 事务，原子保存控制状态、片段、选择/隐藏原因、outbox 及游标；“logicalSequence 在逻辑消息开始时分配”，较后消息不越过未封口消息，已证不可补齐则 invalid 后放行，final 被隐藏不误报失败或无内容。 依赖：T066。

- [ ] T068 [US4] 在 `src/delivery/merge-progress.ts` 实现仅明确配置允许时合并相邻未尝试的完整 progress，保存有序 logicalMessageIds；原文“不跨 final、问题、权限或错误合并，不改变已经发送的消息。”，合并超限保留原消息逐条发送，不能用合并掩盖多条能力未验证。 依赖：T067。

- [ ] T069 [US4] 仅在 T031 的分类/片段/完成证据满足后，在 `src/adapters/workbuddy-experimental/output.ts` 将厂商事件归一化为明确用户可见类型和可靠消息/片段身份，按验证边界处理历史与实时流交叠；无可靠身份/分类时报告 output_unsupported，不转发内部思考或假装符合 US4。 真实门槛：G-H-OUTPUT。 依赖：T031、T033、T063、T067。

- [ ] T070 [US4] 在 `src/delivery/output-scheduling.ts` 将组装/过滤/合并后的逻辑消息交给 US2 的原目标顺序/限额调度器；每条/每次尝试保留关联，进度失败耗尽后 final 可继续，unknown 不越序；加入 `tests/integration/multi-output-delivery.test.ts` 验证合并与重试/过期组合。 依赖：T068。

- [ ] T071 [US4] 在 `src/config/reload.ts`、`src/application/policy-snapshot.ts`、`src/main.ts` 实现接受新一轮前整体校验并读取最新策略，失败保留旧有效配置并报告安全原因；当前 Run 和其 steer 始终原快照，不新增可静默隐藏人工请求的入口。 依赖：T065、T070。

- [ ] T072 [US4] 在 `tests/integration/output-recovery.test.ts` 验证 T4 提交前后崩溃、可靠事件重播不重复 outbox、逻辑消息顺序缺口、同正文不同片段与最终片段恢复；断言隐藏所有普通输出仍正确维护问题/权限/错误和执行终态，且不补发成功消息。 依赖：T067、T068、T070、T071。

- [ ] T073 [US4] 执行 US4 契约与 Q-15 至 Q-18、输出恢复测试，将 3/1/2/0 计数、顺序、快照及能力限制结果写入 `specs/001-dingtalk-conversation/verification/us4.md`；重跑受影响的 US2 投递和 US3 人工控制测试，模拟与真实结果分别记录。 依赖：T063、T064、T065、T066、T067、T068、T070、T071、T072。


**检查点**：US4 独立输出场景通过，四个故事的核心链路齐备；真实多消息/类型能力仍须最终实际验收。


## Phase 7：Polish — 跨故事集成与验收

**目标**：完成安全边界、实际运行验证及交接，真实测试保持显式启用，未通过项不能通过文档勾选绕过。

- [ ] T074 在 `src/storage/private-state.ts`、`tests/integration/privacy.test.ts` 核对私有目录/备份/凭据引用、日志与共享导出脱敏、备份一致性和保留边界；落实原文“备份必须使用 SQLite 一致性备份方式；不能单独复制活动数据库而漏掉 WAL。”，所有新增日志与样例使用合成数据，禁止宣称未实现的存储加密。 依赖：T073。

- [ ] T075 在 `tests/integration/live-conversation.test.ts`、`src/main.ts` 完成真实适配组合与显式手动启用的端到端验收入口，默认测试运行绝不发真实消息；绑定正常配置的测试账号与会话，按有效性规则逐项读取所需适配器证据，保留 OTO/查询不可用的正确限制分支，不用 fake 替代真实结果。 真实门槛：G-H、G-H-INTERACTION、G-H-OUTPUT、G-D、G-D-OTO（允许已证不可用的限制分支）；本任务完成后才为 T077 提供 G-INTEGRATION 的组合证据，本任务不执行真实总验收。 依赖：T033、T034、T035、T047、T048、T059、T069、T074。

- [ ] T076 使用实际 package.json 提供的安装/编译/类型检查/测试命令运行完整离线检查，在 `specs/001-dingtalk-conversation/verification/offline.md` 记录 Q-01 至 Q-21、各崩溃窗口、输入/执行/投递计数与测试命令；测试失败则修复对应模块并只重跑受影响范围，不能把 Spec Kit 检查当应用检查。 依赖：T074。

- [ ] T077 在真实测试操作已获对应授权且环境就绪时执行 `tests/integration/live-conversation.test.ts`，将 SC-001 至 SC-009、37 个验收场景及 V-01 至 V-05 的版本/覆盖/实际结果写入 `specs/001-dingtalk-conversation/verification/live.md`；覆盖两用户、正常重启、及时 steer、权限往返、多输出和异常；未执行/失败/阻塞不得标 passed，也不修改真实应用权限绕过阻塞。 真实门槛：G-INTEGRATION。 依赖：T075、T076。

- [ ] T078 在 `specs/001-dingtalk-conversation/verification/capability-matrix.md` 汇总每项必需/可选能力的产品与适配器版本、证据范围、checkedAt/可选 expiresAt/invalidatedAt、passed/failed/not_tested/blocked；验证上下文和指纹仅输出临时别名，并区分实验结果与当前有效性；核对 `src/adapters/harness/admission.ts` 消费结果；not_tested/blocked 映射为 CapabilityEvidence.unverified，只有实际通过才记 passed；必需项缺证则保持目标不受支持，V-02 无备用路径及可选查询缺失只允许按规格声明限制，不声称所有路径可用。 依赖：T077。

- [ ] T079 根据实际落地结果更新 `README.md`、`AGENTS.md`、`specs/001-dingtalk-conversation/quickstart.md` 与必要设计文档，写入已验证的真实命令、接口版本和支持边界，保留历史实验日期；清楚区分核心模拟、真实 Harness、真实钉钉集成，不能把本地验收写成部署或发布。 依赖：T078。

- [ ] T080 在 `specs/001-dingtalk-conversation/checklists/implementation.md` 完成宪章、需求/契约/模型约束与最终测试证据复核；核对本 tasks 的每项勾选都有对应代码/结果，阻塞真实任务保持未完成，记录剩余限制和脱敏交接，不自行 commit/push/发布/部署。 依赖：T079。


**检查点**：只有所需真实能力和 SC-001 至 SC-009 具备相应结果，才能报告本功能受支持；没有提交、推送、发布或部署任务。


## Dependencies & Execution Order

### 阶段与故事依赖图

```text
Phase 1 (T001–T004)
  -> Phase 2 (T005–T016)
       -> US1 核心 (T017–T030, T036)
            -> US2 核心 (T037–T046, T049–T051)
                 -> US3 核心 (T052–T058, T060–T062)
                      -> US4 核心 (T063–T068, T070–T073)
                           -> T074 -> T076 离线总验收
       -> T031 WorkBuddy 实验 -> G-H -> T033 -> T047/T059/T069
       -> T032 钉钉实验 -> G-D -> T034 -> T035 -> T048
上述真实分支 + 离线核心 -> T075 -> T077 真实总验收
T077 -> T078 能力矩阵 -> T079 交接更新 -> T080 最终复核
```

图为摘要，任务行中的依赖列表是具体调度依据。Phase 2 阻塞所有故事的实现，
但 T031/T032 满足 Phase 2 后可立即提前执行，优先消除真实适配风险。
US2 仅依赖 US1 离线核心，不等待 T031–T035；US3/US4 的核心也不等待真实适配。
真实任务必须等待相应证据，不以“流程继续”为由绕过门槛。

每个故事有独立测试入口，但复用前序故事的领域/存储/路由基础；
独立验收不意味着重新实现一套无依赖系统。US2 的通用 answer 去重/操作账本与 US3 的请求往返分层验证。
US4 依赖 US3 的控制链路，才能证明全部普通输出隐藏时问题和授权仍工作。

### 任务内部顺序

1. 先完成共享端口与 fixtures，再写故事契约和旅程测试。
2. 模型、迁移与仓储就绪后，接应用事务/服务，再组合 CLI 与传输。
3. 外部调用永远在持久意图提交之后、数据库事务之外；输出状态和 outbox 在同一短事务中归约。
4. 同文件任务按显式依赖串行；模型迁移 T020–T025 可分别编写，全部就绪后按编号统一迁移，不能并行修改同一库。
5. 每个核心检查点执行独立测试并记录结果；只有对应真实分支验收才能增加真实能力声明。
6. 将外部条件记录为 blocked 不能视作任务已实现；不创建普通输入回退队列、不改规格、不换未经安排的 Harness。

### 并行机会与示例

以下是未来分工示例，不是本次已经启动的实现工作。所有批次都必须先满足各任务依赖。

| 故事/阶段 | 可并行任务 | 文件与前置条件 |
| --- | --- | --- |
| Setup | T002、T003、T004 | T001 后，分别处理 TS 配置、Git 忽略和测试时钟/故障夹具 |
| Foundation | T006、T007、T008、T009、T011 | T005 后，分别处理 Harness 端口、平台端口、配置、数据库和诊断 |
| Foundation | T013、T014 | 共享端口/能力类型/锁准备后，分别实现两个测试适配器 |
| US1 测试 | T017、T018、T019 | Phase 2 后，分别写 Harness 会话契约、平台入站契约和对话旅程 |
| US1 模型 | T020、T021、T022、T023、T024、T025 | 故事测试已写；分别写平台、会话、输入、运行、输出和投递文件及不同迁移 |
| US1 实验 | T031、T032 | Phase 2 后，各自使用独立获准测试环境与证据文件；不与同一真实会话的其他实验同时写入 |
| US1 适配 | T033、T034 | 对应证据通过后，WorkBuddy 与钉钉入站在不同目录实现 |
| US2 测试 | T037、T038、T039 | US1 核心后，分别写投递结果、崩溃恢复和去重测试 |
| US2 适配 | T047、T048 | 各自前置适配/证据及核心核实逻辑完成后，分别写 Harness 查询与 OTO 路径 |
| US3 测试 | T052、T053 | US2 核心后，分别写 Harness 人工契约与用户答复/解析旅程 |
| US4 测试 | T063、T064 | US3 核心后，分别写 Harness 输出契约与策略旅程 |
| 最终验证 | T075、T076 | T074 及各自额外依赖完成；真实测试入口组合与离线总验收在不同文件进行 |

跨故事共享的 `src/main.ts`、`src/application/inbound.ts`、`src/application/events.ts`
必须按任务顺序合并，不能因标有 `[P]` 就并发修改这些集成点。

## 需求与验收追踪

### 用户故事验收场景

| 场景 | 实现任务 | 测试/验收任务 |
| --- | --- | --- |
| US1-1 | T020–T030 | T017、T019、T036 |
| US1-2 | T021、T023、T026、T030 | T019、T036 |
| US1-3 | T020、T026、T027 | T018、T019、T036 |
| US1-4 | T016、T026、T027 | T018、T019、T036 |
| US1-5 | T020、T027、T034 | T018、T019、T036 |
| US1-6 | T016、T023、T027、T033 | T017、T019、T031、T036 |
| US1-7 | T016、T033 | T017、T019、T031、T036 |
| US1-8 | T023、T027、T033 | T017、T019、T036 |
| US2-1 | T022、T027、T040、T061 | T039、T051、T062 |
| US2-2 | T022、T027、T040 | T019、T039、T051 |
| US2-3 | T025、T029、T041、T070 | T037、T049、T051、T073 |
| US2-4 | T041、T043 | T037、T049、T051 |
| US2-5 | T041、T045、T046、T048 | T037、T049、T051 |
| US2-6 | T023、T027、T044、T045 | T038、T051 |
| US2-7 | T026、T033、T043、T047 | T031、T050、T051 |
| US2-8 | T026、T033、T043、T047 | T031、T050、T051 |
| US2-9 | T035、T042、T048 | T032、T037、T049、T051 |
| US2-10 | T028、T043、T047、T067 | T038、T050、T051、T072 |
| US2-11 | T044、T045、T046、T060 | T038、T051、T060、T062 |
| US2-12 | T035、T042、T043 | T037、T049、T051 |
| US2-13 | T011、T043、T046、T074 | T050、T051、T074 |
| US3-1 | T054–T061 | T052、T053、T062 |
| US3-2 | T054–T061 | T031、T052、T053、T062 |
| US3-3 | T055、T056、T058 | T053、T062 |
| US3-4 | T054、T055、T058 | T053、T062 |
| US3-5 | T054、T057、T058、T060 | T052、T053、T060、T062 |
| US3-6 | T008、T016、T057、T061 | T015、T053、T062 |
| US3-7 | T027、T057、T058、T061 | T031、T053、T062 |
| US3-8 | T045、T054、T058、T060 | T052、T060、T062 |
| US4-1 | T065–T071 | T064、T073 |
| US4-2 | T065、T067、T070 | T064、T073 |
| US4-3 | T028、T065、T067 | T064、T073 |
| US4-4 | T024、T066、T067、T069 | T063、T072、T073 |
| US4-5 | T068、T070 | T064、T073 |
| US4-6 | T027、T065、T071 | T064、T073 |
| US4-7 | T057、T061、T065、T067 | T064、T072、T073 |
| US4-8 | T016、T028、T063、T069 | T031、T063、T073 |

上述测试任务证明对应核心行为；真实场景还必须由 T075/T077 组合验证，不能拿表格关联替代执行证据。

### 功能需求

| 需求 | 主要任务 |
| --- | --- |
| FR-001 | T018、T020、T027、T034 |
| FR-002 | T020、T021、T026、T025 |
| FR-003 | T021、T026、T031、T033 |
| FR-004 | T022、T023、T028、T044 |
| FR-005 | T025、T029、T041、T045 |
| FR-006 | T022、T032、T034、T039、T040 |
| FR-007 | T023、T027、T044、T045、T060 |
| FR-008 | T016、T017、T027、T031、T033、T058 |
| FR-009 | T026、T031、T033、T043、T047、T050 |
| FR-010 | T016、T031、T033、T047、T059、T069 |
| FR-011 | T024、T063、T067、T069 |
| FR-012 | T008、T027、T065、T071 |
| FR-013 | T024、T063、T066、T072 |
| FR-014 | T025、T041、T068、T070 |
| FR-015 | T041、T043、T049、T070 |
| FR-016 | T029、T041、T045、T049 |
| FR-017 | T032、T035、T042、T048 |
| FR-018 | T054、T056、T057、T059 |
| FR-019 | T053、T055、T057、T058 |
| FR-020 | T052、T055、T058、T059、T060 |
| FR-021 | T008、T015、T057、T061、T065 |
| FR-022 | T011、T027、T043、T046 |
| FR-023 | T026、T038、T044、T045、T060 |
| FR-024 | T003、T008、T011、T050、T074 |
| FR-025 | T031、T032、T075、T077、T078、T079 |

SC-001→T019/T036，SC-002→T018/T019/T053/T062，
SC-003→T064/T073，SC-004→T039/T051，SC-005→T038/T049/T051/T060，
SC-006→T052/T053/T062，SC-007→T038/T050/T051，
SC-008→T077/T078，SC-009→T017/T019/T031/T036/T053。
所有 SC 的真实完整验收统一归 T077。

Q-01–Q-05→T036；Q-06–Q-10→T051；Q-11–Q-14→T062；
Q-15–Q-18→T073（Q-18 脱敏同时由 T050/T074 验证）；
Q-19–Q-21→T038/T049/T051/T060/T062/T072，按执行、人工和输出分支覆盖。

## Implementation Strategy

### 建议 MVP

先完成 Setup、Foundational 与 US1 的离线核心，取得三轮续接、正常重启、
两个私聊隔离及及时 steer 的可观察结果，作为**开发 MVP**。
它不等于首版产品验收：US2/US3 的 P1 安全与人工控制、US4 的必需多输出，
以及全部所需真实能力都不能省略。任何“忙时排队”替代都不属于本规格 MVP。

### 增量交付

1. T001–T016：建立可重复的离线基础，同时准备显式启用的真实实验所需前提。
2. T017–T030/T036：取得 US1 开发 MVP；T031/T032 尽早独立消除真实准入风险。
3. US2：补齐故障、投递与恢复；US3：补齐原请求人工往返；US4：补齐完整输出策略。
4. 相应准入证据成立后实现真实适配；不合能力保持不支持，核心模拟工作仍可继续。
5. T074–T080：完成离线总验收、已授权真实验收和准确交接；阻塞项保持可见，不勾成已完成。

### 任务统计与完成规则

共 **80** 项：Setup **4**、Foundational **12**、US1 **20**、US2 **15**、
US3 **11**、US4 **11**、最终阶段 **7**。其中 **32** 项标记 `[P]`，
每个并行批次必须满足依赖且避免同文件/同真实会话并发写入。

全部任务当前均为未完成。执行前后未发现 `.specify/extensions.yml`，
没有可调度的 before_tasks/after_tasks 钩子。本次完成的是任务文件的格式、依赖和覆盖检查，
不是应用构建、单元测试、能力实验或真实集成验收。
