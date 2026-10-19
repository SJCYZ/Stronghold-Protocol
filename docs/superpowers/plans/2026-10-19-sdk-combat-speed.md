# SDK 战斗调速时钟实施计划

- 对应设计：[SDK 战斗调速时钟设计](../specs/2026-10-19-sdk-combat-speed-design.md)
- 状态：待用户审阅
- 目标：实现服务端权威、插件可编排的战斗阶段时钟与 0.1–3.0 倍调速。

## 范围和固定约束

- 使用 `clock.speed` 权限，SDK 暴露阶段回调、逻辑时间读取、一次性/周期计时和 `setSpeed`。
- 速度只能由插件 Match Host 改变；客户端只接收 `b.speed`，不增加客户端调速意图。
- 每个活动战斗阶段从逻辑时间 0、速度 2.0 开始；暂停冻结逻辑时间；阶段内字段替换、Boss 轮次切换和接管不重置时钟。
- 只允许一个有效的速度控制插件；范围严格为 0.1–3.0，每次步进 0.1。
- 原版对局保持 2.0 默认速度。本任务不改战斗规则和模拟结果。
- 不在本阶段修改、运行测试；如需测试验证，待用户明确授权后按文末候选范围执行。

## 执行分工建议

计划获批后按 GPT-6 Luna 子代理协作执行，避免多个任务争用同一文件：

- 主代理负责 Match 级时钟、phase/field/deadline/Boss/暂停/快照接线及最终整合。
- 子代理 A 负责 SDK 注册、`clock.speed` 权限、内容集唯一控制器冲突和插件 API 文档；接口固定为本计划所列 `sp.clock.onPhase`。
- 子代理 B 负责 `b.speed` 协议登记与浏览器 runner 重基准；消息字段依照主代理确认的服务端时钟契约。
- 各部分通过代码审查后再整合；时钟状态、暂停及恢复实现保持单线修改，避免并行冲突。

## 实施步骤

### 1. 建立 Match 级逻辑战斗时钟

在 `server/match/Match.js` 初始化当前阶段时钟状态，并在 `server/match/match/` 增加 Match 专属时钟实现（候选文件 `combatClock.js`）。时钟按真实时间区间累计当时的速度；切速前先结算旧速度区间，再更新当前速度。保留 `gameSpeed` 作为当前速度的兼容读取点，逐步将时间计算改为调用统一时钟。

接入阶段开始/结束边界：普通 COMBAT、UNITE、FINAL_ASSAULT、HIDDEN_CORE 阶段开始时重置逻辑经过时间并恢复 2.0；阶段内部创建新字段、Boss 换轮或客户端/服务端接管时保持现有阶段时钟。接入 `Match` 现有调度器和暂停状态，不使用插件可见的墙钟 API。

### 2. 注册受权限约束的插件时钟控制器

- 在 `shared/plugins/manifest.js` 增加只适用于代码插件的 `clock.speed` 权限，并让声明权限触发既有权限有效性、类别和未使用权限检查。
- 在 `shared/plugins/sdk.js` 暴露 `sp.clock.onPhase(...)`，调用时校验权限；维护 `SDK_MEMBERS`。注册只在服务端 Match Host 激活，浏览器模拟环境不得执行阶段回调或改变服务端速度。
- 在 `server/sim/content/extensions.js`（或同职责的现有注册层）保存时钟控制器并提供 Match 读取入口；复用内容组合阶段的重复注册冲突处理，第二个速度控制器导致内容集拒绝。
- 为 Match 级计时回调接入既有插件异常隔离和预算限制；预算耗尽或抛错时记录该插件错误并取消它后续待执行的计时任务，其他插件和对局继续运行。

### 3. 让所有服务端战斗时钟消费者使用可变速时钟

按统一逻辑时钟改造以下路径，避免继续用“字段起始墙钟 × 当前速度”推导经过时间：

