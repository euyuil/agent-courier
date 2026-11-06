# US2 离线验证

日期：2026-11-05；fake 平台与 mock Harness，Node 24.22.0 / SQLite 3.53.4。

执行 `npm test`，34 个测试通过。恢复测试先观察到 dispatching 未归约为 unknown 的行为失败，接入恢复后通过。

- Q-06：原始 ID 并发重投十次只 start 一次；steer 重投十次只调用一次；相同文本新 ID 保留；重启后仍去重。
- Q-07：第二条明确失败，Retry-After 之前不重发；可见顺序 one/two/three，总尝试 4，start=1。
- Q-08：单条最多 3 次，耗尽后 final 继续，只生成一次缺失提示；不递归生成错误消息。
- Q-09：写入冲突、原 Harness 会话缺失与登录失效保留原绑定，create 不增加。
- Q-10：过期路径零发送；同原目标新路径可用；换路径不重置次数。长文本计量与更多限额组合在输出阶段追加。
- Q-18：合成敏感异常不进入提示、状态或诊断；HTTP 200 仍核对业务码，不输出原始 errmsg。
- Q-19：create/start/steer/send 在派发前、远端接收后和落盘后注入中断；恢复不重放，已接收事实保留。这里是异常注入及真实 SQLite 重开；生命周期锁另用真实子进程 SIGKILL 验证。
- Q-20：unknown 只阻塞原私聊，其他私聊继续；confirmed/not_sent/unsupported 核实不发送，原尝试数不变。
- Q-21：晚到 accepted 不回退 completed；答复与请求撤销分支由 US3 追加。

CLI 提供脱敏只读 status 和互斥的 reconcile 参数；mock 跨进程没有远端查询权威，返回退出码 5，保持 unknown。真实查询适配、OTO 与真实发送仍未启用。

并行投递补充回归：一个私聊派发阶段抛错、另一个仍在途时，关闭必须等待后者完成并落盘，再报告批次错误。
重启后前者为 unknown、后者仍 delivered；不会因为关闭或重启再次发送，其他私聊的在途结果不会遗漏。
