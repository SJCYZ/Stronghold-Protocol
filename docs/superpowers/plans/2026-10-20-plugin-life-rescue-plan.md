# SDK 玩家生命值操作与救援插件实施计划

> **执行者说明：** 按任务逐步实施，必须使用 superpowers:subagent-driven-development；步骤用复选框跟踪。
>
> **目标：** 为服务器脚本插件增加作战结算后的受限生命值 API，并交付默认消耗 10 LP、等待 20 秒、每个目标每局最多复活一次的 life-rescue 插件。
>
> **架构：** Match 在扣完本回合 LP 后暂缓待淘汰玩家的清理，让其阵容、物品、资金、待入账金币、剩余赏金和未领取奖励留在原状态。带有 match.life 权限的服务端插件通过结算回调创建救援窗口；原生界面发送专用 g.rescue，由 Match 原子验证扣款和复活。到期未救援的玩家再执行原淘汰清理。
>
> **技术栈：** JavaScript ES modules、Node.js、现有 Match Worker/插件 Host、Preact/htm 原生界面、现有插件清单和 i18n。
>
> **设计稿：** docs/superpowers/specs/2026-10-20-plugin-life-rescue-design.md

## 全局约束

- 新增 match.life 权限仅允许 script/trusted 插件；所有写操作由服务器 Match 执行，浏览器和 UI iframe 不得修改 LP。
- 回调只在整批结算结束后、推进下一轮之前运行；变更 LP 的接口只在该回调上下文有效。
- 插件设置 lifeCost 为整数，默认 10，范围 1–100；客户端不能指定代价或救援者身份。
- 救援窗口为 20 秒；救援者付款后至少剩 1 LP；每个目标每局最多成功复活一次。
- 目标复活到 1 LP，保留结算后的资金、pendingFunds、剩余赏金、未领取奖励和个人选择；商店由下一轮正常刷新。
- 只有有合格真人救援者时才启动 20 秒窗口；其余情况保持现有 3 秒结算流程。
- 待淘汰玩家从 Match 存活玩家计算中排除；窗口结束时未救援目标调用现有 eliminate()，保留既有库存释放逻辑。
- 救援标记进入安全检查点；不新增 SETTLE 断点续时。Match Worker 与本地 Match 使用同一状态机。
- 按 AGENTS.md 只提交本任务文件，保留既有代码和本地设置。
- 未经用户明确授权，不新增或运行测试；计划列出的测试步骤须等用户授权后执行。可先做非测试的 diff/格式检查。

## 审查重点

1. 同一目标并发救援：首个有效请求只扣一次 LP，后续请求不扣款。归属：Match 测试。
2. 待淘汰目标仍保留库存，超时淘汰仅释放一次；救援成功不重复占用库存。归属：Match 测试。
3. 救援者为 AI、已淘汰或付款后不足 1 LP，或请求阶段已过期。归属：Match 与 intent 测试。
4. 旧检查点不含救援标记，以及救援已发生后的新安全检查点恢复。归属：snapshot 测试。
5. 原生界面显示的代价、目标、倒计时与服务端状态不一致或已过期。归属：UI/协议测试。

---

## 文件职责

- SDK 权限及结算回调：shared/plugins/manifest.js、shared/plugins/sdk.js、server/sim/content/extensions.js。
- Match 状态、玩家次数、结算与 intent：server/match/Match.js、server/match/PlayerState.js、server/match/player/round.js、server/match/match/settle.js、server/match/match/intents.js、server/match/match/views.js、server/match/audit.js、server/match/snapshot.js。
- 客户端协议和救援操作面板：public/js/screens/game.js、public/js/ui/gameLogic/phases.js、public/i18n/en.json、public/i18n/ja.json、public/i18n/ko.json、public/i18n/zh-TW.json。
- 插件及文档：plugins/life-rescue/plugin.json、plugins/life-rescue/sim/index.js、docs/PLUGINS.md、由 surface 命令生成的 docs/PLUGIN-API.md、docs/design/match.md。
- 新测试候选：test/plugins/life-rescue-sdk.test.js、test/plugins/life-rescue-script.test.js、test/match/life-rescue.test.js、test/ui/life-rescue.test.js、test/match/life-rescue-host.test.js。

## 分工

先由主代理固定下述 SDK 回调契约。随后用 GPT-6 Luna 子代理处理互不重叠的 SDK/权限、原生界面、插件包及文档任务；主代理负责 Match 状态机、跨 Worker 接线和整合审查。每个子代理只拿到其负责文件和相关契约，避免把整份设计上下文重复塞入子代理。任何测试动作均受全局约束限制。

