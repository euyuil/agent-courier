# 验证指南：钉钉机器人持续对话

**当前状态**：通用核心、SQLite 迁移、CLI 和 mock/fake 测试已实现。真实 Harness/钉钉适配尚未准入。
实际离线验证见 [offline.md](verification/offline.md)，真实缺口见 [能力矩阵](verification/capability-matrix.md)。
以下材料检查仅是辅助检查，不替代应用行为或真实端到端验收。

## 设计材料辅助检查

在仓库根目录运行现有 Spec Kit 脚本；下面捕获原始路径，仅输出不含本机信息的摘要：

```bash
python3 - <<'PY'
import json
import os
import subprocess
from pathlib import Path

env = os.environ.copy()
env['SPECIFY_FEATURE_DIRECTORY'] = 'specs/001-dingtalk-conversation'
env['SPECIFY_FEATURE_NO_PERSIST'] = '1'
result = subprocess.run(
    ['python3', '.specify/scripts/python/check_prerequisites.py', '--json', '--require-spec'],
    env=env, capture_output=True, text=True,
)
if result.returncode:
    raise SystemExit('设计材料检查失败；请在本地查看缺失文件，分享前先脱敏。')
data = json.loads(result.stdout)
required = {'research.md', 'data-model.md', 'contracts/', 'quickstart.md'}
assert required <= set(data['AVAILABLE_DOCS'])
feature = Path('specs/001-dingtalk-conversation')
for name in ['harness-adapter.md', 'dingtalk.md', 'configuration.md']:
    assert (feature / 'contracts' / name).is_file()
print('设计材料齐全；这不代表应用测试通过。')
PY
```

预期成功输出只有材料齐全说明。此检查不访问平台或 Harness，也不验证接口实现。
详细边界见 [数据模型](data-model.md)、[Harness 契约](contracts/harness-adapter.md)、
[钉钉契约](contracts/dingtalk.md)、[配置契约](contracts/configuration.md)。

## 实现后的准备条件

1. 按 [plan.md](plan.md) 创建应用并锁定依赖；确认 Node 24 支持基线、实际 SQLite ≥3.51.3，
   本地磁盘、FULL/WAL 和外键设置。使用实现交付的实际安装、构建和测试命令，不把文档检查当应用检查。
2. 测试配置、数据库和证据位于 Git 外；使用虚构用户 A/B、机器人 B1、私聊 C1/C2 和合成测试标记。
   不读取个人文件、真实账号日志或环境中的其他产品凭据。
3. 测试 Harness 提供可观察的运行屏障、同轮输入应用记录、可计数的 start/steer/answer、
   问题/授权、明确完成事件、拒绝/未知结果、写入冲突以及可靠片段编号。
   另有不支持 steer、仅接收后排队、不能及时消费的负面适配器。
4. 测试平台提供入站重投、相同正文的新消息、发送成功/明确失败/未知、虚拟限额和过期路径；
   每条投递记录次数、接收目标和顺序。测试平台不发真实消息。
5. 真实验证另需正常官方登录的独立 Harness 测试会话、合法机器人身份与两名测试用户。
   真实平台/Harness 操作必须在对应测试任务的授权范围内；规划阶段未调用这些系统；后续独立实验的实际边界见 verification。

编译后 CLI 的以下方式可运行 fake 演示；真实模式仍受准入限制。
`COURIER_CONFIG` 指向操作者在本地建立的私有配置，示例不展开为真实路径：

```bash
node dist/main.js validate-config --config "$COURIER_CONFIG"
node dist/main.js serve --config "$COURIER_CONFIG"
```

真实模式启动不等于准入通过；能力不足应拒绝目标并报告具体原因。测试模式必须显式配置为 fake，
模拟结果只证明通用路由和状态处理。配置与状态查询退出码含义见配置契约。

## 模拟验证场景

基础准入验证（T015/T016）使用虚拟时钟和合成上下文：覆盖没有明确期限时不按年龄过期、
now 恰等于 expiresAt 时拒绝、未来 checkedAt 或不合法期限拒绝、撤销后拒绝、
适配器/产品/CLI 版本及目标/传输/授权/限额变化后拒绝；无关展示配置或同身份凭据轮换不误失效。
在准入后推进时钟、重连或重载配置，下一次相关副作用前仍须拦截失效证据；
新验证只恢复其覆盖范围，重启或修改旧时间戳不能恢复支持，fake 证据不能用于真实目标。

每个场景重置独立测试数据库或明确沿用同一测试状态；只有恢复场景在中途重启。
断言使用接收人、三层会话映射、操作和片段标识及计数，不依赖“文本看起来像成功”。

