# 当前协议缺口与实现边界

日期：2026-11-06。以下依据用于区分可以继续编写的适配代码与仍需要接口能力、实际授权和验收的部分。
不授予真实服务准入。

## WorkBuddy

范围为桌面 5.6.2 的安装包静态检查及已有独立实验；不代表未来版本契约。

| 路径 | 已确认的代码语义 | Courier 的处理与剩余缺口 |
| --- | --- | --- |
| 原子 session/steer | 先检查输入形式，再校验 expectedRequestId 和活动状态；接收返回 steered 与 ownerRequestId，只表示进入原 Run 的缓冲区。形式拒绝可仅返回 steered=false、无 reason | 保留独立操作、原 Run 和输入标识；不换为 prompt 或排队。运行中合成斜杠拒绝已有独立样本，不与 idle/stale 混淆 |
| 注入后的用户消息 | 注入回执同时包含旧 conversationRequestId、新 requestId、原输入 messageRequestId 和原操作元数据；后续输出的新厂商标识与原提交 messageRequestId 已由独立真实轨迹核对 | 仅匹配自身原操作及完整元数据时产生 input.applied 并登记厂商标识延续边；可见输出还必须指向原提交。未知边、错误来源、分叉及迟到跨 Run 输出不能借用当前 Run |
| 预分配 Run 标识 | 正常 session:sendMessage 接收元数据，codebuddy.ai/conversationRequestId 可传入与生产 start 相同的 UUIDv7；原始 ACP 实际输出已观察匹配 | 连续两条 running steer 已在原提交内分别改变内容；待答期间接收的两条补充也在原问题答复后、原提交返回前分别注入并影响输出。完整状态和整条链路仍缺证 |
| 候选 promptRequestId | 静态拥有者转发路径可写入该字段；新真实样本的两条路径均未找到匹配原提交的该字段，关联帧计数为零，所核对的末尾帧缺少该字段 | 没有据此归一化不同 conversationRequestId；缺少 unsolicitedTurn/background_drain 信号也不作为仍属原 Run 的证明 |
| 执行阶段与进度控制 | agentPhaseInfo 的 preparing/model_requesting/model_streaming/model_done/工具等待/idle 是执行阶段；progress 控制帧没有已验证的逐文本分类和结束契约 | 不把模型结束或空闲当成某条文本的 final，不用阶段信息生成片段身份，G-H-OUTPUT 保持未准入 |
| 桌面队列 API | enqueueMessage 与 sendQueueItemNow 分两步，状态变化时可能保留队列或进入另一轮 | 不作为及时 steer 的替代实现 |
| 桌面通用 ACP channel | 检查 115 个 main 顶层脚本，只在常量表找到 session:acpRequest，未找到相应注册处理器 | 不把声明的名字当作已实现的正常调用入口，也不从进程环境或内存提取认证信息 |
| 原始 ACP 连接 | 自有合成测试进程的回环 HTTP/SSE 订阅与 initialize 已由生产适配器完成；原 Harness 会话 load 明确返回 writer_occupied | 实验发现入口仍未生产化；正常写入权交接与原始 ACP 执行仍需验证，不重建 Harness 会话或强夺其他客户端控制权 |
| ACP session/new | 首次 new 使用 CLI 启动标识；2026-11-06 显式初始化本次自有启动 Harness 会话后，同一 ACP 连接再次新建取得不同标识；生产适配器执行、正常断连/load 及上下文恢复均已独立复现 | 首次返回已知标识的冲突保护保留；初始化未知/不匹配即停止。新路径仍未建立正常发现/激活和生命周期契约，也不证明桌面原 Harness 会话写入权交接，详见接口补充调查 |
| 文本事件 | 已定位转换路径会产生普通文本与消息 ID；独立样本未见可靠 progress/final 分类，若干模型结束事件在转换中没有生成文本类型标识 | 普通文本保持 message；不猜最后一条就是 final。稳定片段身份和独立逻辑消息结束仍缺少可靠映射，G-H-OUTPUT 保持未准入 |
| 普通 Hook / 转录 | 两个原 Run 的 session_id/generation_id、Stop 完整正文及 completed 的 FinalStop 已独立观察；自有转录在 Stop 时可能尚无本轮完整回答，到 FinalStop 才出现本轮消息身份。当前未找到新版 Mods 加载入口 | Hook 无逐消息/片段字段；转录没有本次所需分类，不能按相同文本、旧记录或到达次序补齐。完整桥接仍未准入，见 hook-output-2026-11-06.md |
| 人工输入 | 原生 AskUserQuestion 受 question 能力声明控制；修复握手后已复现原始 ACP 单选题/答案/续行；另观察一次原始 ACP 执行权限拒绝明确接收及原 Run 取消。原工具 cancelled 的待答撤销已修复 | 拒绝路径的原生工具取消标记未出现，不编造。无法映射时安全阻塞；完整 Courier/钉钉、权限批准及恢复仍未验证，humanInteraction 仍 unverified |

