# 跨局统计、排行榜与房间发现实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：** 实现与跨任务复审完成；最终提交由主代理处理。

**目标：** 为 SSO 账号同步完整本机战绩并持久保存，在主页展示两类排行榜和可参与/观战的合作房间列表。完整导入本机历史用于云端归档与跨设备恢复，但未经服务器验证的历史记录不计入公开榜单。

**架构：** 使用现有认证会话保护账号战绩写入；每个账号的完整记录与回合中漏怪进度独立持久化，公开榜单只暴露昵称和数值。主页复用现有大厅页面，房间加入继续走既有 WebSocket 协议；游客和临时账号不进入云端路径。

**技术栈：** Node.js ESM、现有 Redis 连接、原生 HTTP、WebSocket、Preact/HTM、`node:test`、Vite。

**规格：** `docs/superpowers/specs/2026-10-23-cross-match-stats.md`

## 全局约束

- SSO 账号才可云同步；临时登录只保留本机统计。
- 识别码公开格式固定为 `SP-XXXX`，每次主页显示；排行榜显示昵称，不显示原始身份或完整哈希。
- 本机统计沿用记录迁移、ID 去重、`MAX_RECORDS`、`MAX_CHARS` 与既有奖杯口径。
- Redis 不可用时不冒报同步成功；新统计资料使用独立持久化键，不改变现有房间/对局检查点文档。
- 房间列表只返回摘要；参与和观战最终由既有服务端校验。
- 不重启或部署在线服务器。

## Review Focus

1. 访客或过期 SSO 会话尝试同步时不得创建云端资料；由任务 1 的认证 API 测试覆盖。
2. 多设备重复合并、较新记录保留、清空本机后恢复及未来版本记录保护；由任务 2 的同步控制器测试覆盖。
3. 同一局同一回合重发、重连后累计值回退、整局记录与临时回合贡献重叠；由任务 1 的回合存储测试覆盖。
4. 完整导入的旧记录、测试/插件/中途退出和队友奖杯不得贡献公开榜分；榜单只累计服务器内部权威回合/整局结算数据，由任务 3 的榜单聚合测试覆盖。
5. 私人/单人/满员房间及观战席耗尽时的摘要和按钮；由任务 4 的 API 与大厅组件测试覆盖。

---

### 任务 1：账号战绩存储与认证 API

**文件：**
- 新建：`server/accountStats.js`，负责账号识别码、记录合并、回合进度及排行榜分数。
- 修改：`server/redis.js`，通过现有 Redis 连接提供无 TTL 的独立账号记录读写；不改变全局状态保存行为。
- 新建：`server/http/accountStats.js`，实现 SSO 会话认证的战绩同步和回合更新路由。
- 修改：`server/index.js`，接入统计 API 与账号统计仓库。
- 测试：`test/account-stats.test.js`、`test/account-stats-api.test.js`。

**接口约定：**
- `createAccountStats({ store, now })` 返回 `mergeRecords(subject, records) -> Promise<{ publicId, records }>`, 服务端内部方法 `updateRound(subject, { matchId, round, leaks, name })`、`completeMatch(subject, { matchId, roomMode, cups, leaks, name })`、`leaderboards(limit = 10) -> Promise<{ cups, leaks }>` 与 `getPublicId(subject) -> Promise<string>`。
- `POST /api/player-stats` 使用 `Authorization: Bearer <session token>`，JSON `{ v, records }`，回 `{ publicId, v, records }`；只接受仍有效的 SSO 账号会话。
- 回合漏怪与正式结算分数只由可信服务端 Match/Lobby 回调调用；禁止提供客户端可写的分数更新路由。`POST /api/player-stats` 仅用于完整战绩存档同步，不得让绑定后的新上传/编辑历史改写榜单。
- 榜单查询由主页公开 API 提供，不返回账号内部键。
- Redis 不可用时写入请求返回可识别失败状态；不得伪装为持久化成功。

- [x] **步骤 1：先写失败测试。** `test/account-stats.test.js` 覆盖完整归档合并、旧回合忽略、正式结果替换临时贡献与幂等；新增首次导入伪造历史仍完整保存但不计榜的回归。`test/account-stats-api.test.js` 覆盖访客/过期 SSO 拒绝及 Redis 不可用状态。
- [x] **步骤 2：运行测试确认失败。**

运行：`node --test test/account-stats.test.js test/account-stats-api.test.js`

预期：新测试因仓库接口/实现缺失而失败。

- [x] **步骤 3：实现上述 `createAccountStats` 与两个认证 HTTP 路由。** 记录存储以 `sha256(subject)` 为内部键；公开 API 不返回此键。排行榜分数只来自服务端内部权威回合/整局结算数据，客户端同步历史只用于存档与跨设备恢复。
- [x] **步骤 4：重新运行定向测试确认通过。**

