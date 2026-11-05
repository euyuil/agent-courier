# Phase 0 研究：钉钉私聊持续对话

**日期**：2026-11-05 | **依据**：[规格](spec.md)、[项目原则](../../.specify/memory/constitution.md)

本次只读取仓库、官方资料与安装包代码；未登录、连接或执行真实 Harness 任务，未发送钉钉消息。
三项并行研究分别覆盖 Harness、钉钉和本地持久化。研究前宪章检查无冲突。
以下决策消除实施方案的选型歧义；V-01 至 V-05 是真实能力准入检查，仍未关闭。

## R-01：运行栈与最小依赖

- **Decision**：选择 TypeScript 严格模式、Node.js 24 LTS、npm，单进程服务；使用官方
  `dingtalk-stream`、`better-sqlite3`、Zod 做传输接入、存储和边界校验。
  开发期使用 TypeScript 编译器及 Node 内置测试运行器；不用 ORM、Web 框架或外部消息代理。
  精确版本在实现时核实兼容性并写入 lockfile，不能依赖浮动主分支。
- **Rationale**：流式事件、异步控制调用和显式联合类型适合本场景；钉钉有官方 Node SDK。
  Node 24 是兼容基线，不表示最新 LTS；官方发布页同时列出 Node 26 LTS。
- **Alternatives considered**：Python + asyncio + SQLite 同样可行，但需要额外隔离同步 SDK 调用；
  多服务和消息代理对当前同机、单进程范围没有收益。语言本身不保证及时 steer。
