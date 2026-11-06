# WorkBuddy 接口补充调查

日期：2026-11-06。范围为官方公开文档、本机 WorkBuddy 5.6.2 安装包静态检查，以及自有隔离 Harness 会话实验。
本记录修正此前“首次新建回传启动标识后，没有独立 ACP 执行路径”的调查结论；不授予真实服务准入。

## 独立 Harness 会话的新建路径

安装包 `cli/dist/codebuddy-lite-wb.mjs` 中的 `initializeSession` 对首次新建有特殊处理：
当该 ACP 连接尚无 currentSessionId，且 CLI 启动参数包含 sessionId 时，使用启动参数中的标识。
连接已有 currentSessionId 后，再次显式新建不再传入这个启动标识。
`setSession` 会在正常初始化结果中登记 currentSessionId。

此前 `--acp-owned-run` 只检查首次新建，实际返回已知的桌面启动标识，生产适配器按预期阻止覆盖。
这只能证明首次操作未创建不同的目标，不能据此断言后续显式新建也不可用。

本次实验顺序：

1. 正常桌面入口创建私有空目录中的测试 Harness 会话，前置无工具任务明确 end_turn 且空闲。
2. 为本次自有运行进程建立 ACP 连接并 initialize；显式初始化启动 Harness 会话，核对返回标识与本次已知启动标识相同。
3. 同一 ACP 连接再执行一个独立的新建操作，使用不同操作 ID；仅返回不同的新 Harness 会话标识时登记 Courier 测试绑定。
4. 通过生产 WorkBuddyAdapter 启动无工具记忆任务，核对实际内容与原始 prompt 终态。
5. 正常断开本次 ACP 连接，新建连接后只 load 同一新 Harness 会话，提交未重述标记的续聊指令，核对上下文与终态。

初次调查驱动观察到：新标识不同、两次任务均 accepted/completed/end_turn、均匹配合成标记、恢复 accepted；
52 个可见帧，零工具调用，零执行权限批准。初次驱动在临时实验封装中显式插入启动初始化，
其内部旧计数器只计第二次新建；实际执行了两个新建 RPC，不能按旧计数声称只调用了一次。
仓库已增加显式 `--acp-bootstrap-owned-run`，分别统计两个新建 RPC，避免依赖临时封装。

仓库入口再次独立复现：bootstrapInitialization=matched，new=2、load=1、prompt=2；
新 Harness 会话标识不同，两次任务均 accepted/completed/end_turn 并匹配标记，恢复 accepted。
共 61 个可见帧，progress/final 文本分类、片段身份及 promptRequestId 帧均为零；零工具调用、零执行权限批准。
因此新路径没有补齐输出语义门槛。

初始化回复未知、缺失、标识不符时停止，不执行后续新建或任务；第二次新建仍受原生产标识冲突保护。
这不是 unknown 操作重试，也不是原 Harness 会话 load 失败后的新建回退。
只允许用于本次自有且已确认空闲的启动 Harness 会话，不能应用于用户正在使用的 Harness 会话。

该观察建立了本版本上独立 ACP 创建、执行、正常断连和原上下文恢复的候选路径。
它不证明桌面已持有写入权的原 Harness 会话可正常交接、不证明两个私聊并发隔离，也不证明 Courier 跨进程重启恢复。
常驻运行进程的发现、激活和生命周期仍需形成适配器契约。

## ACP 原生问题的握手缺陷

独立创建/恢复后，经生产适配器提交原生单选题任务，修复前的真实样本没有产生 input.requested，任务直接结束，答复调用数为零。
继续追踪本机 AskUserQuestion 的 isEnabled 判断发现：ACP 模式下，必须由所属连接的 clientCapabilities._meta['codebuddy.ai'].question 明确为 true 才启用该工具。
原适配器在 initialize 中发送空 clientCapabilities，因此没有启用已有问题处理代码对应的原生工具。

已补充这项握手声明，并明确 fs.readTextFile/writeTextFile=false，不声明客户端文件读取、写入或执行能力。
新增回归测试先复现空能力表导致的差异，再验证修复后的声明；该修改不批准执行权限，也不将 humanInteraction 的准入状态改为 supported。
真实问题、决定回执、任务续行和完整权限往返仍分别核对，不能仅凭握手通过宣称完整人工能力。

修复后的临时独立样本已经观察到原生问题和一次答案 accepted，并在原 Run 中完成所选标签输出。
随后增加仓库显式 `--acp-bootstrap-owned-question`，从独立创建/恢复前提开始再次复现：

| 显式入口的真实结果 | 观察 |
| --- | --- |
| 前置创建/恢复 | 新标识不同；原上下文恢复通过 |
| RPC 数 | new=2、load=1、prompt=3（记忆、续聊、原生问题） |
| 原生问题 | 原 Harness 会话/Run 的合成题目、单选字段与两选项匹配 |
| 答复 | 仅一次；receipt=accepted，原操作/input 的 input.accepted 已观察 |
| 原 Run 续行 | run.completed、stopReason=end_turn，新的 Agent 正文精确输出所选标签 |
| 权限请求及执行权限批准 | 均为 0；问题答复协议字段不当作执行权限批准 |
| 输出语义 | 83 个可见帧，progress/final 分类及片段身份仍未观察到 |