- `server/match/match/clientCombat.js`：字段 elapsed、`b.start` 初始基准、客户端结果 deadline、服务端结果自然释放时间。
- `server/match/fields.js`：`FieldRunner` 与 `HeadlessPacer` 的 tick/追赶累加；切速时重锚其上次采样点，避免旧区间被新速度重算。
- `server/match/match/combat.js`、`unitePhase.js`、`bossRounds.js`：phase 截止、Boss 进度预算、加时和场地切换期间的时钟基准。
- `server/match/match/pause.js`：暂停期间冻结时钟，恢复后续跑；暂停与切速交错时不重复计入暂停或时间区间。

设置速度时统一重算或重挂所有受影响的 scheduler deadline；速度变化不得跳过、提前或延后已经按逻辑时间定义的到期条件。

### 4. 同步速度到客户端并正确重基准

- 在 `shared/protocol.js` 登记服务端消息 `b.speed`，携带阶段实例、逻辑经过时间、速度和服务端基准时间。
- 在 Match 速度变更入口先结算旧时钟，再发送 `b.speed` 给当前对局参与者和观战者；复用 Match 现有 `send`/`broadcast` 通路。插件 Match Host 通过标准 `b.*` 输出，不新建 Host IPC 消息。
- 在 `public/js/battle/runner.js` 接收 `b.speed`，校验消息仍属于当前战斗/阶段后，以服务端逻辑时间和新速度重设 runner 基准，避免跳帧、倒退或重复追赶。
- 新建字段、重连及观战重新进入时由 `b.start` 直接提供当前速度和逻辑经过时间；保留原有 `b.start` 字段，未启用动态调速的普通对局继续兼容。

动态调速需要客户端实现 `b.speed`。计划不增加版本协商；上线启用该权限前，服务端与参与者客户端必须是支持此消息的兼容版本。

### 5. 保存和恢复时钟状态

沿用仓库现有安全检查点范围，不扩展为保存进行中的战斗对象。`server/match/snapshot.js` 保存 Match 阶段实例序号；活动战斗的时钟、字段和插件计时器仍随未检查点化的战斗一起丢弃。恢复安全检查点后，本轮战斗从头开始，并创建新的阶段时钟与回调计划；旧快照没有实例序号时使用 Match 初始化值。玩家断线/重连不重启 Match，继续沿用当前阶段时钟及速度。

确认本地 Match、插件 Match Host 和 `server/workers/matchWorker.js` 的检查点/恢复均经过同一 Match 时钟实现；Worker 的通用 Match 调用及现有 IPC 无需为调速单独扩展。

### 6. 更新插件文档和 API 清单

- 在 `docs/PLUGINS.md` 说明新权限、服务端阶段回调语义、计时单位、暂停行为、唯一控制器限制和速度范围。
- 更新 SDK 成员清单，并确认 `shared/plugins/surface.js` 从权限定义和 `SDK_MEMBERS` 自动生成对应条目；只在生成规则确实缺项时修改该文件。使用仓库现有 surface 生成工具更新 `docs/PLUGIN-API.md`，保留生成文件结构。
- 更新 `shared/protocol.js` 消息注释，描述 `b.speed` 方向和字段语义。

## 后续验证候选范围

以下是代码完成后适合的现有回归入口。本阶段不新增或运行测试；若用户明确要求测试/验证，再根据最终实现扩展并执行相关覆盖：

- 服务端计时、结果期限、接管与速度同步：`test/match/clientCombat-review.test.js`、`test/match/clientCombat.test.js`。
- 客户端 `b.speed` 重基准和重连：`test/match/runner.test.js`。
- 暂停、deadline 和时钟交错：`test/match/leftovers.test.js`。
- 快照恢复：`test/match/snapshot.test.js`、`test/workers.test.js`。
- 权限、SDK 成员和 API surface：`test/plugins/manifest.test.js`、`test/plugins/script.test.js`、`test/plugins/surface.test.js`。
- 原生/沙箱插件路径：`test/plugins/script-integration.test.js`、`test/plugins/script-sandbox-integration.test.js`、`test/plugins/sandbox-host.test.js`。

## 主要风险与完成条件

动态速度会影响结果期限、服务器追赶节奏和 Boss 进度校验。只更新 `gameSpeed`、却未将字段起点、截止时间、暂停和恢复统一到可变速逻辑时钟，会造成时间漂移。实现须覆盖上述调用路径，且只有服务端可写速度；最终状态应满足设计文档中的全部验收条件。
