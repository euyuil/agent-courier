# 原始 ACP 执行权限拒绝与待答撤销

日期：2026-11-06。范围为本机 WorkBuddy 5.6.2、自有隔离 Harness 会话、生产 ACP 适配器和合成传输回归。
不授予完整人工交互或真实服务准入，没有进行权限批准或钉钉投递。

## 显式拒绝探测

新增 `--acp-bootstrap-owned-denial`，包含已验证的独立创建、正常断连/load 和上下文检查。
只在新的私有测试目录写入 `.codebuddy/settings.local.json` 的 `permissions.ask=["Bash"]`；不读取或改写用户配置。
配置文件只表示实验条件，是否出现权限请求以真实事件为准，不把配置存在当作生效证明。
另通过本次自有 Harness 会话的 `session/set_config_option` 将 mode 收紧为 default，并核对返回的 currentValue。

第三个任务只请求一次 `python3 -I -S -c "print('CourierPermission-<RANDOM>')"`。
只有原 Harness 会话、原 Run、原工具、完整命令、原生 interruption 路径及用户可见拒绝选项一致时，才经生产适配器提交一次 deny。
未知、不匹配、撤销或原任务先结束均不转交决定；不批准、不重试，不换为其他通道或任务。

| 最后一个独立真实样本 | 观察 |
| --- | --- |
| 正常登录及版本 | 已观察；5.6.2 |
| 前置记忆及原上下文恢复 | 均 accepted/completed/end_turn，标记匹配 |
| session RPC 数 | new=2、load=1、prompt=3；另有本次 mode 配置调用 |
| 当前模式 | 返回 mode.currentValue=default |
| 原始人工请求 | 原 Run 的 permission 请求，生产原工具/命令解析匹配；1 个原生来源 |
| 拒绝决定 | 只提交 1 次；receipt=accepted，对应 operation/input 的 input.accepted 已观察 |
| 原 Run 终态 | 原始 session/prompt.stopReason=cancelled；归一事件为 run.failed |
| 其他工具调用 | 未观察到不同工具 ID 的调用 |
| 工具取消标记及权限错误正文 | 均未观察到，不补造 permission_denied 帧或错误正文 |
| 执行权限批准 | 0 |
| 输出门槛 | 57 个可见帧，仍未观察到 progress/final 分类或片段身份 |

这里的 observed 只表示“本次明确拒绝接收及原 Run 取消”的往返，不宣称所有权限分支、工具执行审计或完整 Courier/钉钉人工流程已经通过。

## 两个早期样本与原生契约

首个样本确实取得了明确拒绝回执和原 Run 终止，但探测错误地在 onMessage 中寻找 RPC response。
AcpConnection 的 response 由 call Promise 返回，onMessage 只接收服务端请求及通知；首个样本仍保留 unverified。

第二个样本已正确观察原始 cancelled，仍未见带 permission_denied 的工具取消帧。
继续检查安装包 handleResolveInterruption：匹配的非 AskUserQuestion 工具在 deny 分支调用 interruptionService.reject，并返回 resolved=true、queued=false。
这一路径直接终止原 Run；emitCancelledToolCallUpdatesForDenials 属于另一个 interrupt_result 路径，不能要求它必然出现。
第二个样本也保留原来的 unverified，不事后改写。

修正后的探测分别报告拒绝接收、原 Run 取消、工具取消标记和权限错误正文。
最后一个样本重新独立运行，不重放前两个操作；不存在的工具标记继续明确记为 false。
真实服务和 humanInteraction 准入状态均未被改为通过。

## 已修复的待答撤销遗漏

生产适配器原来只将 tool_call_update 的 completed/failed 视为关闭原请求，漏掉了本机协议有效的 cancelled。
现将 cancelled 纳入同一处理：必须属于当前 Harness 会话和已关联工具；显式错误 Run、成员帧及外来工具不能撤销当前请求。
匹配的取消只发一次 input.invalidated，不确认答案，也不提交权限决定。问题和权限请求都覆盖。

回归测试先复现该遗漏，再验证修复。另新增五项拒绝探测测试，覆盖完整命令/来源/范围、权威取消标记、原生拒绝后任务取消、RPC response 的正确观察位置、unknown 不被后来任务终止改写为接受，以及观察回调恢复。
完整离线套件 155 项通过、0 失败；build/typecheck 通过；编译后应用非空/非注释行覆盖 3151/3664（86.00%）。

## 继续调查的接口边界

- 桌面后端正常 requestYield 调用使用 session/request_yield；当前内嵌 CLI 未找到同名方法实现，既有真实调用返回 false。不能仅凭桌面方法存在就声明交接可用。
- SendUserMessage 的原生 status 是 normal/proactive，不能据此映射 progress/final。
- stream-json 提供语义消息 UUID 和 result，但还没有建立本机 WorkBuddy 的正常认证、运行生命周期及对应输出桥接，不替换为单独 CLI 冒充桌面 Harness。
- 本机有 Stop/FinalStop Hook；FinalStop 提供 final_stop_reason，常规命令 Hook 没有已经核实的逐文本分类与片段身份。正常插件 Hook 对原生事件的接入仍是待调查路径，不是已准入能力。

官方来源与本机静态行为分别核对：[权限规则](https://www.codebuddy.cn/docs/cli/permissions)、[设置配置](https://www.codebuddy.cn/docs/cli/settings)、[无头模式](https://www.codebuddy.cn/docs/cli/headless)、[Hook 指南](https://www.codebuddy.cn/docs/cli/hooks-guide)。