原操作意图持久化后结果未知时不重发。客户端消息标识和自有元数据仅用于关联，不当作远端幂等保证。
同文不同本地输入 ID 的两次 running steer 已观察各自消费与后续独立逻辑输出；这不改变未知操作不重放的规则，也不证明服务端按相同客户端标识去重。
受控长工具步骤中连续两条补充也已观察接收，并在工具返回后、原正常提交结束前分别消费和影响输出；两个注入回执共享同一厂商 owner 延续关系，原操作/输入仍分别校验。
完成后的旧 Run 控制已有真实 idle 拒绝样本，生产解析为 rejected/stale_run/definitelyNotAccepted；约 5.2 秒观察没有新事件、历史变化或消费回执。未将完成后拒绝扩大为临近完成的及时消费证据。
受控报告后期另有完整样本：原 Run 同一消息进入预设第 18/20 行，且原正常提交未返回、未见原始终态时，连续两条补充分别消费并影响内容，两次消费均早于原始终态。该文本标记只是实验触发条件，不补成 progress/final 分类或通用临近完成信号；权限等待和故障恢复等仍缺证。
另行故障样本中，不匹配 expectedRequestId 取得明确 stale 拒绝；另一正确目标控制在 fetch 启动后关闭本次 Courier 连接，receipt 为 unknown。私有 SQLite 关闭/重开及对象重建后没有再调用 RPC 或发起 POST，正常桌面原提交继续 end_turn。该本机故障注入不证明服务器接收了输入，也不代替跨进程 Courier 重启或权威结果核实。

上述控制观察与新的独立创建/恢复路径，仍没有补齐正常发现/激活与生命周期、桌面原 Harness 会话写入权交接，以及逐文本分类、稳定片段和独立消息结束契约。当前候选代码对必需输出及完整人工能力仍明确保留 unverified，真实组合无法准入；继续条件与未完成任务审计见 implementation-review.md 和 interface-research-2026-11-06.md。
新的输出分类接口、正常发现/激活方式及跨客户端控制权流程仍需明确；修改配置或填写 passed 不能补齐这些能力。

## 钉钉官方文档复核

本轮直接读取了官方公开 Markdown 文档；没有访问真实机器人发送地址或修改应用权限。

- [机器人回复/发送消息](https://open.dingtalk.com/document/dingstart/robot-reply-and-send-messages.md)分别给出应用机器人的 webhook 和入站 sessionWebhook 回复示例。后者的文本结构与当前候选传输一致；示例不证明同地址的可用条数、限频或真实投递成功。
- [机器人接收消息](https://open.dingtalk.com/document/orgapp/receive-message.md)列出了原始消息、机器人、私聊和回复到期字段；据此保留字段含义，但真实重投稳定性及唯一作用域仍需观察。
- [自定义机器人发送群消息](https://open.dingtalk.com/document/orgapp/custom-robots-send-group-messages.md)中的每分钟 20 条及超出后限流 10 分钟，明确针对自定义机器人的群消息，不能作为本项目企业应用机器人私聊的预算。
- [批量发送人与机器人会话中机器人消息](https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches.md)要求企业用户标识和应用凭证，返回过程查询键、无效及限流接收人列表；正文与某个超限错误描述的批量上限还不一致。本项目只允许原接收人一个元素，仍不能据此推导 sessionWebhook 的累计预算或同私聊身份。
- [批量查询人与机器人会话机器人消息是否已读](https://open.dingtalk.com/document/orgapp/chatbot-batch-query-the-read-status-of-messages.md)提供已读查询；过程键未产生或过期并不证明消息没有发送，因此不能作为未知投递的自动重试依据。

适用于原私聊 sessionWebhook 的数值长度、累计条数与限频仍未取得足够依据，保留未验证状态。
通用解码器与真实 webhook 传输统一：明确业务成功才确认，未知非零码保持 unknown。
本轮没有发送新的钉钉聊天消息。