- **来源**：[Node 发布状态](https://nodejs.org/en/about/previous-releases)、
  [钉钉官方 SDK](https://open-dingtalk.github.io/developerpedia/docs/develop/sdk/overview/)、
  [Node SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)、
  [Zod](https://zod.dev/)、[TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html)、
  [Node 测试运行器](https://nodejs.org/docs/latest-v24.x/api/test.html)。

## R-02：SQLite、短事务与恢复

- **Decision**：使用本地 SQLite、单写入连接、外键、WAL、`synchronous=FULL`；
  实际驱动内嵌 SQLite 必须为 3.51.3 或后续版本。数据库不能放在网络文件系统。
  用 `better-sqlite3` 的同步短事务登记状态；事务内禁止网络调用或等待任务结束。
- **Rationale**：关联、输入去重和投递意图能在同一事务内保持一致。
  Node 24 的 `node:sqlite` 当前文档仍标为 Release candidate，故不作为首版稳定接口依赖。
  SQLite 官方 WAL 文档列出 WAL-reset 修复边界，验收须检查内嵌引擎版本而非只看 npm 版本。
- **Alternatives considered**：JSON 文件难以表达关联唯一约束和多记录原子更新；
  PostgreSQL/Redis 增加运维成本；NORMAL 的持久性不符合先落盘再 ACK 的目标。
- **来源**：[Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、
  [驱动事务约束](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)、
  [SQLite 事务](https://sqlite.org/lang_transaction.html)、
  [WAL 与修复说明](https://sqlite.org/wal.html)、
  [synchronous](https://sqlite.org/pragma.html#pragma_synchronous)。

## R-03：平台输入和重投

- **Decision**：选企业内部应用机器人、Stream 入站，持久登记后尽快 ACK；ACK 不等待 Harness。
  保留推送信封 `headers.messageId` 和业务 `data.msgId` 两个标识。
  只有 V-05 证明 `msgId` 的重投稳定性和唯一作用域后，才启用真实输入去重能力。
  缺少可靠标识的输入不提交 Harness，记录限制；不按正文、时间或语义去重。
- **Rationale**：Stream 避免本机另开公网回调服务。官方示例中的 ACK 和机器人回复为不同路径。
  官方百科关于机器人不重投的旧说明，与 Node SDK 示例/注释中的超时重推表述不一致；
  不能任选一种表述当作当前服务保证，必须实测锁定版本。
- **Alternatives considered**：HTTPS 回调可用但首版不需要公网入口；把推送 ID 当全局业务 ID
  或依赖 SDK 的内存去重，均不能满足跨重启业务去重。
- **来源**：[Stream 协议](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/)、
  [消息格式](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/message/)、
  [官方 Node 示例](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/example/index.ts)、
  [客户端源码](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts)。

## R-04：出站能力、限制与发送结果

- **Decision**：先用未过期的 `sessionWebhook`；以回调中的过期时间为准，地址作为敏感能力保护。
  能力配置必须含有依据的条数、频率、长度单位和有效期规则；缺失时不能标记多消息能力已支持。
  单次小样本测试只证明测试覆盖范围，不能生成平台上限。
- **Rationale**：官方资料明确其临时性，但本次未核实适用于此应用机器人私聊的全部数值限制。
  不采用未经核实的“一次”“无限次”“20 次/分钟”或固定“两小时”等常数。
- **Alternatives considered**：不能因限额不清就静默合并所有消息来宣称 US4 已通过；
  也不能把 Stream ACK 当作出站消息。
- **来源**：[官方回复说明](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/)。

## R-05：原路径过期后的同私聊发送

- **Decision**：OpenAPI `BatchSendOTO` 是备用候选；仅在 V-02 证明其仍落到原机器人私聊、
  所需授权有效且企业用户映射可靠后启用。每次只允许原接收人的单元素 `userIds`。
  未验证或不可用时保留发送限制，不改发其他对话。
- **Rationale**：官方模型包含 `robotCode/userIds/msgKey/msgParam`，没有 `conversationId`
  或调用方幂等键，故“能发给用户”不能推导“与原会话相同”。
  `processQueryKey` 可能只在成功响应中取得；已读查询不能证明超时请求未发送。
- **Alternatives considered**：不改用工作通知、最近联系人或其他机器人；不以查询不到已读记录作为补发依据。
- **来源**：[官方生成 SDK 的 BatchSendOTO](https://pkg.go.dev/github.com/alibabacloud-go/dingtalk@v1.7.46/robot_1_0#BatchSendOTORequest)、
  [BatchOTOQuery](https://pkg.go.dev/github.com/alibabacloud-go/dingtalk@v1.7.46/robot_1_0#BatchOTOQueryRequest)。

## R-06：WorkBuddy 目标与接口边界

- **Decision**：桌面 WorkBuddy 本机 ACP 作为实验适配候选，默认不开放真实支持声明。
  公开接口满足需求时优先替换实验路径；进程发现、激活、写入权交接及内部扩展全部封装在适配器内。
  初始化时只做无副作用能力检查；未完成版本匹配的真实能力验收，拒绝将其作为受支持目标运行。
- **Rationale**：本次安装包静态检查为 Linux 桌面 WorkBuddy **5.6.2**、随包 CLI **2.147.0**。
  这仅是当前检查版本，不是最新版保证。历史实验只证明部分续接与写入冲突行为。
  CodeBuddy 公开 ACP/HTTP 文档描述独立 CLI；WorkBuddy 本地助理公开接口未提供足够证据证明
  本规格要求的独立会话与运行中 steer，不能推定品牌间共享认证和会话。
- **Alternatives considered**：公开本地助理 REST 保留为后续可替换路径；独立 CLI、云端任务
  不冒充桌面会话；不调查 DeepSeek Harness；不要求用户为未知能力猜答案。
- **来源**：[CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp)、
  [CodeBuddy HTTP API](https://www.codebuddy.cn/docs/cli/http-api)、
  [WorkBuddy Open API](https://open.workbuddy.cn/docs/openapi)、[历史实验](../../README.md)。

## R-07：steer 的静态证据和准入条件

- **Decision**：适配器必须提供独立的快速 `steer` 操作，携带期望原任务标识；
  分别保存接收确认和实际生效证据。不得用排队、取消重启或新建会话替代。
  真实验证失败则该适配器不满足本规格，停止其准入，保留核心模拟验证结果。
- **Rationale**：包内 `session/steer` 校验活动任务与 `expectedRequestId`，把输入放入当前任务缓冲；
  `RunnerFactory.injectSendNowItems` 在后续模型请求前消费并写入当前轮。
  这证明有同轮消费机制，不证明所有运行状态均能及时消费。
  `clientUserMessageId` 在缓冲区中没有已确认去重行为，不能当服务端幂等键。
  空内容或斜杠命令形态输入可能被拒绝，必须如实报告，不能留待下一轮。
- **Alternatives considered**：仅看 `steered:true`、仅标准 ACP 握手或当前任务结束后再处理均不符合 SC-009。
- **静态定位**：安装包相对路径 `resources/app.asar` 内 `package.json`；
  `resources/app.asar.unpacked/cli/dist/codebuddy-headless.js` 内发布 `customPackage` 元数据、
  `handleSteer`、`SteerInputBuffer.push/drain`、`RunnerFactory.injectSendNowItems`、`isInjectableContent`。
  未复制包体、账号配置或运行端点到仓库。以上内部方法不是公开稳定契约。

## R-08：输出与人工交互的归一化

- **Decision**：厂商事件须有可靠任务和消息归属才能归一化。类型明确且允许展示的内容才进入投递。
  完成事件、片段完整性和人工请求有效性独立处理。权限决定保留厂商选项映射及原请求标识。
- **Rationale**：ACP 区分 `session/update` 和 `session/prompt` 的完成响应，`messageId` 为可选字段；
  不能把思考片段作为进度或从文本猜测最终回答。安装包存在
  `_codebuddy.ai/resolveInterruption` 及请求/消息元数据，但完整问答、权限往返、分类与片段重投依据未实测。
- **Alternatives considered**：不把流关闭、空包装返回值或最后一段文本当完成；
  不转发未知内部内容，不用正文相同消除片段，不建立 Courier 用户角色/权限名单。
- **来源**：[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、
  [Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)；
  包内 `handleResolveInterruption`、`extractAcpUpdateMessageId` 等静态定位。

## R-09：提交、投递和恢复的一致性

- **Decision**：调用外部系统前先提交操作意图，调用后另开事务记录确认；崩溃留下的在途操作转为 unknown。
  仅可靠查询或经过验证的幂等机制能解除不确定性。出站采用事务 outbox，首次尝试后最多两次自动重试。
  每个私聊独立排序；未知投递暂停该私聊后续发送，其他私聊及 Harness 控制不被暂停。
- **Rationale**：SQLite 的唯一键只保证本地登记不重复，不能让网络副作用成为恰好一次。
  unknown 若直接重发可能重复；若无条件放行后续输出则不能保证可见顺序。
- **Alternatives considered**：不按重启扫描 received/dispatching 重放输入；不建立普通输入恢复队列；
  不重试已成功投递，也不通过重新运行 Harness 修复投递。
- **依据**：FR-004 至 FR-009、FR-015 至 FR-017、FR-023；R-02 的事务边界。

## R-10：配置、人工答复与验证入口

- **Decision**：配置为本地 JSON，按 Courier 会话保存展示策略并在任务接收时快照；
  steer 沿用原快照。问题、授权请求与错误默认保留，问题和授权不可关闭。
  人工答复采用显式文本编号语法，避免把普通补充输入当作授权。
  首版管理入口为本地 CLI，只提供启动、配置检查、脱敏状态查询和只读核实，不提供重放/强制接管命令。
- **Rationale**：无需 UI 或公网管理接口；显式关联能确定原请求，且不新增答复者权限系统。
  查询输出足以说明输入、执行和投递分别发生了什么。
- **Alternatives considered**：卡片交互、隐式“同意”、按最近一次提问猜测、完整后台管理站点均不纳入首版。
- **依据**：A2 至 A8、FR-018 至 FR-024。CLI 为待实现契约，本仓库尚无可运行应用命令。

## 证据登记与真实准入

| 验证项 | 本次获得的证据 | 后续必须取得的证据 | 当前结论 |
| --- | --- | --- | --- |
| V-01 | 官方临时回复路径与到期字段 | 当前应用类型的限制依据，单轮三条、限流、超长及到期测试 | 未验收 |
| V-02 | 按机器人及企业用户发送的 OpenAPI 模型 | 授权、用户映射、过期后仍落原私聊、失效分支 | 未验收 |
| V-03 | 当前版本与 steer 接收/消费静态路径；README 历史实验 | 已登录真实环境的三轮续接、正常重启、写入权冲突，以及各运行状态下 steer 实际生效 | 未验收 |
| V-04 | 内部问题/授权处理方法存在 | 问题、批准、拒绝、歧义、跨私聊、撤销和未知接收完整往返 | 未验收 |
| V-05 | 原始消息和推送字段；部分输出元数据 | 原始标识稳定性及范围、片段身份、流与历史重叠、执行/投递结果核实边界 | 未验收 |

方案层选型均有明确决策，不留需求澄清占位符。以上未验收项不能用设计决定或测试用 Harness 结果替代。
生成任务时应先安排真实适配准入实验，再安排依赖这些能力的适配实现与端到端验收；
通用路由和持久状态可独立使用测试用适配器开发。具体实验步骤见 [quickstart.md](quickstart.md)。
