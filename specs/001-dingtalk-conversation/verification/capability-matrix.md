# 阶段性能力矩阵

日期：2026-11-06。这是缺口登记，不是 T078 的最终验收结果；T077 尚未完成，T078 保持未勾选。
mock Harness/适配器版本均为 1；fake 平台版本 1。WorkBuddy 桌面版本 5.6.2，实验适配器代码版本 1，未准入；钉钉 SDK 2.1.5。
上下文与指纹使用临时别名，未输出真实指纹、原身份或端点。

| 能力 | 模拟验证范围 | 真实结果/当前有效性 |
| --- | --- | --- |
| isolatedSessions | 两私聊独立 Harness 会话与接收人；新建回复复用已知标识时不覆盖原关联 | 已观察同一已登录实例的两个不同 Harness 会话；新连接分别 load 原标识，各自只输出本会话未重述的标记，五个 ACP Run 均 end_turn。两个钉钉用户、同时活动 Run 与实际 Courier 路由/重启未验证，整体 unverified；见 isolation-2026-11-06.md |
| createAndResume | 保留外部 fake Harness 的 Courier 重启 | 独立桌面 API 已释放后加载原 Harness 会话并复述上下文；新 ACP 创建路径也已正常断连/load 并复述原上下文；Courier 重启链路仍 unverified |
| writerOwnership | 写入冲突不接管、只恢复原绑定；独占配置核对空白 H，未知初始化不重发，H/未知上下文不能承接输入 | 操作者确认首版使用 Courier 独占 A/B；不要求桌面已有用户会话接管。生产独占模式已观察 H 正常释放后，在新空白 H2 后端中 load 原 A 并精确恢复上下文。宿主自动发现/激活、完整生命周期和版本证据仍不足，整体 unverified；见 courier-exclusive-2026-11-06.md |
| timelySteer | running/waiting_input 当前 Run 内实际消费；拒绝排队/原任务结束后才消费；候选真实适配器已合成验证原 Run 注入回执及晚确认 | 两条补充在 running（含同文不同本地输入 ID）、受控长工具、问题待答及受控报告后期均已观察原任务内生效；另有 idle/stale、斜杠拒绝及自有连接故障注入 unknown 样本。权限等待、完整重连/恢复及其他时序/整条链路仍缺证，整体 blocked / unverified |
| inputCorrelation | 快速 handle、accepted/applied、晚确认与冲突；已核验注入边和原 messageRequestId 同时约束输出，后续控制使用当前厂商 owner | 连续两条 running steer 及同文不同输入 ID 均已观察独立操作/消费回执和原提交内输出；故障注入 unknown 在私有 SQLite 重开及对象重建后没有增加 RPC/POST，但不等于跨进程恢复。完整状态和恢复范围仍缺证，整体 blocked / unverified |
| explicitCompletion | 可靠终态独立于文本和流关闭 | 真实文本任务有 stopReason、isProcessing=false；另有完成后控制明确 idle 拒绝、约 5.2 秒观察无新工作样本；完整终态/竞态仍 unverified |
| typedVisibleOutput | 3/1/2/0 策略、未知内容隔离 | 普通 ACP 文本仍无可靠分类；显式 MCP 纯格式化来源已实现并局部观察 progress/progress/final，类型来自工具结构化字段。常规模式/输出约定及实现指纹已接入，普通请求三消息已有独立观察；完整 steer/恢复范围仍未准入，代码强制 unverified |
| messageAssembly | 0..N、N=-1、乱序、重投、正常重复、尾片段与冲突 | 显式格式化来源以原生 toolCallId 和 completed/结果回显组成完整快照；两个同文调用已各保留，final 与 Run 分开。重放/交叠/重启等仍缺证；普通 Hook 不能作为转录刷新屏障，代码强制 unverified |
| humanInteraction | 问答/批准/拒绝、原映射、未知与撤销恢复；原工具关联、双通道合并、原调用明确 receipt | 原始 ACP 已观察待答期间两条补充、补充触发第二题、两个答案分别明确接收及原 Run end_turn；组合正文全部标记仍未通过。工具的不同请求字段须同属已核实原 Run 证明链；未知字段登记及误撤销回归已修复。另有一次权限拒绝/原 Run 取消；批准、更多拒绝/恢复及完整 Courier/钉钉链路仍缺证，代码强制 unverified |
| inspectOperation | fixture 可为指定操作提供权威只读证据；默认不宣称通用查询支持 | not_tested / unverified |
| replayEvents | 合成可靠事件重投幂等；缺身份不声称重播 | not_tested / unverified |
| serverIdempotency | 未依赖远端幂等；unknown 停止重放 | not_tested / unverified |
| 平台 ingress / 原始 ID 范围 | 合成独立推送/原始 ID 与跨重启去重；真实连接及 1 条带标识私聊、新 SDK worker 连接/关闭已观察 | 单样本观察；真实持久登记后 ACK 与重投稳定性/作用域 not_tested，整体 unverified |
| 平台 delivery / 多消息 / 限额 | 合成作用域预算、顺序、重试、unknown | not_tested / unverified |
| 同私聊 OTO | 没有证据即拒绝备用路径 | not_tested / unverified；未宣称存在备用路径 |
| 平台 inspectDelivery | 三种有/无权威查询结果 | not_tested / unverified |

模拟 evidence 的 checkedAt 为测试时钟，context 使用别名 context-A/B；无默认 expiresAt，未撤销事实不被改写。
真实必需能力尚无 passed 证据，因此 checkedAt/expiresAt/invalidatedAt 均无可登记的当前有效通过记录。
not_tested/blocked 对应 CapabilityEvidence.outcome=unverified，不能当作 passed。
启动、重载/重连及每次新副作用检查版本、上下文、期限、撤销和当前探测；fake 证据只用于 fake。
真实 serve 在依赖组合的准入检查中拒绝当前目标；真实模式不会生成 fake 证据或合成投递路由。手工改时间戳、配置 true 或伪填 passed 不能覆盖适配器明确保留的 unverified 能力。

实现范围及尚未完成的协议映射见 adapter-implementation.md。OTO/权威查询的代码分支明确禁用，不能把“禁用”写成平台已被实验否定。
具体调用入口、原子 steer、输出信号及官方平台文档的限制见 protocol-gaps.md；代码中的候选消费回执不自动产生 passed 证据。

2026-11-06 又补充一次经操作者明确授权的纯格式化工具权限批准：153 帧中一次 allow、原始和归一化接收、原工具/消息完成及原 Run end_turn 均匹配。该证据只覆盖本次准确合成请求，未覆盖其他工具、权限等待中的双补充、重连/恢复或 Courier/钉钉链路；humanInteraction 仍硬编码 unverified，不登记完整能力 passed。原生权限相关 UUID 不当作 Run，参数增量须等 toolArgumentsComplete 才能满足本探测的批准条件；版本和范围见 formatter-permission-2026-11-06.md。本次单次授权已使用。
