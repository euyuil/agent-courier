# US1 离线验证

日期：2026-11-05。环境：Node 24.22.0、SQLite 3.53.4，mock Harness / fake 平台；没有真实账号连接。

实际执行 `npm run build`、`npm run typecheck`、`npm test`，累计 20 个测试通过。
US1 新增测试先产生 6 个缺失行为失败，再接通实现。构建后 CLI 的 `validate-config` 与 fake `serve` 退出码均为 0，单条合成输入投递 3 条逻辑消息。

- Q-01：三轮 start=3、create=1，首轮后重启沿用原 Harness 会话和标记。
- Q-02：两个私聊 create=2，正文与接收目标对应；群/未知类型/跨范围不建立记录或执行。
- Q-03：空文本与附件各一条限制提示；重复原消息不重复提示；缺身份零执行。
- Q-04：start=1、steer=2、原 Run 内实际消费=2、例行状态提示=0，相同正文新 ID 保留。
- Q-05：queued/late/unsupported 准入拒绝；拒绝/unknown 各 steer=1，无新 start；并发首建仅一个绑定和 start。

Node 子进程在受限执行环境中可能提前退出或无法运行；进程行为测试使用获准宿主执行方式，SIGKILL 后锁释放通过。测试脚本关闭文件级子进程隔离，避免未执行子测试被误报为文件通过。

这些结果仅证明模拟核心；V-01 至 V-05、T031 至 T035 尚未通过，不能声明真实钉钉或 WorkBuddy 支持。