| 场景 | 操作步骤 | 通过标准与对应规格 |
| --- | --- | --- |
| Q-01 三轮与正常重启 | C1 输入合成标记，之后两轮不重述标记；分别连续运行、首轮终态后重启 | 同一 Harness 实例及 Harness 会话，三轮各一次；追问正确，重启不重放；US1-1/2、SC-001 |
| Q-02 隔离和群消息 | C1/C2 交错两轮；发送普通群消息、群内 @机器人、带有效请求号的群答复 | 私聊零误投/串上下文；群消息引起的 Courier 会话或 Harness 会话创建、任务执行、机器人答复均为零；US1-3/5、US3-4、SC-002 |
| Q-03 无效输入/目标 | 私聊空文本、附件、未配置 Harness、失效绑定 | 安全限制提示，未执行、不猜目标；US1-4/5 |
| Q-04 运行中两次 steer | 原任务停在可观察执行屏障，连续两条新消息；允许 Harness 在完成前消费并据此改变后续输出；再测相同正文不同 ID | 原 Run 内两次实际生效；只收到 ACK 不算通过；零排队回退、取消重启或忙时提示；US1-6、SC-009 |
| Q-05 steer 不符/竞态 | 不支持、仅排队、延后消费、明确拒绝、预期任务已结束、接收结果丢失 | 不合能力不能被准入；拒绝留明确失败，未知不重投，均不改为下一轮；US1-7/8 |
| Q-06 可靠重投与新发送 | 同 originalMessageId 投递 10 次；对 start/steer/answer 都测试；再用新 ID 发相同正文 | 原输入只提交一次；新 ID 为独立输入；缺可靠 ID 时不执行且不按正文去重；US2-1/2、SC-004 |
| Q-07 选中消息的临时失败 | 输出两条进度和 final；第二条首次明确失败后成功 | 三条最终按顺序出现，第一条不重发；Harness start 仍一次；US2-3 |
| Q-08 重试耗尽与未知 | 第二条连续明确失败三次；另测发送已接收但响应丢失 | 前者停止、后续继续且缺失可查；后者 unknown、不补发、原私聊出站暂停，其他私聊继续；US2-4/5、SC-005 |
| Q-09 写入、登录和续接异常 | writer_occupied、Harness 会话消失、续接不支持、登录失效 | 保留原绑定和执行事实，不抢占/替换；提示安全下一步；US2-7/8/10、SC-007 |
| Q-10 路径、长度和输出缺失 | webhook 过期，分别有/无经验证同私聊路径；超长文本；运行完成但应交付正文缺失 | 原目标不变；无法发送可查，不截断；主动隐藏不误报缺失；US2-9/10/12 |
| Q-11 问答与权限 | 原任务依次提问、请求批准、请求拒绝，使用明确编号作答；另测多字段问题的合法 JSON、缺字段及非法选项 | 回原任务原请求各一次；字段按保存的原模式校验，不补造答案；确认前不标完成或已授权；US3-1/2、SC-006 |
| Q-12 关联异常 | 多请求、含糊“同意”、其他私聊携带请求号、已处理/撤销/过期编号重复回复 | 澄清或拒绝，不泄漏请求正文、不自动批准、不新建答复任务；US3-3/4/5 |
| Q-13 待答时的新输入 | 保持问题未答；发普通补充并 steer；再答原问题；另测 steer 撤销原问题 | 不代答、不将补充当授权；有效答复优先且仍关联原请求，已撤销按失效处理；US3-7 |
| Q-14 交互配置和未知确认 | 关闭 question 或 permissionRequest；运行中人工接收能力丢失；answer 响应丢失 | 拒绝配置/明确阻塞；保留原决定与 unknown，不再提交；US3-6/8 |
| Q-15 四种展示组合 | progress/final 开开、关开、开关、关关；各输出两条进度和一条 final | 普通 Harness 消息数 3/1/2/0；执行终态一致，问题/错误仍默认展示；US4-1/2/3/7、SC-003 |
| Q-16 片段与边界 | 相同正文不同片段、同片段重投、乱序、索引缺口、同键不同序号或同序号不同键；final 正文早于任务完成 | 只有 0..N 齐全才组装；冲突不按正文解决；正常重复文字保留、不逐片段发；final 不提前终结 Run；US4-4、US2-10 |
| Q-17 合并和快照 | 开/关相邻进度合并；运行中改策略并 steer，再开新一轮 | 仅未投递相邻 progress 合并；问题/权限/错误不并入；本轮旧快照、下轮新策略；US4-5/6 |
| Q-18 未知类型和敏感错误 | 注入未声明内部类型、无法分类输出和含合成敏感值的错误 | 不猜分类、不泄漏内部内容；安全说明能力限制；路径/凭据/他人内容不出现在共享输出；US4-8、US2-13 |
| Q-19 崩溃恢复 | 在下表每个窗口终止 Courier 后启动；另测数据库不可读 | 无副作用重放；保留 original binding，异常不删库重建；US2-6/11、US3-8、SC-005/007 |
| Q-20 未知投递核实 | 暂停原私聊；分别提供已投递、未投递、无证据三种查询结果；在剩余预算和耗尽预算时各测试 | 已投递不重发并继续后续消息；未投递按原预算重试/失败；无证据继续暂停；服务运行时 reconcile 拒绝第二写入；US2-5、SC-005 |
| Q-21 晚到确认 | 先发 completed/failed 或请求撤销事件，再返回 start/answer 的 accepted；另测重复与矛盾事件 | 接收事实补齐，但不回退任务终态或重开请求；矛盾证据不静默覆盖；US2-10、US3-5/8 |

### 崩溃注入窗口

| 窗口 | 预期恢复行为 |
| --- | --- |
| 原始输入已持久化，未登记网络派发 | 旧普通输入明确标未提交/恢复中断；不建立恢复队列 |
| create/start/steer/answer 已登记 dispatching，尚未能取得确认 | unknown，核实原操作；不新建替代 Harness 会话或重复提交决定 |
| 对方已接收，本地确认事务尚未提交 | unknown；不能因缺少 accepted 行认定未执行 |
| accepted 已落盘，后续断连 | 接收事实保留；执行状态按已知证据恢复，无法确认时 unknown |
| input.requested 与 sourceMessageId/编号已落盘，正文尚未完成 | 重启后复用原请求、编号和已保存片段；可靠补齐正文后只创建一条请求正文投递；重投不双发；不能补齐则保留请求并报告阻塞，不自动回答 |
| 输出/outbox 原子提交前后 | 仅已提交的完整输出可投递；可靠重播不能生成重复 outbox |
| 平台接收发送后，本地仍为 sending | unknown；不把发送次数重置或自动切换路径补发 |
| 投递成功已落盘 | 不重发；下一条按顺序继续 |

## 真实能力准入：先证据，再支持声明

每次记录日期、产品/SDK/适配器版本、测试场景、前提、实际结果与失败边界。
真实账号、平台会话及 Harness 会话 ID、端点、正文和原始日志留在私有测试材料；仓库只保留脱敏结论和覆盖范围。
以下是待执行步骤，本次没有执行。

### V-03：WorkBuddy 核心能力

1. 在正常官方登录的独立 Harness 测试会话中验证首轮、两次追问和 Courier 正常重启后续接。
   不要求固定安装 5.6.2；记录实际版本并重新核实接口。不得将独立 CLI 登录当桌面登录。
2. 让真实任务持续多个可观察阶段。分别在模型工作、长工具步骤、等待问题/权限以及临近完成时，
   连续发两条新输入；另发同正文不同消息 ID。记录接收时间、原任务 ID、实际消费依据、
   后续行为变化及完成时间；只有原任务完成前生效才通过。
3. 特别验证内部 session/steer 的接收与消费不是同一事件；idle/stale、斜杠文本拒绝及断连结果未知
   必须保留失败边界。不得自动排队、取消后重启或另建任务。