运行：`node --test test/account-stats.test.js test/account-stats-api.test.js`

预期：所有断言通过；Redis 未配置用例明确返回未持久化状态。

- [x] **步骤 5：提交。**（任务 1 已提交；最终安全修复仍由主代理提交。）

```powershell
git add server/accountStats.js server/redis.js server/http/accountStats.js server/index.js test/account-stats.test.js test/account-stats-api.test.js
git commit -m "feat: add persistent account match stats"
```

### 任务 2：本机战绩的 SSO 双向同步

**文件：**
- 新建：`public/js/ui/cloudStats.js`，管理登录门槛、HTTP 传输和本机/云端合并。
- 修改：`public/js/ui/stats.js`，导出并复用现有统计读取/保存/合并能力，不改变原记录内容。
- 修改：`public/js/screens/lobby.js`，账号进入主页后触发同步并显示 `SP-XXXX`。
- 修改：`public/js/main.js`，收到本机新结算记录后触发上传。
- 测试：`test/ui/cloud-stats.test.js`、扩展 `test/ui/stats.test.js`。

**接口约定：**
- `syncCloudStats({ authType, token, stats, fetchFn }) -> Promise<{ synced, publicId, stats }>`；`authType !== 'account'` 时不调用网络。
- 同步使用 `/api/player-stats`；合并后保存云端返回的 `v/records`，成功标记只在服务端确认持久化后出现。
- 本机清空只清本机数据；下次主页同步将服务器历史合并回本机。

- [x] **步骤 1：先写失败测试。** `test/ui/cloud-stats.test.js` 覆盖访客跳过请求、首次 SSO 上传本机完整记录、按 ID 合并、清空本机后从云端恢复及未来版本保护。
- [x] **步骤 2：运行测试确认失败。**

运行：`node --test test/ui/cloud-stats.test.js test/ui/stats.test.js`

预期：新同步测试失败，原统计行为保持通过。

- [x] **步骤 3：实现 `syncCloudStats` 并接入主页与结算记录入口。** 使用现有 `identity.getAuthType()` / `identity.getToken()`；服务端仍是认证权威。
- [x] **步骤 4：重新运行定向测试确认通过。**

运行：`node --test test/ui/cloud-stats.test.js test/ui/stats.test.js`

预期：测试通过；游客保持本机数据且不会访问云端。

- [x] **步骤 5：提交。**（任务 2 已提交。）

```powershell
git add public/js/ui/cloudStats.js public/js/ui/stats.js public/js/screens/lobby.js public/js/main.js test/ui/cloud-stats.test.js test/ui/stats.test.js
git commit -m "feat: sync account match history across devices"
```

### 任务 3：排行榜聚合与回合漏怪更新

**文件：**
- 修改：`server/match/Match.js`、`server/match/match/settle.js` 与 `server/match/results.js`，在每回合结算后触发 `onRoundEnd({ matchId, round, players: [{ playerId, leaks }] })` 账号统计回调，并向整局结果携带稳定 `matchId`（`roomCode` 与 `matchNo` 的组合）。
- 修改：`server/workers/matchWorker.js`、`server/workers/matchPool.js`，把权威回合结算事件传回大厅并调用 `hooks.roundEnd`；官方对局 Worker 路径必须保留事件顺序。
- 修改：`server/lobby.js`，将事件中的真人玩家映射到 SSO 账号，并调用任务 1 的 `updateRound`；排除测试局和玩法插件局。
- 修改：`server/accountStats.js` 与 `public/js/ui/stats.js`，在同步记录中保留服务器 `matchId`；服务端正式结果调用内部 `completeMatch` 固化分数并清理临时贡献，archive sync 不改榜分。
- 测试：`test/match/account-stats-round.test.js`、`test/account-stats.test.js`。

**接口约定：**
- `matchId` 由服务器按 `<roomCode>:<matchNo>` 生成并放入 `m.result`；客户端不自行编造。
- `MatchSettle.settle()` 在服务器已累计 `ps.stats.leaks` 后发出权威回调；大厅按 `matchId + round` 幂等保存 SSO 真人账号玩家的累计值，排除测试局、玩法插件局、guest、临时身份和观战者。
- 最终官方结果由服务端 `completeMatch` 固化 cups/leaks 并删除该局临时贡献，不能由客户端 archive sync 改分；完整结果、本机记录与回合 key 使用相同 `matchId`。大厅从当前会话读取可信昵称并一并传入仓库。

- [x] **步骤 1：先写失败测试。** `test/match/account-stats-round.test.js` 覆盖累计漏怪回调、Worker 转发和稳定 matchId；账号统计测试覆盖回合与整局幂等，并验证任何同步归档都不能贡献榜分。
- [x] **步骤 2：运行测试确认失败。**

