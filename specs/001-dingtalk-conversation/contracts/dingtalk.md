# 钉钉平台适配契约 v1

本契约的 conversation 指钉钉会话；`conversationId` 是钉钉提供的平台会话标识，按平台范围和机器人共同定界。
`sessionWebhook` 虽包含 session 字样，含义仍是原钉钉会话的临时回复地址，不是 Courier 会话或 Harness 会话 ID。

范围为企业内部应用机器人文本私聊，Stream 只接收入站，出站独立发送。
这是拟议契约；数值限额、授权和真实能力仍须按 V-01/V-02/V-05 验收。
来源与证据冲突见 [research.md](../research.md) R-03 至 R-05。

## 入站信封

下表的归一化 `platformConversationId` 仍是钉钉原始 `conversationId`。应用层据平台范围、机器人及此标识
查找本地 PlatformConversation 记录，再将其本地 ID 用于 Courier 会话等实体的关联，不能直接复制为本地外键。

| 来源字段 | 归一化字段 | 约束 |
| --- | --- | --- |
| Stream headers.messageId | transportMessageId | 对应一次推送与 ACK；不能直接作为业务去重身份 |
| data.msgId | originalMessageId | 原消息候选标识；重投稳定性和作用域须验证 |
| data.chatbotCorpId / 配置应用范围 | platformScope | 必须与配置范围一致；不能根据昵称猜租户 |
| data.robotCode / data.chatbotUserId | robotCode / chatbotUserId | 分别保留；配置建立 robotId 映射，不视为同一个字段 |
| data.conversationId | platformConversationId | 与范围、机器人一起构成私聊隔离键 |
| data.conversationType | conversationType | 已知类型 "1" 为私聊、"2" 为群聊；未知类型不提交 Harness |
| data.senderId | senderId | 消息来源，不用作额外人工答复者权限判定 |
| data.senderStaffId | enterpriseUserId? | 可缺失；与企业范围核实后才用于候选 OTO 路径 |
| data.msgtype / text.content | contentType / text | 首版仅非空文本；空白检查不改写合法正文 |
| data.sessionWebhook / sessionWebhookExpiredTime | sensitiveCapabilityRef / expiresAt | URL 私有存储，不能进入日志或配置示例 |

平台端口返回 `NormalizedInbound`，包含上述关联、receivedAt、dedupNamespace、
可靠身份的 evidenceRef。原始包不进入应用路由，不把整包写共享日志。
不同平台消息即使正文相同也形成独立输入；群消息在创建本地平台会话记录、Courier 会话、Harness 会话和正文持久化前过滤。

入站顺序：验证连接/消息范围 → 识别群或私聊 → 验证标识与内容 → 短事务登记 → ACK → 转交。
ACK 仅表示接收处理，不产生聊天气泡。数据库失败不得先成功 ACK 再丢弃输入。
未知类型/跨应用消息仅 ACK 丢弃并记安全指标；有效私聊的空文本或附件给出一次限制提示。
标识不可靠时拒绝执行，保留平台能力未验证状态，不以内容补造去重键。

## 机器人中的人工答复文本

问题或权限提示由 Harness 返回的请求正文和 Courier 提供的安全关联信息组成。
首版采用以下明确语法；这些是产品命令契约，不是现有可运行功能：

```text
/答复 Q7K9 用户对该问题的回答
/批准 P4M2
/拒绝 P4M2
```

编号只在原私聊内解析，且不得复用给新的请求。权限有多种批准范围时，提示列出范围与独立选项码，
语法为 `/批准 P4M2 O1`；不省略选择后默认扩大范围。
问题默认接收编号后的完整文本。Harness 若明确要求多个字段，提示列出字段编号与必填项，
该请求仅接收 JSON 对象，例如 `/答复 Q7K9 {"F1":"值一","F2":"值二"}`；
按 JSON 标准转义，缺字段、未知字段或选项不合法时澄清，不生成替代答案。
字段/选项只能来自原请求的已验证映射；单文本问题不解析正文中的 JSON。