4. 桌面持有 Harness 会话写入权时验证 writer_occupied；通过正常人工交接恢复写入权后仍使用原 Harness 会话。
   发现/激活路径无法形成可接受契约时，该实验适配器不能进入受支持状态。

### V-04：人工输入

在原任务完成一次问题答复、一次明确批准、一次拒绝；用无副作用的测试操作。
覆盖多请求歧义、未答复、其他私聊请求号、重复决定、steer 撤销问题和接收未知。
记录请求 ID、原任务关联及后续状态的脱敏证据；不能仅以 resolved 响应认定整条链路完成。

### V-01、V-02：钉钉发送范围

1. 取得当前应用类型对应的官方条数、频率、长度及其计量单位依据，建立限额配置。
   无法取得时保持限制未验证；不靠大量发送探索平台上限。
2. 一条私聊输入产生两条独立进度和一条完整 final；关闭合并，记录三条在原私聊的顺序。
   再验证三种过滤组合、合法限流响应与超长失败；不把一次成功推导成无限发送。
3. 让原 webhook 自然过期，验证候选 OTO 是否仍进入同一机器人原私聊。
   核实企业用户 ID、权限与接收范围；未授权、映射缺失时不能切到其他发送渠道。
4. 对失效路径保留失败记录；若没有原私聊可达路径，报告“用户是否知情未确认”。

### V-05：身份与结果核实

验证目标 SDK/服务下真实重投行为，比较 `msgId` 与推送 `headers.messageId`，确定命名空间。
重投 start/steer/answer 各检查一次；同正文新发送不得被去重。
验证消息 ID、片段 ID/序号、历史回放与实时流交叠，缺片段时不能删正常重复正文。
核实发送和 Harness 操作可查询到的事实；没有权威依据时 unknown 是正确保守结果，不能伪造恰好一次。

## 验收记录

每次结果应含：`scenarioId, environmentKind, versions, capabilityEvidence, expected, observed, outcome`。
`environmentKind` 区分模拟、安装包静态检查、真实 Harness、本地集成、真实钉钉集成；
`outcome` 区分 passed/failed/not_tested/blocked，不能用“未运行但预计成功”填 passed。

真实 SC-001 至 SC-009 及全部必需能力通过前，保持“设计完成/核心模拟通过/真实适配未验收”等准确状态。
已完成的离线行为与剩余真实门槛分别记录在 verification；真实钉钉端到端验收和部署仍未完成；提交/推送按各轮授权单独记录，本轮适配器增量尚未提交或推送。

## 实际离线命令与钉钉入站探测

运行 Node 24.22.0，使用 `npm ci`、`npm run build`、`npm run typecheck`、`npm test`、`npm run test:coverage`。
测试产物位于 build/test，应用产物位于 dist，源目录不接收编译产物。
覆盖率从 V8 原始记录计算编译后应用的非空、非注释行，并包含未执行文件，不代表所有真实场景均通过。

钉钉独立探测仅用于取得真实入站事实；默认不执行，显式启用后监听 60 秒并 ACK，不发送聊天消息。
把 `{ "clientId": "<CLIENT_ID>", "clientSecret": "<CLIENT_SECRET>" }` 存为仓库外 0600 私有文件，
让 `DINGTALK_PROBE_CREDENTIALS` 指向它；`DINGTALK_PROBE_OUTPUT` 指向仓库外 0700 私有目录中的新文件。

```bash
npm run probe:dingtalk -- --enable-live --credentials "$DINGTALK_PROBE_CREDENTIALS" --output "$DINGTALK_PROBE_OUTPUT"
```

工具就绪后只输出合成标记，让唯一测试用户把它发到机器人私聊。真实身份留在私有输出，控制台只输出计数。
退出 0 只表示观察到了匹配入站；可靠重投作用域、限额、三条输出、到期与备用路径仍为 unverified，不能据此启用真实服务。
该入口使用正常 Stream 凭据，不读取 WorkBuddy 登录材料。

一个真实用户可覆盖单私聊正常/异常路径；两个真实用户间的隔离仍缺证。
当前两个私聊隔离仅在 mock/fake 中验证，不能用两个合成平台会话替代真实多用户验收。

### 由操作者提供环境变量

操作者也可明确选择 Git 已忽略且未跟踪的 `.env`。通过 Node 的 `--env-file` 直接加载到独立探测子进程，
无需在聊天或日志中展开凭据，也不执行 shell `source`。`.env` 权限应为 0600；状态与探测输出仍须在 Git 外。
这只启用独立探测的凭据输入，不使真实 serve 获得准入，也不让默认离线测试自动读取 `.env`。

```bash
npm run build:test
node --env-file=.env build/test/tests/probes/dingtalk-capabilities.js --enable-live --credentials-env --output "$DINGTALK_PROBE_OUTPUT"
```

环境变量名固定为 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`。不得打印其值、环境列表或 SDK 原始连接错误。

## 未准入适配器与集中验证准备

操作者要求先编写实现、再集中参与人工验收；真实门槛仍约束启用及支持声明。当前输出分类、稳定片段边界及完整人工往返缺少真实依据，真实服务会拒绝启动。详见 [实现边界](verification/adapter-implementation.md)。

真实配置的凭据引用可以显式写为 `env:DINGTALK_CLIENT_ID` 和 `env:DINGTALK_CLIENT_SECRET`；只有真实适配器需要连接时才取值。
平台限额/证据配置和 Harness 连接/证据配置均为仓库外 0600 文件，所在目录为 0700；严格字段定义见 `src/config/real-profiles.ts`。
空证据或 unverified 不授予准入，禁止为跑通流程伪填 passed。

WorkBuddy 独立探测的私有启动配置为 `{"executable":"<WORKBUDDY_EXECUTABLE>","args":[],"virtualDisplay":true}`。
可执行文件由目标机器上的正常安装确定，不固定路径、端口或设备；已有桌面占用导致不能启动该独立诊断时应停止，不关闭用户原有客户端。

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --exercise
```