## 任务 1：注册结算期 SDK 生命周期与生命值权限

**文件：**

- 修改：shared/plugins/manifest.js、shared/plugins/sdk.js、server/sim/content/extensions.js
- 测试候选：test/plugins/life-rescue-sdk.test.js

**接口：**

- SDK 成员：sp.match.life.onPostSettlement(handler)
- handler 在服务端每次 LP 结算后调用一次，收到只读 players 数组和本次 Match 专属操作：
  - changeLife(playerId, delta)：仅对仍存活玩家应用整数 LP 差值；负数同步累计 stats.lpLost。
  - revive(playerId, lp = 1)：仅能复活本次结算的待淘汰目标；服务器验证正 LP、每目标每局一次，并清除待淘汰状态。
  - offerRescue({ cost, durationMs, targetIds }, handler)：登记本次 SETTLE 的救援目标、代价和时限；handler 收到服务端确认的 rescuerId/targetId，并在同一 Match 处理步骤内调用 changeLife 与 revive。
- 只读玩家视图包含 playerId、isBot、alive、lp、pendingElimination、lifeRescueUsed；不得暴露 PlayerState 引用。
- offerRescue 使用专用救援语义，不开放任意 Match action 注册；Match 最多接受本次仍有效的窗口请求。
- 浏览器模拟可注册该回调，但不得执行结算回调，也不获得可用的写上下文。
- SDK 缺少 match.life 权限时，以既有 PLUGIN_PERMISSION_MISSING 错误拒绝注册。

**步骤：**

- [ ] （需测试授权）编写权限缺失、只读视图、服务端调用与浏览器不执行写操作的测试。
- [ ] 在 manifest 权限表允许 script/trusted 声明 match.life；保留未知权限、类别和未使用权限检查。
- [ ] 在 extensions 注册结算回调，并在 SDK 中加入带权限校验的 onPostSettlement；仅在服务端 Match 调用时提供 changeLife、revive 和 offerRescue。
- [ ] （需测试授权）运行 node --test test/plugins/life-rescue-sdk.test.js，确认未授权注册失败且客户端无法触发生命值写操作。

## 任务 2：实现待淘汰状态、扣款/复活和安全检查点

**文件：**

- 修改：server/match/Match.js、server/match/PlayerState.js、server/match/player/round.js、server/match/match/settle.js、server/match/match/intents.js、server/match/match/views.js、server/match/audit.js、server/match/snapshot.js、shared/protocol.js
- 测试候选：test/match/life-rescue.test.js、test/match/life-rescue-host.test.js、现有 test/match/snapshot.test.js

**接口：**

- 客户端 intent：g.rescue { targetId }。救援者身份始终取自已认证 intent 的 PlayerState。
- Match 对外状态提供可见的待救目标、救援代价和既有 SETTLE deadline；不接受客户端提供 cost、rescuerId 或窗口时长。
- PlayerState 增加 pendingElimination 和 lifeRescueUsed，旧检查点缺字段时默认 false。

**步骤：**

- [ ] （需测试授权）编写救援成功、20 秒窗口、无资格仍走 3 秒、并发请求、重复救援、救援者至少保留 1 LP、超时淘汰及存活检查等 Match 用例。
- [ ] 在 PlayerState 初始状态与 snapshot 序列化/恢复中加入本局救援标记；旧 snapshot 缺少该标记时按未救援处理。
- [ ] 在 settle() 完成所有现有结算后，将 LP 不高于 0 的玩家标记为 pendingElimination，不立即调用 eliminate()；调用 SDK 结算回调。仅在插件建立有效窗口且存在合格真人救援者时延迟清理并把 SETTLE deadline 设为 20 秒；否则立即调用 eliminate()，保留原 3 秒 deadline。
- [ ] 让 alivePlayers()、公开玩家视图、普通阶段操作和 audit 区分待淘汰与已清理淘汰；待淘汰目标不能参与下一轮、AI 行为、普通 Match intent 或存活人数判断。
- [ ] 在 g.rescue handler 中重新检查 SETTLE 阶段、deadline、目标状态/次数、真人救援者存活、代价及付款后 LP>=1；验证、扣款、stats.lpLost 更新、复活到 1 LP 和一次性标记在同一 Match 步骤内完成。失败不扣款。
- [ ] 在窗口到期时只对仍待淘汰玩家调用现有 eliminate()；随后运行原 afterSettle 存活检查。窗口开启期间不清除棋盘、手牌、临时区、棋子/装备实例、库存来源、结算后的资金/待入账金币/赏金/奖励/个人选择。
- [ ] （需测试授权）运行 node --test test/match/life-rescue.test.js test/match/snapshot.test.js test/match/life-rescue-host.test.js，确认本地 Match、Match Worker 和安全检查点恢复遵循同一规则。

