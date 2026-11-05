# 配置与本地管理契约 v1

本契约定义未来实现入口，不表示当前已有 CLI、配置加载器或 package.json。
首版没有外部事件 API、群聊入口、Web 管理站点或独立用户权限系统。

## 本地配置

配置使用 JSON，schemaVersion 固定为 1。由 Zod 校验未知字段、类型与跨字段约束；
相对文件路径按配置文件所在目录解析。真实配置和状态库放在 Git 外，仓库仅保存脱敏样例。

| 配置项 | 含义与校验 |
| --- | --- |
| schemaVersion | 必须为 1 |
| storage.databasePath | 本地磁盘文件；不能位于已知网络挂载；目录仅运行账号可访问 |
| platform.kind | dingtalk-stream；测试模式显式使用 fake，不可混为真实验收 |
| platform.scopeRef / robotRef | 目标平台范围与机器人身份引用，启动时校验与正常凭据配置匹配 |
| platform.clientIdRef / clientSecretRef | 操作者主动配置的凭据引用，不读取其他进程内存/环境，不输出其值 |
| platform.limitProfileRef | 当前应用类型/路径的已验证限额与证据；没有依据不开放真实多消息能力 |
| platform.otoRouteEvidenceRef | 可选；没有同私聊路径与授权证据则不启用备用发送 |
| harness.instanceId / adapter | 指定实例及 workbuddy-experimental；mock 仅测试模式使用 |
| harness.connectionProfileRef | 操作者正常配置的连接方式；不硬编码端点、端口、PID 或账号 |
| harness.capabilityEvidenceRef | 必需能力的版本、状态覆盖、验证上下文与结果证据；期限和撤销信息随证据保存，不能用布尔值跳过 |
| display.defaults | 见数据模型默认值；问题/权限不可关闭 |
| display.overrides | 以完整私聊映射引用覆盖策略，不能按最近消息猜目标 |
| delivery.maxAutomaticRetries | 固定上限 2，不能配置更高；平台要求的等待优先 |

配置只声明一个默认 Harness 实例；每个私聊单独建立 Harness 会话。
修改默认实例不能迁移已有绑定；已有绑定与新配置冲突时拒绝相关路由并明确提示。
配置重载先整体校验，失败则保留旧有效配置；成功后新建任务采用新策略，活动 Run 继续原快照。
没有另一条人工交互路径，question=false 或 permissionRequest=false 必须拒绝。

凭据引用允许操作系统凭据设施或操作者提供的私有文件；不能把 WorkBuddy 进程环境当作凭据来源。
临时 webhook 属于敏感能力，由平台适配器保存为私有引用；普通日志和状态查询不展开引用。
使用 SQLite 本身不意味着已加密：文件权限、Git 外存放和备份保护都须落实，不能宣称有未实现的加密。

## 拟议 CLI

下列名称是待实现接口约定。当前仓库不能运行这些命令，也没有对应构建/测试脚本。
`status --session` 选择的是 Courier 会话，其值为本地 `CourierSession.id`，不是钉钉 `conversationId`
或 `HarnessBinding.harnessSessionId`；状态 JSON 的 `session` 字段也使用同一层的 ID。

| 命令形式 | 语义 | 副作用边界 |
| --- | --- | --- |
| `courier validate-config --config <CONFIG>` | 校验结构、策略与静态证据引用；安全错误输出 | 不登录、不执行任务、不发送消息 |
| `courier serve --config <CONFIG>` | 打开状态库、检查单实例、恢复关联、连接已配置平台/适配器 | 仅处理真实收到且通过检查的输入；不自动重放旧操作 |
| `courier status --config <CONFIG> --session <COURIER_SESSION_ID> --json` | 查询指定 Courier 会话的本地输入、执行、请求、投递及能力限制 | 只读，默认脱敏，不输出真实平台身份/正文/路径/URL |
| `courier reconcile --config <CONFIG> --operation <LOCAL_OPERATION_ID>` | 通过已验证只读查询核实一项 unknown，并保存得到的证据 | 不 start/steer/answer/send；查询不支持则保持 unknown |
| `courier reconcile --config <CONFIG> --delivery <LOCAL_DELIVERY_ID>` | 核实未知投递，保存原尝试的权威结果，解除已解决的顺序阻塞 | 不补发；serve 下次启动只对已核实可重试且预算未耗尽的投递继续调度 |

CLI 故障退出码：0 表示命令正常完成，2 为配置/用法错误，3 为能力或认证不满足，
4 为存储不可用，5 为核实结果仍未知。`status` 的 0 仅代表查询成功，不能被解释为任务成功。
`reconcile` 的 operation/delivery 参数互斥；不允许“假定未执行”参数，核实未接收后也不会自动提交旧普通输入。
首版不提供 replay、force-takeover、cancel、approve-all、切换 Harness 或创建外部事件的命令。

单实例互斥覆盖服务整个生命周期；status 只读查询不充当第二个消费者。
reconcile 会更新本地证据，必须在 serve 停止后取得同一互斥锁；服务运行时拒绝该命令，
不绕过锁成为第二写入进程。对平台/Harness 的核实仅允许无副作用查询，不能通过重发来探测结果。
可采用由 SQLite 独立锁文件数据库持有的生命周期排他事务作为同机互斥，
与业务状态数据库分离；仅锁库持有长事务，业务事务保持短小。
异常退出由文件锁释放互斥，不能留下需要盲目删除的 PID 锁。
退出只断开 Courier 自有连接，不擅自取消 Harness 中正在执行的 Agent 任务。

## 安全状态输出

示例中的关联 ID 均为虚构；真实共享导出必须重新映射别名：

```json
{
  "session": "courier-session-example",
  "input": {"id": "input-example", "mode": "steer", "status": "unknown"},
  "execution": {"id": "run-example", "status": "running"},
  "pendingInputCount": 0,
  "delivery": {"pending": 1, "delivered": 2, "failed": 0, "unknown": 0},
  "reason": "state_unknown",
  "nextAction": "核实原输入接收状态；不要重复提交"
}
```

输入接收未知不必把仍有可靠运行证据的 Run 改成 unknown；两个事实独立。
用户错误提示使用安全模板，例如“本次补充是否被接收尚无法确认，未再次提交。请核实原任务连接。”
正常接收/steer 不产生这种提示；只有真实失败或阻塞才输出。
不直接回显底层异常，即使错误栈带有路径、令牌或用户内容。

## 配置与运行前检查

启动校验 Node 支持基线、驱动内嵌 SQLite 版本、数据库迁移状态及配置约束；
核实平台范围、Harness 身份和匹配版本的能力证据，按 [数据模型的有效性规则](../data-model.md#能力证据有效性)
比较 contextFingerprint、checkedAt、可选 expiresAt 与 invalidatedAt；过期、缺失、撤销、版本或上下文
不匹配均不能沿用为 supported。没有明确期限时不自设 TTL，版本/上下文检查和当前认证检查仍须执行。
启动、重连、配置重载及相关新副作用开始前均执行该规则；失效后仅以受影响范围的新验证记录恢复准入，
不能通过修改旧时间戳续期。投递路径自身的 expiresAt 独立检查，不能与能力证据期限混用。
正常官方登录和平台授权由操作者完成；登录失效时报告恢复条件，不尝试获取其他产品的登录状态。
测试模式使用显式 fake 配置，不读取真实账号引用，也不建立外部连接。
