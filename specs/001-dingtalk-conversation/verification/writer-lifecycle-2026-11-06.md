# 正常后端释放与 Harness 写入权交接的边界

日期：2026-11-06。范围为当前安装的桌面 WorkBuddy 5.6.2 静态实现、已登录自有隔离 Harness 会话及生产 ACP 连接/适配器。CLI 运行版本仍未由握手确认；不新增准入证据。

## 静态路径与旧结果的分类修正

CLI 的写入权检查会检查其他连接是否仍持有该原 Harness 会话的活动通知流，并可能返回 writer_occupied。桌面空闲不代表其连接已释放写入权。

桌面 main/server.js 的 requestYield 最终调用 session/request_yield；main/handlers.js 的对应处理器会把异常折叠为 false。因此此前正常桌面调用返回 false 的原始事实保留，但旧探测输出中的 rejected 不能作为明确拒绝的依据。现改为 not_confirmed，只有明确 true 才继续加载原 Harness 会话；未确认或未知均不重放。
静态检查在所查随包 CLI 主文件中没有找到同名方法实现；这不证明厂商不存在其他入口，也不能仅凭桌面方法存在或 false 结果认定本版本已建立正常交接契约。

正常 destroySession 默认保留历史，调用 disposeActiveSession，再调用后端 destroy。后者释放本地后端登记、断开客户端，并调用 killRuntimeSession 请求运行管理器终止该后端运行进程。内部 releaseRuntimeOwnership 的命名不构成跨客户端 ACP 写入权转移保证。

## 显式独立实验

新增 --acp-release-handoff，与 --acp-handoff 互斥，默认测试不执行真实入口。正常登录及本次合成无工具任务明确结束后，只从自有运行进程、原 Harness 会话参数及 socket 归属识别 ACP；不读取环境、内存或凭据。

只有首次原 load 明确返回 writer_occupied/definitelyNotAccepted 时，才允许后续释放观察。释放前重新核对全局本次探测标识、原 Harness 会话、准确工作目录、明确空闲，以及权限、问题和 elicitation 三类待处理数组均为空。外来、忙碌、待答、字段不全或未知状态不释放。
只调用一次正常 session:destroy；不调用 delete、权限批准、强制接管或其他客户端的终止接口。方法完成只记 acknowledged，再分别观察现有 ACP 连接和自有运行进程计数；只有同一原连接仍存活时才允许一次原 Harness 会话 load。连接关闭或任何结果未知即停止，不重连、不换建目标、不提交额外 Agent 输入。

真实样本结果：

| 检查 | 观察 |
| --- | --- |
| 账户与桌面版本 | 正常账户 API 已就绪且已登录；5.6.2 |
| 自有前置任务 | 无工具，原 prompt 明确 end_turn，桌面 isProcessing=false |
| 原始 ACP | 自有回环目标，HTTP 200、SSE 与 initialize 通过 |
| 首次原 load | rejected / writer_occupied，明确未接收 |
| 正常桌面释放 | acknowledged；仅在原标识、目录、空闲及无待答校验后调用 |
| 释放后的原 ACP | connected=false |
| 自有运行进程扫描 | 计数为零 |
| Courier 后续副作用 | 没有第二次 load、重连、新建替代 Harness 会话或额外 Agent 任务 |
| 权限批准与钉钉发送 | 均为零 |

报告的 originalSessionLoad 保留最近一次实际 load 的结果；在连接关闭分支中，它仍指首次拒绝，不能误读为关闭后又加载过一次。该样本仅证明本次正常释放路径结束了可用原目标，没有实现所需的连接保留与写入权交接。未用 SDK 后续新激活、历史存在或对象重建替代这个门槛。

## 离线验证与支持状态

旧 yield 分类回归先复现 false 被记为 rejected，再改为 not_confirmed。新增三项回归分别覆盖正常自有空闲释放一次、外来/忙碌/待答/未知状态不释放且异常不重试，以及初始接受/未知/无关拒绝时连检查都不执行；CLI 回归另覆盖显式启用和互斥/私有配置门槛。

build/typecheck 与完整 210 项离线测试通过，0 失败/跳过；应用行覆盖 3489/4024（86.70%）。实验资源结束后按自有范围清理，未新增提交/推送或服务启用。T031/T033/T047 等仍未完成，writerOwnership 仍 unverified；这项释放探测没有接入正常 Courier 自动恢复流程。