`--exercise` 会创建一个独立 Harness 会话及空目录，提交一次合成无工具指令；去掉它则只探测正常账户与桌面版本。
`--question` 包含前置文本任务，再用正常桌面 API 回答一个合成单选问题；不会批准可执行工具，发现其他权限请求即报告限制。
`--question-interruption` 使用同一生产问题解析与答复字段转换，经正常桌面 `session:resolveInterruption` 提交原问题答案；不能据此声明原始 ACP receipt 已验证。它与 `--question` 都会核对原工具/Run 归属，结果不明时不换通道重试；观察到其他工具活动时停止答复。
`--resume` 包含前置记忆任务；仅在其正常结束后释放自身原 Harness 会话运行后端并加载同一标识，再核对上下文，不能替代 Courier 重启验收。
`--acp-surface` 只从自身原 Harness 会话的完整初始化日志记录中寻找回环 ACP 地址；
`--acp-process-surface` 改为核对 Linux 自有测试运行进程、显式原会话参数及监听 socket 归属，不读取进程环境或内存。
两种入口都先建立并关闭自己的协议订阅，再由生产适配器 initialize/load 原 Harness 会话，不提交额外 Agent 任务。
`--acp-handoff` 仅在 load 明确返回 writer_occupied 时，向本次空闲原 Harness 会话提交一次正常 requestYield；
只有明确确认才重新加载同一原会话一次，结果未知时不重放。当前真实调用返回 false；桌面桥接层可将异常折叠为 false，因此现记录 not_confirmed，不把它当成明确拒绝。写入权交接仍未通过。

