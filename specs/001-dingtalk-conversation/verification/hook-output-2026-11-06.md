# Hook 输出与原生转录接口调查

日期：2026-11-06。目标仍为本机 WorkBuddy 5.6.2；未安装、升级或替换内嵌运行时。
本文分别记录官方文档、安装包静态检查、自有隔离会话的真实观察和离线回归，不授予输出或真实服务准入。

## Mods 与普通 Hook 的边界

官方当前 [Mods 文档](https://www.codebuddy.cn/docs/cli/mods)描述 hooks/register.ts、类型化中间件和 turn.complete 等事件。
本机内嵌 CLI 未找到这些加载入口、事件名称或随包类型资产；不能把当前网页文档直接当作本机接口已可用的证明。
没有改为独立 CodeBuddy CLI，也没有向现有 WorkBuddy 注入新的运行时。

普通命令 Hook 在本机实现中会补充 generation_id，来源是所属 Harness 会话的 conversationRequestId。
[官方 Hook 文档](https://www.codebuddy.cn/docs/cli/hooks)也说明这个字段在可用时关联同一轮输入与 Stop，不能用消息 ID 或 traceId 替代。
本机 Stop 输入另有 last_assistant_message，FinalStop 有 final_stop_reason；这些额外字段仍按本机版本行为观察。
命令 Hook 没有传出原生 session 对象，不能借此取得进程内对象或凭据。

## 显式只观察入口

新增 `--acp-bootstrap-owned-hooks`，使用与已有独立 ACP 创建/恢复探测相同的任务前提。
只在本次新建、私有且仓库外的目录中放置观察脚本和项目本地 Hook 配置，不读取或改写用户设置。
遇到已有配置、脚本、输出文件或非私有目录即停止，避免覆盖；Hook 配置的环境白名单仅声明 PATH，观察脚本不读取环境或转录内容。

观察 UserPromptSubmit、Stop、FinalStop、Notification，脚本无 stdout，也不返回权限决定、继续执行或阻止停止的指令。
只保存白名单字段的摘要：原生会话/Run 标识、正文和合成标记都先散列；路径只记录是否提供，不保存路径值。
私有输出权限为 0600，输入、记录大小和记录数均有限制；观察记录不完整、含未知字段、来源不匹配或有多个 Stop 候选时不能记为观察成功。

仓库显式入口的独立结果：

| 检查 | 首轮记忆任务 | 正常断连/load 后的续聊 |
| --- | --- | --- |
| 任务内容、终态 | 标记匹配，end_turn | 未在输入重述标记，仍匹配，end_turn |
| 原生会话和 generation_id | 与本次 Harness 会话和原 Run 精确匹配 | 与同一 Harness 会话和新的原 Run 精确匹配 |
| 匹配 Hook | UserPromptSubmit、Stop、FinalStop 各一次 | 同左 |
| Stop 完整正文 | 摘要与预期合成回答精确相同 | 同左 |
| FinalStop 原因 | completed | completed |
| Hook 身份字段 | session_id、generation_id | 同左 |
| 逻辑消息/片段身份字段 | 均未观察到 | 均未观察到 |
| 原生 session 对象 | 未提供 | 未提供 |

session RPC 数为 new=2、load=1、prompt=2；57 个 ACP 可见帧仍没有 progress/final 分类或片段身份。
工具调用和执行权限批准均为 0，没有钉钉消息发送。
此前临时观察驱动也取得相同的两组 Hook 关联；正式入口用于排除对临时封装的依赖。

## 只读转录元数据的独立实验

另一次私有实验只读取已由本次创建回执确认归属的 Harness 会话转录。
Hook 中的 session_id 必须匹配本次显式写入的所有权记录；只接受同名普通 JSONL、当前用户所有且有界的文件。
没有遍历其他会话、读取登录材料或尝试解密。只保存消息身份、所属 generation、状态、字段存在性及正文摘要，不保存正文、文件路径或个人配置。
这项临时实验不是默认 Hook 入口的行为；`--acp-bootstrap-owned-hooks` 仍不读取转录内容。

| 实际观察 | Stop 时 | FinalStop 时 |
| --- | --- | --- |
| 首轮回答的完整转录 | 已有本轮 assistant 记录 | 已有本轮 assistant 记录 |
| 恢复后续聊的转录 | 只有旧回答，尚无本轮完整 assistant 记录 | 已有本轮完整 assistant 记录 |
| 相同正文的旧、新回答 | 旧记录的 generation 不属于本轮 | 两条记录均有 id 字段，以本轮 generation 可区分 |
| 原生 assistant 字段 | id、completed 状态、providerData.messageId/conversationRequestId | 同左 |
| 被检查的 progress/final/phase/finishReason 等语义字段 | 未观察到 | 未观察到 |

这说明不能仅凭 Stop 已到、正文相同或文件中有旧回答就判定当前输出完整。
本次摘要验证了消息 ID 存在和所属 generation，没有保存或比较跨 Run 的 ID 值，不能扩大为全局唯一性验证。
FinalStop 是值得进一步核对的观察点；本次样本不保证所有写入时序、重连、重复事件、同 Run 重复正文及跨进程恢复均已支持。
不能从这组字段缺失推出 WorkBuddy 所有接口永远不支持分类，也不能把未被明确分类的其他 assistant 内容直接改名为 progress。

## 尚未形成的支持契约

- Hook 的原 Run 关联与完整回答正文已经有局部实测，但命令 Hook 缺少逐消息/片段身份。
- 转录在 FinalStop 时出现了完整消息与身份，但它没有本次所需的进度/最终语义；Stop 时的持久化还可能落后。
- 没有用 generation_id 冒充消息 ID，没有用 Hook 到达顺序制造重投身份，也没有选择“最后一条”当作最终消息。
- session/prompt response 仍是当前任务完成的权威信号；Hook 观察不替代它。
- 本机 `/internal/hooks/services/invoke` 实际代理到产品网关服务，不是取得本地原生会话对象的接口，本次没有调用它。

因此 typedVisibleOutput/messageAssembly 仍未准入，真实服务保持关闭。
后续应核对有原生身份和完整边界的输出来源能否提供所需分类，再实现桥接，不能仅凭本次快照就开放真实投递。

新增三项离线回归覆盖白名单摘要、正文/路径/对象不落盘、带空格/引号的脚本路径、私有权限、不覆盖配置、错误来源、重复 Stop、不完整记录及未知字段拒绝。
完整离线套件 158 项通过、0 失败；build/typecheck 通过；编译后应用非空/非注释行覆盖 3151/3664（86.00%）。