只有明确语法且归属唯一的有效答复才调用 answer；正文提到某编号或普通“同意”不能自动批准。
在有待答请求时，单独肯定/否定且可能被理解为答复的短语应提示使用明确编号，不送为授权或 steer；
规则采用固定、可测试的语法/歧义词集，不使用模型猜测意图。
其他普通任务补充继续走 steer。用户可用 `/补充 文本` 明确声明普通输入意图，
平台适配器移除命令前缀后将正文转交路由；不会创建普通输入队列。

多个请求、缺编号、缺选项、请求失效或来自其他私聊时，仅提示关联问题，不能泄露其他请求正文。
不引入答复者名单、角色或“仅发起人”规则；隔离依据是原私聊与原任务请求的映射。

## 出站端口

`send(deliveryId, recipient, payload, route)` 返回以下明确结果：

| 结果 | 必须保留的信息 | 行为 |
| --- | --- | --- |
| confirmed | providerReceipt?, acceptedAt, evidence | 平台确认接收；不是已读证明；禁止重复发送 |
| not_sent | code, retryable, retryAfter? | 只有确认未成功才可重试；检查剩余预算 |
| unknown | safeReason, queryRef? | 不自动补发；先核实，暂停该私聊后续出站 |
| route_unavailable | expired/auth/recipient/limit 等安全原因 | 等待同目标可用路径或终态失败，不跨对话改投 |

`inspectDelivery` 可返回 confirmed/not_sent/unknown/unsupported；没有查询能力不等于未发送。
核实 confirmed 后标 delivered 并解除顺序阻塞；not_sent 按原累计尝试数进入 retry_wait 或 failed；
unknown/unsupported 仍保持 unknown。核实、重启或换路径都不产生新预算。
HTTP 200 不代表业务成功：必须解析业务码；OTO 按原接收人解析无效、限流、过滤结果。
响应丢失或请求发出后超时不能当 not_sent。关闭 SDK/HTTP 客户端对发送请求的隐式重试。

## 路径、限额与顺序

- webhook 路径属于确切原私聊，过期时间来自平台字段；不固定到期时长，不把 URL 当稳定钉钉会话 ID。
  后续消息提供的新 webhook 仅在完整私聊键匹配后可更新路径，不改变已有 Delivery 的目标。
- OTO 路径必须有机器人权限、企业用户映射以及“同一机器人原私聊”的实测证据；
  userIds 仅一个原接收人。没有该证据就不作为备用路径。
- `verifiedLimits` 包含最大文本长度及计量单位、路由累计条数规则、各限频作用域/窗口、
  到期规则、官方依据与实测覆盖。未公开的上限可明确记 unknown，但需有平台确认的可用预算；
  无依据的猜测不能启用真实多消息支持。
- 调度同时约束应用/机器人、接收人及具体路由的已验证预算；耗尽时按平台规则等待，
  这属于出站调度，不是普通输入排队。令牌或 webhook 不写入共享指标。
- 单条文本超限明确失败，不截断、不默认拆分。默认进度不合并；开启后只合并尚未发送的相邻完整进度，
  合并内容超限则保留为原消息逐条发送。
- 明确临时失败的首次尝试后最多两次自动重试。基础退避可取 1 秒、2 秒并加入抖动，
  实际等待不得小于平台 Retry-After、限流窗口或限额配置所需时间；不能把示例退避当平台限额。
- 切换发送路径不重置尝试数；unknown 不通过切换 webhook/OTO 自动补发。
  未确认成功前不得跨过前序消息发送后序消息；明确终态失败后可继续并记录内容缺失。

## 必需真实验证

V-01 取得适用文档限制，并验证同一输入的两条进度加最终回答、长度边界、限流及过期。
V-02 验证过期后同私聊路径及未授权/无映射时的限制。
V-05 比较原消息在真实重投中的 msgId 与推送 ID，记录唯一作用域；
同正文新发送必须是新输入。发送超时没有权威结果时保持 unknown，不能声称恰好一次。
真实验证不进行高频冲击测试；在有依据的预算内测试，额度上限以官方依据为准。