## 任务 3：在原生 SETTLE 界面呈现救援操作

**文件：**

- 修改：public/js/screens/game.js、public/js/ui/gameLogic/phases.js、public/i18n/en.json、public/i18n/ja.json、public/i18n/ko.json、public/i18n/zh-TW.json
- 测试候选：test/ui/life-rescue.test.js

**接口：**

- 客户端只发送 g.rescue { targetId }；代价、身份、是否可救援由服务端状态决定。
- SETTLE 公共状态携带目标/代价/截止信息；界面根据当前玩家 LP 与服务端状态显示可用/不可用操作。

**步骤：**

- [ ] （需测试授权）编写协议字段拒绝、只有窗口期间显示救援入口、倒计时/代价正确及失效请求不显示为成功的 UI 测试。
- [ ] 在现有 SETTLE 结果提示中加入救援目标列表、每个目标的已救/待救状态、代价和倒计时；可支付者可提交操作，救援者 LP 不足者禁用操作。
- [ ] 处理 Match 广播后的状态更新：目标已救、窗口到期、玩家失去资格时立即更新控件；失败请求沿用协议错误，不展示成功提示。
- [ ] 为新增游戏内文字补齐现有公共 i18n 包，保持中文文案作为源文案。
- [ ] （需测试授权）运行 node --test test/ui/life-rescue.test.js，确认旧 SETTLE 流程和救援窗口视图都能正确呈现。

## 任务 4：交付 life-rescue 插件并同步 SDK/玩法文档

**文件：**

- 新建：plugins/life-rescue/plugin.json、plugins/life-rescue/sim/index.js
- 修改：docs/PLUGINS.md、docs/design/match.md
- 生成更新：docs/PLUGIN-API.md

**插件契约：**

- manifest class=script，声明 sim.code 与 match.life；lifeCost 为 integer、min=1、max=100、default=10。
- setup 从 sp.settings.lifeCost 读取唯一配置；onPostSettlement 发现待救目标和至少一名支付后仍有 1 LP 的真人救援者时调用 offerRescue，时限为 20_000 ms。
- onRescue 只调用本次上下文的 changeLife(rescuerId, -lifeCost) 和 revive(targetId, 1)；不处理客户端身份、支付验证或库存恢复。
- 插件不加入房间的隐式默认规则；按现有插件启用、内容锁定与房间同意流程使用。

**步骤：**

- [ ] （需测试授权）编写插件默认值、设置范围和只在合格真人捐赠者存在时开启窗口的插件测试。
- [ ] 新建 life-rescue manifest 与 sim entry，注册 onPostSettlement，并以现有 Preact/插件 SDK 约定实现救援策略。
- [ ] 在 docs/PLUGINS.md 说明服务端 Match API、权限、回调时序、超时/回滚和原生界面边界；在 docs/design/match.md 记录待淘汰与救援规则。
- [ ] 用 node tools/plugin.mjs surface --write 更新 docs/PLUGIN-API.md；用 node tools/plugin.mjs check life-rescue 检查 manifest/API 契约。
- [ ] （需测试授权）运行 node --test test/plugins/life-rescue-script.test.js，确认锁定设置及插件入口能注册预期策略。

## 任务 5：整合审查与提交

**文件：**

- 仅限以上任务涉及文件及其测试文件

**步骤：**

- [ ] 主代理逐条对照设计稿验收条件审查权限边界、回合流程、库存占用、pendingFunds/奖励、审计、快照、Worker、UI 和插件锁定。
- [ ] 检查各子代理变更无文件重叠遗漏；修复后只复审受影响部分。
- [ ] （不运行测试）执行 git diff --check 并审查最终 diff；只有在用户明确授权后才执行计划内测试命令。
- [ ] 按文件职责分批暂存，只提交本任务路径；保留项目中原有未提交内容。

## 完成标准

插件启用时，符合资格的真人玩家能在 20 秒内为每个尚未获救目标支付配置 LP 并复活到 1 LP；付款者仍至少有 1 LP。复活者延续结算后的阵容、物品、库存来源、资金与未领取状态；未获救者到期按原逻辑被淘汰。插件缺失、没有可支付救援者、非法/重复/并发请求、旧检查点、Match Worker、本地 Match 和界面状态均满足设计稿规则。