单独观察正常后端释放是否保留原 ACP 连接：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-release-handoff
```

该选项与 --acp-handoff 互斥，属于独立 ACP 表面观察。只在本次自有合成任务明确结束、原 load 明确 writer_occupied 且未接收后，再核对原 Harness 会话、工作目录、isProcessing=false 及权限/问题/elicitation 三类待处理数组均为空，才调用一次正常 session:destroy。其安装实现默认保留历史，但会释放后端并请求终止运行进程；该选项只操作探测自己的空闲后端。
方法完成仅记录 acknowledged，随后分别观察原 ACP 连接和自有运行进程计数。只有原连接仍存活时才加载同一原 Harness 会话一次；连接关闭或结果未知时停止，不重连、不新建替代目标，也不提交额外 Agent 输入。真实样本已观察方法完成、原连接关闭、自有运行进程计数为零，没有第二次 load；这条路径未实现所需写入权交接。完整范围见 verification/writer-lifecycle-2026-11-06.md。

`--acp-owned-run` 是另行显式新建实验，不能与其他任务选项同时使用，也不是 load 失败后的回退。
只有新建明确接受、返回标识不同于桌面启动用 Harness 会话，才可提交合成任务；首轮内容及终态均确认后，才正常断连并尝试一次恢复同一新 Harness 会话，最后核对上下文。
当前实际仅调用一次 session/new，回传了启动用 Harness 会话标识，被本地保护判为 unknown/protocol_conflict；零 load/prompt，后续任务与恢复均未执行。不能据此声明独立会话、写入权或输出协议已受支持。
`--acp-bootstrap-owned-run` 单独运行，先显式初始化本次已确认空闲的自有启动 Harness 会话；只有回复标识匹配，才在同一 ACP 连接执行另一个新建操作。
第二个新建仍须取得不同标识并通过原生产冲突保护，之后才执行上述任务及原上下文恢复检查。初始化未知/不匹配即停止，不重试或提交任务。
2026-11-06 已独立复现两个新建 RPC、一次 load、两次 prompt 及原上下文保留；这不证明桌面原写入权交接或完整 Courier 重启。详见 verification/interface-research-2026-11-06.md。
`--acp-bootstrap-owned-question` 单独运行，包含上述创建/恢复前提，之后通过生产 ACP 适配器发起一个合成原生单选题。
仅原 Harness 会话/Run、完整题目/选项和有效待答请求一致时提交一次答案，核对明确 receipt、input.accepted、原 Run end_turn 及真实续行输出；不答执行权限、撤销问题、外来 Run 或不匹配题目，未知答案不重试。
握手仅声明 question=true 并明确拒绝客户端文件能力，不表示批准执行权限；该入口不代替完整 Courier/钉钉人工往返验收。
`--acp-bootstrap-owned-denial` 单独运行，包含相同的独立创建/恢复前提；只在本次私有目录配置 Bash ask 规则，并核对原 Harness 会话的 mode=default。
随后请求一次合成打印命令；原工具/Run、完整命令、原生 interruption 及可见拒绝范围一致才提交一次 deny，核对明确接收、原输入确认及原 Run 取消。
该原生拒绝分支可能没有工具取消标记，探测分别报告标记是否出现，不凭文本或流关闭补造；unknown 不重试，不批准或替换为其他任务。结果见 verification/permission-denial-2026-11-06.md。
`--acp-bootstrap-owned-hooks` 单独运行，在本次自有私有目录中配置只观察的普通 Hook，包含独立创建/恢复前提；该入口不读取转录内容或环境，不修改用户设置，也不输出权限决定。
它只保存原生身份、正文等白名单字段的摘要；匹配本次 Harness 会话/Run、单个 Stop 和 completed 的 FinalStop 才报告这组观察成立。未知字段、不完整记录和重复 Stop 不据此通过；逻辑消息/片段及进度分类仍未准入，见 verification/hook-output-2026-11-06.md。
采集在文件锁内检查 1 MiB 总量、4096 条记录、完整末行及私有权限，超过边界不追加。Stop/FinalStop 只证明相应 Hook 已触发，实测均可能早于本轮完整转录写入，不能作为转录刷新屏障。
`--permission-denial` 单独运行：仅将本次新建的 Harness 会话配置为 default 权限模式，
请求一个只打印合成标记的 Python 命令，并只对原工具/Run 和完整命令一致的请求提交一次拒绝。
它不会批准可执行工具或调整全局权限配置，不能与恢复、问题或 ACP 交接实验混用；实际结果见 verification。
`--steer-running` 单独运行：正常桌面入口在独立目录中启动无工具任务，并传入与生产适配器相同的预分配 conversationRequestId。
只有实际模型或工具事件携带该标识、原 Harness 会话仍在运行时，独立 ACP 控制连接才提交一次原子 steer。
该连接不 new/load/prompt；桌面继续持有写入权。探测分别记录接收、注入、运行状态、原始 ACP/桌面输出归属和显式终态，
只有用户回显不作为执行中的依据；结果未知或明确拒绝均不重试或换为下一轮输入。
`--steer-running-twice` 单独运行同类任务，第一条要求先输出合成标记，再继续生成无工具的合成说明；只有已验证的新厂商 owner 输出该标记且原提交仍未结束、没有待处理人工请求时，才发送第二条补充。
第二条使用当前厂商 owner 校验，保留原 Run 关联；没有见到第一条实际改变内容就不发送，第二次结果不明也不重试或换为新任务。它不能与 `--steer-running` 同时指定。
`--steer-same-text` 单独验证两条正文完全相同、输入/操作 ID 不同的补充。第二次仍须先确认第一条实际改变输出；分别核对两个消费回执，并确认第二次消费后的新厂商逻辑消息再次包含同一合成标记。
旧消息的后续片段、输入回显、思考、历史重放和跨消息拼接不能充当第二份结果；它不能与其他任务选项同时指定。当前该独立路径已观察通过，不代表真实钉钉 msgId 作用域或服务端幂等已验证。
`--steer-slash` 单独检查运行中斜杠文本的拒绝边界。只在预分配原 Run 已实际执行、正常提交未返回且无人工请求时，通过生产 steer 提交一次随机合成斜杠文本。
它使用未知的合成命令名，不调用已有产品命令；拒绝或未知都不改走普通 prompt、队列或下一轮任务，也不重试。
记录明确输入拒绝、原任务正常终态、原标记输出和无补充标记/消费；idle/stale 拒绝不能当作此场景通过，历史重置、外来事件或轨迹截断也不能通过。该选项与其他任务选项互斥。
`--steer-near-completion` 单独验证受控输出后期的两条补充。无工具任务预设输出 20 行，只有原 Run 同一条可见消息的前 17 行编号匹配且第 18 行出现本次标记、原提交仍在执行且尚未观察到原始终态时才派发。
第一条明确接收后，重新核对原任务未结束及无人工请求，再立即提交第二条；两条仅修改报告收尾，第二条不重复第一标记且保留此前要求，不靠添加新的长任务延长窗口。
分别核对原输入/操作消费回执、注入时正常原提交仍未返回、原始终态前消费及各自已关联标记输出；原任务已结束、关联/完整性丢失或拒绝/未知均不回退或重试。
这个文本标记只触发受控测试，不是生产输出类型或任务完成判断。该探测轨迹显式限为 5000 行，未显式指定容量的探测仍限 2000 行，通用上限不超过 10000 行；发生截断仍不能通过。该选项与其他任务选项互斥。
`--steer-failure-boundaries` 单独验证两个故障边界。原 Run 已实际执行、无人工请求/工具/终态时，先提交一次不同预期 Run 标识的控制，必须取得明确 stale 拒绝；若返回未知、接收或 idle，停止后续控制。
随后重新核对原任务仍在执行，使用不同输入/操作 ID 提交正确目标的补充；在真实 fetch 启动后、取得回执前关闭本次 Courier 控制连接，保留 unknown，不断言服务器已经接收或尚未接收。
重复读取原句柄，再关闭并重开 Git 外私有 SQLite、重建适配器对象；RPC 方法调用数和 fetch POST 发起数都必须不增加。只关闭本次控制连接，正常桌面原任务继续；观察其明确终态，不重试、不回退队列/新任务或更换 Harness 会话。
这个探测也显式使用最多 5000 行脱敏轨迹。它属于本机故障注入及同进程库/对象重建，不是自然网络故障或完整 Courier 跨进程恢复验收，也不是服务器幂等或权威操作查询；该选项与其他任务选项互斥。
`--steer-waiting` 单独运行原生 AskUserQuestion 合成任务，保持原问题未答时提交一次 steer，并保留约 15 秒的答题前观察。
随后只向仍有效、字段完全相同的原合成问题提交指定选项；记录补充是否在答题前注入，以及注入时原正常提交是否仍未返回、后续内容和原问题是否正确。
按规格，以原任务结束前消费并影响内容判断这项时序；答题前是否注入是单独观察，不另设答题前生效门槛或 15 秒 SLA。
该选项不能与其他任务选项同时使用；遇到执行权限、原问题变化或结果未知时不自动批准、不换通道重试或替换 Harness 会话。
`--steer-waiting-twice` 单独验证同一原问题待答期间的连续两条补充；它与 `--steer-waiting` 互斥，其他范围与时序条件相同。
两条补充使用不同输入/操作 ID 和互补标记，每次提交前重新核对原问题、原任务和待处理请求；第二条不重复第一标记。
两条接收、消费、注入时原提交未返回及后续标记均须分别满足，不能用第一条成功代替第二条证据。原问题答复仍仅限指定合成选项；未知或拒绝不重放。
`--steer-after-completion` 单独检查已结束 Run 的控制边界，不能与其他任务选项同时使用。
先由正常桌面入口完成无工具合成任务，并同时核对原始 ACP 的原 Run 输出与正常桌面返回的 end_turn/空闲状态，才向这个旧 Run 提交一次补充。
随后约 5 秒只读比较原始事件及原 Harness 会话的桌面历史；明确 idle/stale 拒绝、没有消费或新工作观察才记录局部通过。拒绝或未知都不改为 prompt、队列或新 Harness 会话，也不重试。
观察窗口不证明未来永久没有新任务，这个完成后拒绝样本也不代替临近完成时两条补充均在原任务内生效的验证。
`--steer-long-tool` 单独验证受控长工具步骤：仅在本次新 Harness 会话使用 default 权限模式，由 WorkBuddy 的 Bash 执行 sleep 12；命令本身不读写文件或访问网络。
只有原工具/Run 与命令匹配，并在本次独立目录中实际找到唯一、参数匹配的等待进程时，才连续提交两条补充；每次接收后再次核对进程仍在运行。
两条补充使用不同标记，后续分别核对注入、原正常提交仍未返回及已关联输出。允许工具返回后、原任务结束前消费，不额外要求必须在工具执行中消费。
进程检查只读取匹配目录下的命令元数据，不读环境或内存；运行标识、目录、PID 和命令正文不进入报告。出现人工权限、其他工具、错归属或未知结果即停止，不批准或重放，也不能与其他任务选项同时使用。
当前已独立观察两条补充在 running、受控长工具、问题待答及受控报告后期于原提交内分别生效；完整状态覆盖及其他必需能力仍缺证，不能用这些结果启用真实 serve。
私有报告保留同次实验内的标识别名、字段关系、阶段、显式终态及受控标记布尔值；stdout 仅输出摘要，不输出轨迹正文、原标识、思考、路径或未知元数据。
这些任务选项均隐含 `--exercise`；两种问题答复路径应分别使用。前置任务或恢复结果不明时停止追加问题实验。
临时调试连接仅用于本机实验，工具结束后关闭自身进程组并移除原始日志。该模式不提取凭据，也不宣称生产发现/激活能力。

以后集中验证钉钉三条输出时，才给原独立探测追加 `--send-three`；本轮未执行：

```bash
node --env-file=.env build/test/tests/probes/dingtalk-capabilities.js --enable-live --credentials-env --output "$DINGTALK_PROBE_OUTPUT" --send-three
```

该模式只对匹配当前合成标记的原私聊操作。确认业务成功不等于用户已读或所有限额已验证；每条结果私有保存，未知即停止，应用支持状态仍为 unverified。

真实观察入口 `test:live` 不由 `npm test` 执行。私有测试范围文件格式为 `{"allowedSenderIds":["<PRIVATE_TEST_USER_REFERENCE>"],"windowSeconds":60}`，只包含获准测试用户的 senderId，不在共享材料中填真实值。

补充的显式 MCP 格式化来源可通过下列独立入口观察；启动配置和输出仍须位于 Git 外的私有位置：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-bootstrap-owned-formatter
```