运行：`node --test test/match/account-stats-round.test.js test/account-stats.test.js`

预期：新增回合用例失败。

- [x] **步骤 3：实现稳定对局标识及服务器回调接线。** 只统计官方对局；不更改战斗统计或玩法结算。
- [x] **步骤 4：重新运行定向测试确认通过。**

运行：`node --test test/match/account-stats-round.test.js test/account-stats.test.js`

预期：幂等与完成整局不双计断言通过。

- [x] **步骤 5：提交。**（任务 3 已提交。）

```powershell
git add server/match/Match.js server/match/match/settle.js server/match/results.js server/workers/matchWorker.js server/workers/matchPool.js server/lobby.js server/accountStats.js public/js/ui/stats.js test/match/account-stats-round.test.js test/account-stats.test.js
git commit -m "feat: update leak leaderboard after round settlement"
```

### 任务 4：主页榜单与合作房间列表

**文件：**
- 修改：`server/publicApi.js`，增加公开合作房间摘要列表和排行榜只读路由。
- 修改：`server/index.js`，把任务 1 的统计仓库提供给公开 API。
- 修改：`server/lobby.js` 或在 `server/publicApi.js` 中对 `lobby.rooms` 做纯摘要投影；只列合作房间。
- 新建：`public/js/ui/lobbyDiscovery.js` 与 `public/css/lobby-discovery.css`，展示两个前十榜及房间列表。
- 修改：`public/js/screens/lobby.js`，在现有大厅内挂载主页信息组件。
- 测试：扩展 `test/public-api.test.js`，新建 `test/ui/lobby-discovery.test.js`。

**接口约定：**
- `GET /api/rooms` 返回 `rooms[]`，字段限于 `{ code, host, occupied, capacity, difficulty, difficultyName, inMatch, phase, round, joinable, watchable, spectators, spectatorCapacity }`。
- `GET /api/leaderboards` 返回 `{ cups: [{ name, value }], leaks: [{ name, value }] }`；不返回身份键。
- 房间列表使用既有 `room.join` / `room.spectate`，按钮只在摘要显示可用时出现；服务端原有准入逻辑不变。

- [x] **步骤 1：先写失败测试。** `test/public-api.test.js` 覆盖合作房间摘要字段、安全边界、观战容量、榜单投影和公共查询限流；`test/ui/lobby-discovery.test.js` 覆盖参与/观战协议按钮。
- [x] **步骤 2：运行测试确认失败。**

运行：`node --test test/public-api.test.js test/ui/lobby-discovery.test.js`

预期：新端点和组件测试失败。

- [x] **步骤 3：实现摘要 API 与主页组件。** 页面复用现有大厅布局与缩放规则；仅当大厅可见时按固定间隔刷新公开摘要，不触碰对局状态。
- [x] **步骤 4：重新运行定向测试确认通过，并执行本功能回归。**

运行：`node --test test/public-api.test.js test/ui/lobby-discovery.test.js test/ui/cloud-stats.test.js test/ui/stats.test.js test/account-stats.test.js test/account-stats-api.test.js test/match/account-stats-round.test.js`

结果：96 项中 93 项通过，另有 3 个既存的无认证票据 `hello` 测试失败，已确认在未修改基线同样失败。

- [x] **步骤 5：构建并提交。**（任务 4 已提交；Vite runner 构建成功。）

运行：`npm run build`

结果：Vite runner 构建成功；完整 `npm run build` 中 vendor 阶段因环境权限限制无法写入依赖文件，未将其报告为通过。

```powershell
git add server/publicApi.js server/index.js public/js/ui/lobbyDiscovery.js public/css/lobby-discovery.css public/js/screens/lobby.js test/public-api.test.js test/ui/lobby-discovery.test.js
git commit -m "feat: add lobby leaderboards and room browser"
```

### 最终检查

- [ ] 在本地 Redis 集成测试中确认账号记录无 TTL，服务端重启后可读；不连接或重启线上服务器。（未执行；当前证据为无 TTL 写入实现及定向存储/API 测试。）
- [x] 检查跨任务身份隔离、服务端分数可信性/幂等、旧历史归档与云端恢复、Worker 事件连接、房间摘要/协议、公开接口限流和主页生命周期；发现并修复首次 SSO 历史导入可伪造榜分的问题。
- [x] 运行全分支 focused tests；96 项中 93 项通过，3 个无认证票据 `hello` 测试在未修改基线亦失败。
- [x] Vite runner 构建成功；记录完整 `npm run build` 的 vendor 写入权限限制，未声称该步骤通过。
- [ ] 最终 Git 状态、提交与原始 `master` 工作区核对由主代理完成。
