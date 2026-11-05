# 阶段性能力矩阵

日期：2026-11-05。这是缺口登记，不是 T078 的最终验收结果；T077 尚未完成，T078 保持未勾选。
mock Harness/适配器版本均为 1；fake 平台版本 1。WorkBuddy 桌面版本 5.6.2，真实适配器未创建；钉钉 SDK 2.1.5。
上下文与指纹使用临时别名，未输出真实指纹、原身份或端点。

| 能力 | 模拟验证范围 | 真实结果/当前有效性 |
| --- | --- | --- |
| isolatedSessions | 两私聊独立 Harness 会话与接收人 | blocked / unverified |
| createAndResume | 保留外部 fake Harness 的 Courier 重启 | blocked / unverified |
| writerOwnership | 写入冲突不接管、只恢复原绑定 | blocked / unverified |
| timelySteer | running/waiting_input 当前 Run 内实际消费；拒绝排队/延后消费 | blocked / unverified |
| inputCorrelation | 快速 handle、accepted/applied、晚确认与冲突 | blocked / unverified |
| explicitCompletion | 可靠终态独立于文本和流关闭 | blocked / unverified |
| typedVisibleOutput | 3/1/2/0 策略、未知内容隔离 | blocked / unverified |
| messageAssembly | 0..N、N=-1、乱序、重投、正常重复、尾片段与冲突 | blocked / unverified |
| humanInteraction | 问答/批准/拒绝、原映射、未知与撤销恢复 | blocked / unverified |
| inspectOperation | fixture 可为指定操作提供权威只读证据；默认不宣称通用查询支持 | not_tested / unverified |
| replayEvents | 合成可靠事件重投幂等；缺身份不声称重播 | not_tested / unverified |
| serverIdempotency | 未依赖远端幂等；unknown 停止重放 | not_tested / unverified |
| 平台 ingress / 原始 ID 范围 | 合成独立推送/原始 ID 与跨重启去重；真实连接及 1 条带标识私聊已观察 | 单样本观察；重投稳定性/作用域 not_tested，整体 unverified |
| 平台 delivery / 多消息 / 限额 | 合成作用域预算、顺序、重试、unknown | not_tested / unverified |
| 同私聊 OTO | 没有证据即拒绝备用路径 | not_tested / unverified；未宣称存在备用路径 |
| 平台 inspectDelivery | 三种有/无权威查询结果 | not_tested / unverified |

模拟 evidence 的 checkedAt 为测试时钟，context 使用别名 context-A/B；无默认 expiresAt，未撤销事实不被改写。
真实必需能力尚无 passed 证据，因此 checkedAt/expiresAt/invalidatedAt 均无可登记的当前有效通过记录。
not_tested/blocked 对应 CapabilityEvidence.outcome=unverified，不能当作 passed。
启动、重载/重连及每次新副作用检查版本、上下文、期限、撤销和当前探测；fake 证据只用于 fake。
真实 serve 目前直接拒绝，故不能由手工改时间戳或配置 true 取得支持声明。