该选项与其他独立任务模式互斥。它先核对两轮普通任务的独立创建、恢复及上下文，再正常断连/load 原 Harness 会话，以显式 typed 模式请求两次同文 progress 和一次 final。
创建和每次恢复均配置同一纯格式化生产者；核对原生调用身份、结果回显、三条完整快照和独立的原 Run end_turn。遇到人工请求即保留未验证，不回答或批准；未知结果不重试，不发送钉钉消息。
它需要 Agent 使用纯格式化工具；当前私有连接配置已提供显式模式和随请求发送的输出约定，默认不启动，也不能据此跳过真实服务门槛。
正式入口已局部观察上述三条输出；早期独立 steer 样本未通过原输入归属及补充内容检查，修复后的观察和正式补充探测另记于 verification/formatter-output-2026-11-06.md。

新增运行中格式化输出观察，单独运行，不与三消息模式组合：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-bootstrap-owned-formatter-steer
```

它先验证相同的两轮上下文，再要求八条按序 progress 和一条 final。第一条进度完成、原 Run 仍运行且无人工请求时，连续提交两条不同补充，要求它们修改同一条 final 正文。
通过条件同时检查原始控制响应、每条注入的拥有者延续、各调用保留原输入归属、九条完整消息和原生结果回显，以及两条补充都出现在 final 中且早于原 Run end_turn。额外 final、缺标记、错归属或截断均保留未验证。
typed 模式显式提供原请求跟踪字段；这不提供幂等保证，不允许 unknown 重发。记录限制为 4096 帧/事件及 120 秒；遇到人工请求停止观察，不回答或批准，不发送钉钉消息。该模式不代表完整运行状态或 Courier 重启准入。

本版本工具的 conversationRequestId 与 requestId 可以分别指向原 Run 和已核实的后续拥有者；通过条件要求每个字段都已由此前注入证明归属同一原 Run，并保留原 messageRequestId，不要求两个字段机械相等。证明尚未到达、含未知拥有者、成员或历史帧仍不能接纳。
脱敏诊断仅输出请求字段关系、首个可解析 final 参数/完成帧相对控制和注入的到达次序，以及普通可见文本对受控标记的匹配布尔值。参数帧到达不证明模型内部生成时点；普通文本也不替代类型输出证据。元数据矛盾明细最多 32 条，同时报告总数和明细是否完整；截断不伪称完整诊断。

私有 `connectionProfileRef` 文件现在可额外选择：

```json
{"output":{"mode":"courier-formatter","contractVersion":1}}
```

这是附加到原连接配置的片段，其余 endpoint/cwd/cliVersion/authorizationScope 等字段仍须正常配置；文件和目录仍位于 Git 外并使用私有权限。不写 output 时默认为 acp-text，不允许自定义生产者命令、自由输出规则或未支持的契约版本。
正常组合使用当前 Node 和同包的 formatter-server.js，创建/恢复均传同一生产者；每次 typed 启动提交两个普通 ACP text 内容块：固定输出约定和原样用户输入。它们属于客户端请求内容，角色优先级由 Harness 处理；没有新增 Agent loop、模型调用或权限决定。
模式、契约版本、固定相关代码摘要和 Node 版本均参与证据指纹，普通文本、格式化及旧版无输出配置的指纹不能互换；当前实例探测还会核对代码摘要是否变化，变化或读取失败时全部必需能力保持 unverified，需要重启并重新取得对应证据。
`validate-config` 现在解析连接、平台限额及 Harness 证据 JSON 的结构，不读取 client ID/secret 或令牌内容，也不做网络探测；配置结构通过与能力准入分别检查。真实组合仍在 Stream 注册前拒绝缺证目标。

操作者确认的 Courier 独占模式可在私有连接配置增加：

```json
{"ownership":{"mode":"courier-exclusive","bootstrapSessionRef":"<EMPTY_BOOTSTRAP_HARNESS_SESSION_ID>"}}
```

这是手动提供 H 与 endpoint 的模式，同时要求正常配置 desktopDebugUrl。H 必须是已登录桌面的空白启动宿主；适配器会核对原标识、cwd、明确空闲、三类人工待处理为空及无独立用户任务历史，不能引用用户正在使用的桌面对话。初始化 H 的意图先持久化，返回准确 H 后才允许正常 createSession 创建不同的 A/B。
H 不能承接用户输入，未知/未归属 Courier 的引用也不能 load/start；初始化 unknown/dispatching 不因对象重建重发。模式参与证据指纹，不能沿用普通模式的证据。

自动激活模式改用以下片段，并省略 endpoint 和 bootstrapSessionRef；仍需已启动且登录的桌面、有效 desktopDebugUrl、与桌面一致的绝对 cwd、声明 CLI 版本和其余普通配置：

```json
{"ownership":{"mode":"courier-exclusive"}}
```

工厂会持久登记创建意图，再通过正常桌面 API 创建空白 H，并以准确启动标识或自有预热进程的正常运行注册记录，结合进程所属回环 socket 发现 ACP。已知 H 在下次启动复用；创建结果 unknown/dispatching 时不再创建，已知 H 忙碌或进程状态不明时停止。只有持久进程身份明确证明旧后端已退出才自动创建新空白 H2，保留旧激活记录和原用户 A/B 关联；仅仅找不到端点不能触发替换。自动模式不同时接受固定 endpoint，以免忽略配置或连接到错误进程。
桌面 SDK 会镜像 Courier 的任务活动。只有能逐帧归属已持久化原 Run、输入和已证明 owner 的镜像可保留，工具结果还须关联原工具；不能按正文或当前任务猜测归属。该检查不放宽空闲/人工待处理条件，也不批准权限。自动模式已独立观察后端退出后的新宿主及原 A 恢复，并从正常自有运行注册元数据核实 CLI 2.147.0。实际 Courier 应用进程重启和完整运行状态恢复仍待验收，见 verification/automatic-runtime-2026-11-06.md 与 verification/runtime-recovery-2026-11-06.md。

新增独立普通请求观察：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-bootstrap-owned-formatter-contract
```