问题正文/选项的回显不计作续行结果；适配器事件中保留原问题消息 ID，检查时排除该消息。
新增离线保护覆盖权限请求、错误题目、撤销、外来 Run、unknown 不重试及问题正文回显不能冒充续行。
完整离线套件 149 项通过，build/typecheck 通过，编译后应用行覆盖 3149/3664（85.94%）。
仍需完整执行权限往返、待答恢复及 Courier/钉钉链路，humanInteraction 保持 unverified。

## 其他入口的核对

| 入口 | 本次调查结果 | 实现含义 |
| --- | --- | --- |
| 官方 WorkBuddy Open API | 本地助理提供在线、发消息和历史查询；返回 ACP 地址的创建接口属于云端任务 | 不把云端任务当作已登录本机 Harness 的独立会话接口；本地助理文档未建立所需独立 Harness 会话契约 |
| 随包 workbuddy-desktop-sdk | lib/index.js 导出 guest/windows；窗口操作和事件经桌面桥接转发 | 包名不能作为外部 Node 会话管理 SDK 的证明；不直接执行带副作用的内部入口 |
| HTTP runs/jobs | 官方 CodeBuddy CLI 文档提供执行、订阅及作业管理接口；本机内嵌 CLI 也有对应路由定义 | 仍须单独核实桌面宿主的正常认证、Harness 会话和运行任务语义，不假定与独立 CLI 互通 |
| sessions/:id/reply | 本机实现只校验当前活动 Harness 会话并调用 runDefault，没有该请求所需的 expectedRun 原子校验 | 不替换已有 session/steer，也不把“未占 ACP writer”当作及时 steer 保证 |
| sessions/:id/history | 本机实现为摘要：每次用户输入后取首条 assistant 内容，截断至 500 字符 | finalReply 字段名不能作为可靠 final 分类或完整输出契约；不能用于补齐输出门槛 |
| 原生事件到 ACP | convertOpenAIEventContentToAcp 对 response_started/response_done 不产生更新；文本增量和历史消息转换为普通 agent_message_chunk | 需继续寻找可保留消息完成、分类与片段身份的入口；不能用执行阶段、末条文本或摘要字段猜类型 |

## 安装元数据与运行版本的区别

后续静态复核确认，桌面 package.json 声明 5.6.2，cli/package.json 则为 0.0.0；随包 CLI 主文件的 publishConfig.customPackage 声明 2.147.0，其版本输出和 PackageUtils 优先读取该发布元数据。因此不能把 cli/package.json 的占位版本当作实际 CLI 发布版本，也不能只读桌面版本替代 CLI 身份。

当前 ACP initialize 没有报告 agentInfo。另一个 HTTP 控制器的 info 方法优先返回 clientInfoProvider 的 productVersion，再回退 getCliVersion；它还会返回本机环境信息，因此不能把 HTTP version 字段未经来源核对就当作 CLI 版本或直接共享整个响应。health 是进程健康信息，status 则只查询控制器当前活动 Harness 会话；二者均不构成任意原 Harness 会话/Run 的权威查询。

以上为安装代码与元数据事实，没有新调用这些 HTTP 接口，也没有把静态安装元数据当成配置目标运行进程的版本证明。生产适配器仍缺可绑定目标运行身份的版本来源，正常配置的版本门槛没有放宽。

后续再次读取[官方 Open API](https://open.workbuddy.cn/docs/openapi)：本地助理仍列在线、发消息、历史及按原请求答复，所列消息接口没有提供本功能所需的独立本机 Harness 会话选择；返回 ACP 地址的任务接口明确面向云端。另复核[CodeBuddy ACP 文档](https://www.codebuddy.cn/docs/cli/acp)，未据其通用续接和宿主能力说明认定桌面目标已具备所需正常发现/激活或原写入权交接。未发现所需契约不等于证明厂商不存在其他接口；当前门槛继续保留，没有调用真实 Open API 或新增第三方授权。

## 版本范围

本机真实实验仍为 5.6.2；官方更新日志列出 5.11.0 灰度版本，不能推导本机 Linux 可直接升级，或升级即可修复上述接口缺口。
官方 UOS 指南通过应用商店安装及更新，历史下载页主要列出 macOS/Windows 包。
本次没有安装、升级或更换 WorkBuddy，也没有迁移用户配置。

官方来源（于本次调查访问）：

- [WorkBuddy Open API](https://open.workbuddy.cn/docs/openapi)
- [CodeBuddy CLI ACP 集成](https://www.codebuddy.cn/docs/cli/acp)
- [CodeBuddy CLI HTTP API](https://www.codebuddy.cn/docs/cli/http-api)
- [CodeBuddy TypeScript SDK](https://www.codebuddy.cn/docs/cli/sdk-typescript)
- [WorkBuddy 更新日志](https://www.codebuddy.cn/docs/workbuddy/Changelog)
- [WorkBuddy UOS 安装指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-UOS-Guide)
- [WorkBuddy 历史下载](https://www.codebuddy.cn/docs/workbuddy/Download-History)

公开文档与安装包静态行为、独立真实观察分别记录；均不等同完整钉钉集成验收。