该模式与其他独立任务模式互斥；基础两轮上下文通过后，第三个 typed 适配器使用正常配置构造器，用户任务只要求两条同文进度和一个最终回答，不提 MCP 工具名。463 帧独立样本已观察三条原生调用/精确回显及归一化消息，原 Run end_turn，零人工请求/权限批准。
本版本 ACP 没有回传 CLI 版本；该独立观察明确采用 null 未知版本上下文并报告 cliVersionReported=false，其指纹与正常配置声明版本不同，不能将局部结果套成 CLI 版本或真实服务准入证据。正常连接配置仍要求声明版本，并继续核实当前运行版本。

两个独立 Harness 会话的原上下文恢复可单独观察：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-bootstrap-owned-isolation
```

该模式与其他独立任务模式互斥。前置原 Harness 会话创建/恢复通过后，再显式创建第二个不同 Harness 会话并保存另一个合成标记；正常断连后，用不同适配器与连接分别 load 两个原标识。新输入不重述标记，各自输出须精确匹配本会话标记且不含另一标记；每个任务还须有原始 end_turn、完整有界观察及零工具调用。
创建、运行或 load 未知、身份复用、标记不符/串线或观察不完整均停止，不重发、不建替代目标、不回答人工请求。此模式使用已登录桌面的自有隔离目录；无工具/文件/网络访问指令属于对 Agent 的任务约束，不代表 Harness 的沙箱保证。共享结果仅含布尔值和计数；不验证同时活动 Run、两个钉钉用户或实际 Courier 进程重启，见 verification/isolation-2026-11-06.md。

格式化输出完成后的原 Harness 会话历史与续接可单独观察：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-bootstrap-owned-formatter-history
```

该选项与其他独立任务模式互斥。前置两轮原上下文通过后，先验证两条同文 progress 和一条 final；只有原始终态与全部源消息均通过，才正常断开该 Courier ACP 连接。保持自有 Harness 运行进程，新建适配器和 ACP 连接，load 同一个原 Harness 会话，再要求只输出上一轮已格式化的 final；新输入不重述该正文或标记。
分别核对历史标记、三个原生工具身份和完成结果、无旧逻辑消息重复输出，以及新 Run/工具身份不同且原上下文复现。历史模式 codebuddy.ai.mode=history（flat/nested）在参数、更新和内容元数据上均过滤，不能确认新 Run、改变控制状态或作为实时输出；历史 offset 不当作实时片段身份。
报告同时记录 load 返回后的历史帧数，不把 load 返回作为跨 HTTP 流的全局回放屏障。原始观察上限为 4096 帧/事件及 8 MiB；两次格式化任务分别使用有界观察。源任务、load 或续接未知均停止，不重发、不新建替代目标、不回答权限请求。该观察覆盖适配器与连接重建，Courier 应用进程未重启；完整范围见 verification/formatter-history-2026-11-06.md。

新增两次问答与待答期间两条补充的正式观察入口：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-bootstrap-owned-formatter-question-steer
```

该选项与其他独立任务模式互斥。两轮原上下文创建/恢复通过后，第三个 typed 适配器使用同一正常配置构造器，直接启动组合问答 Run；不再通过临时补丁在断连期间追加任务。第一道限定合成单选题待答时提交两条补充，第一条要求再问第二题，第二条要求追加最终标记；只在原生内置工具、题目、选项、原 Run 和各请求通道均匹配后，分别回答预设选项。

通过条件分别核对原始控制响应、完整注入正文与已证明拥有者、两次答复的原始明确回执及对应原生工具完成结果、含全部四项内容的单个原生/归一化 final，以及独立原始 prompt end_turn。未知结果不重试、不换通道；原问题撤销后停止后续控制和答复。发现原始执行权限请求即停止，即使它尚未被适配器标准化；不批准执行权限。问题答复中的 allow 仅用于准确匹配的原生 AskUserQuestion。

观察限于 180 秒、4096 个原始帧/事件和 8 MiB 原始帧序列化总量；截断或超时不能通过。报告只输出有界计数、到达位置、已知状态/结构及受控内容的匹配布尔值，不输出问题、答案、厂商标识或普通正文。到达位置不证明模型内部生成时点；原生工具结果中出现答案也不单独证明后续正文完整保留要求。默认测试只使用合成适配器，不发送真实钉钉消息；独立样本不改变 CLI 版本、正常生命周期或真实服务准入门槛。

```bash
npm run test:live -- --enable-live --config "$COURIER_CONFIG" --scope "$LIVE_SCOPE" --output "$LIVE_OUTPUT"
```

能力门槛先于 Stream 注册；缺证退出 3，不创建模拟证据。监听时只接受清单用户的本次合成标记或显式答复/权限命令。观察结束返回 5 并记录安全计数，仍需逐场景人工复核，不自动写成 SC-001 至 SC-009 或 37 项验收通过。只有一个真实用户时，只能记录单用户观察。


### 独占模式的自动宿主与适配器进程重启观察

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-automatic-runtime
```

两个引用均须为 Git 外私有位置；输出必须是新文件。该模式与其他任务实验互斥，启动本次独立桌面进程，使用已有正常登录；不读取 .env 或凭据文件。三个独立适配器子进程先后执行首轮、原后端复用及确认旧后端结束后的新宿主恢复。只有首轮/续聊完整通过、原宿主空闲无待处理且归属可核实时，才正常结束本次自有后端；不关闭其他桌面会话，不批准权限或发送钉钉消息。

每个子进程限 120 秒，每轮输入限 90 秒、4096 个事件/帧、8 MiB 原始帧和 64 KiB 单消息正文；未知、不完整、非正常退出、外来/重复身份或无法确认旧进程结束均停止，不重试原操作。报告不输出原始引用、正文或进程信息。当前三个独立适配器进程的真实样本通过，仍不是完整 Courier 应用/钉钉重启或必需能力准入，见 verification/runtime-process-2026-11-06.md。


### 启动模式与执行权限等待探测

自动连接配置可以显式请求启动宿主的 default 模式：

```json
{"ownership":{"mode":"courier-exclusive"},"bootstrapPermissionMode":"default"}
```

bootstrapPermissionMode 只接受 default，且仅适用于自动新建宿主；固定端点/宿主模式拒绝该字段。正常创建返回值必须明确确认同一模式，已派发但无法确认时保持 unknown。选项参与宿主缓存和证据指纹；模式不匹配不能静默采用旧宿主，也不能通过删库或重建用户上下文绕过。它不证明后续实际用户 Harness 会话 A/B 的模式，尤其不能当作权限批准。

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-automatic-permission-steer
```

该模式与其他实验互斥，只在本次私有目录配置 Bash ask 规则，并核对实际 A 的 default 模式。通过后才尝试原权限待答期间的两条进度补充，随后只拒绝原权限；不批准执行或发送钉钉消息。早期真实样本停在 A 的模式回读；后续工厂的专用上下文连接已在首次 load 原 A 后确认 default，观察到精确权限、两条补充接收及一次拒绝/原 Run 取消，但拒绝前的两个实际效果仍未通过。结果及边界见 verification/permission-wait-2026-11-06.md 与 verification/context-connection-2026-11-06.md。

工厂内部 contextSessionRef 模式只用于已经归属 Courier 的实际 Harness 会话：先正常释放管理连接，再以专用连接首次 load 原 A，不重新初始化 H。只有原生模式回读明确确认后才允许输入；unknown 配置不重发，外来写入权不抢占。它不是可填写的 JSON 字段。普通独占组合现由 ManagedWorkBuddy 按 A/B 管理连接，持久保留原归属、操作结果和 Run 状态；运行结果 unknown 时不重新加载或执行，真实服务继续受全部准入门槛限制。

连接管理独立观察入口：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-automatic-managed
```

该模式与其他实验互斥，使用生产连接管理类及正常工厂，在自有 A 等待精确合成问题时创建并运行 B，随后仅回答原问题，并检查私有 SQLite 重开后原 A/B 的未重述上下文。不批准执行权限、不发送钉钉消息；不属于真实 Courier 应用进程或钉钉整条链路验收。

自动模式按 Courier 会话分别启动空白宿主和后端，避免共享后端的上下文交错影响人工答案；实际用户的原 A/B 引用保持不变。固定宿主模式不能复用这项隔离结论。另可用互斥的 --acp-automatic-managed-text 仅检查文本/恢复，或 --acp-automatic-managed-question 仅检查单个原上下文的原生问答。结果及失败对照见 verification/managed-connections-2026-11-06.md。

独立后端恢复的两个入口也与其他实验互斥，分别使用新的 Git 外输出文件：

```bash
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROBE_OUTPUT" --acp-automatic-managed-recovery
npm run probe:workbuddy -- --enable-live --launch-profile "$WORKBUDDY_LAUNCH_PROFILE" --output "$WORKBUDDY_PROCESS_OUTPUT" --acp-automatic-managed-process
```

recovery 在 B 原生问题待答期间正常关闭自有空闲 A 后端，确认退出后恢复原 A，再仅答复 B 的精确合成问题。process 使用三个独立适配器进程验证原 A/B、后端复用及仅 A 的宿主替换；父进程必须等到各工作进程真正正常退出。两者不批准执行权限或发送钉钉消息，unknown 不重发。结果及真实 Courier 应用验收的区别见 verification/managed-recovery-2026-11-06.md。

自动组合的输出模式另有四个互斥选项，继续沿用上述私有 launch-profile 和每次新建的 Git 外 output：

| 选项 | 观察范围 |
| --- | --- |
| --acp-automatic-managed-formatter | 普通请求的两条同文进度及最终回复；通过后才重开私有库并复述原上下文 |
| --acp-automatic-managed-formatter-steer | 显式格式化八进度及运行中两条补充 |
| --acp-automatic-managed-formatter-question-steer | 格式化最终回复、两次原生问答和待答期间两条补充 |
| --acp-automatic-managed-question-steer | 不依赖格式化工具的普通文本、两次原生问答及相同两条补充效果；不声称类型分类 |

这些选项要求实际用户 Harness 会话确认 default，不批准执行权限。只精确回答本次内置合成问题；出现执行权限请求即停止后续步骤。当前格式化样本停在原生权限请求，原生文本组合仍缺第二条补充效果，均 unverified。process 模式另检查每个工作进程内和进程间的配置目标一致性；私有原始指纹不输出到公开结果。实际记录见 verification/managed-output-2026-11-06.md。

另有 --acp-automatic-managed-approve-one-formatter 准备验证一次实际权限批准；必须先取得操作者对本次准确范围的明确授权，不能从使用已登录 WorkBuddy 的一般授权推定。它仅匹配原 Run 的一个合成 final 格式化调用，在正常 default 模式提交一次 allow-once，不批准其他工具或持续权限；第二次或不符的决定在网络前拒绝。该入口已有一次经明确授权的 153 帧真实往返通过：原始批准接收、原工具及消息完成、原 Run end_turn 均匹配。本次单次额度已使用，不能复用于后续调用；完整人工能力仍未准入。范围及原生字段解释见 verification/formatter-permission-2026-11-06.md。
