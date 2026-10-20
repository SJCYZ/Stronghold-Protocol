# 房主战斗速度滑条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement the tasks with GPT-6 Luna subagents; keep each assignment scoped to its task files and return concise findings.

**Goal:** 移除本机 `combat-speed` 插件，提供房主控制、服务器权威、Match 内跨战斗阶段沿用的 `0.1`–`4.0` 倍滑条。

**Architecture:** 新增 `g.speed` Match 意图，由服务端验证当前房主并调用已有 `MatchCombatClock`，继续用 `b.speed` 同步所有战斗视图。将获准设置写入当前 Match 的默认速度，并复用检查点中的 `gameSpeed` 恢复；新 Match 初始化为 `2.0`。HUD 提供房主滑条和其他玩家只读显示，删除本机插件包但保留通用 SDK 时钟接口。

**Tech Stack:** Node.js ESM、共享 WebSocket 协议、Match CombatClock、Preact/HTM HUD、CSS、Node `node:test`、Vite。

**Spec:** [2026-10-20-host-combat-speed-slider-design.md](../specs/2026-10-20-host-combat-speed-slider-design.md)

## Global Constraints

- 速度为 `0.1`–`4.0`，按 `0.1` 递增；生产默认 `2.0`。
- 房主通过服务器意图调速；客户端只消费 `b.start` / `b.speed`，不自行设定战斗模拟速度。
- 调速值在当前 Match 各活动战斗阶段间沿用，新建 Match 回到 `2.0`，不写浏览器偏好。
- 保留暂停语义、内部 `opts.combatSpeed` 工具覆盖、通用 `clock.speed` / `sp.clock.onPhase` SDK 和非目标插件。
- 只删除本机 `plugins/combat-speed` 包；先检查其目录链接目标，不能递归删除链接指向的包外数据。
- 当前工作树已有 `AGENTS.md`、房间样式、游戏逻辑和插件/UI 测试的未提交修改；仅暂存本任务改动，尤其对 `AGENTS.md` 只暂存本任务的速度上限 hunk。

## Review Focus

- 房主离开/迁移、淘汰但仍留房时，当前 `hostId` 权限仍正确；用 Match 意图测试覆盖。
- `4.0` 上限需贯穿协议、SDK 时钟与客户端 runner；新增边界值和 `b.speed` 测试。
- 快速拖动只提交最终值，显示最终跟随服务端确认；新增 HUD 测试覆盖拖动、键盘、拒绝回退。
- 阶段切换及安全检查点恢复沿用同一 Match 的选值，新 Match 为 `2.0`；新增 Match 和恢复测试。
- 窄视口、暂停、观战以及房间无当前可见字段时 HUD 不得遮挡顶栏或提供未授权操作；新增 HUD/CSS 布局回归和本机浏览器检查。

---

### Task 1: 服务端房主意图与 Match 速度生命周期

**Files:**
- Modify: `shared/protocol.js`
- Modify: `server/match/match/intents.js`
- Modify: `server/match/match/combatClock.js`
- Modify: `server/match/snapshot.js`
- Test: `test/match/combat-speed.test.js` (new)
- Test: `test/match/snapshot.test.js`

**Interfaces:**
- Consumes: existing `MatchCombatClock.setSpeed(speed)`, `hostId`, and `b.speed` broadcast.
- Produces: C2S `g.speed { speed }`; `MatchIntents.setCombatSpeed(ps, speed)` accepts only the current non-bot, non-left host during an active, unpaused battle. It applies the speed through the combat clock and updates `defaultGameSpeed` only on success.

- [ ] **Step 1: Write failing server tests**

  Add cases to `test/match/combat-speed.test.js` proving `validateC2S` accepts `0.1`, `2.0`, and `4.0`, and rejects values below/above range, non-finite values, and values not on a `0.1` step. Exercise `g.speed` from the current host, non-host, eliminated-but-present host, departed former host after migration, active combat, preparation, and paused states. Assert success updates `gameSpeed`, `defaultGameSpeed`, and broadcasts `b.speed`; rejected requests do not change them.

  Add a checkpoint case in `test/match/snapshot.test.js`: a safe checkpoint with a host-selected `gameSpeed` restores that value as the Match's next-phase default; an otherwise fresh Match starts at `2.0`.

- [ ] **Step 2: Run the focused tests and confirm expected failures**

  Run: `node --test test/match/combat-speed.test.js test/match/snapshot.test.js`

  Expected: the new C2S/intent and restored-default assertions fail because `g.speed` and cross-phase restoration are not implemented yet.

- [ ] **Step 3: Implement the protocol and server path**

  Add `g.speed` with numeric protocol bounds, route it through `_handle`, and add `MatchIntents.setCombatSpeed(ps, speed)` with current-host, non-bot/non-left, active-phase, pause/freeze, and `0.1`-step checks. Extend `MatchCombatClock.setSpeed()` validation from `3.0` to `4.0` without changing plugin-clock phase-reset behavior. On an authorized host request that succeeds, set `defaultGameSpeed` to the selected value so later phases in this Match inherit it.

  In `restoreMatch`, after restoring Match scalars, restore `defaultGameSpeed` from the checkpoint's `gameSpeed`; leave the default initialized by the constructor when an old checkpoint omits that field. Do not add a snapshot field.

- [ ] **Step 4: Re-run server tests and confirm they pass**

  Run: `node --test test/match/combat-speed.test.js test/match/snapshot.test.js`

  Expected: host/phase/range/broadcast/checkpoint assertions pass; existing snapshot assertions remain green.

- [ ] **Step 5: Commit the server task**

  Stage only `shared/protocol.js`, `server/match/match/intents.js`, `server/match/match/combatClock.js`, `server/match/snapshot.js`, and the two named test files. Commit as `feat: add host combat speed intent`.

### Task 2: 客户端上限与战斗 HUD 滑条

**Files:**
- Modify: `public/js/battle/runner.js`
- Modify: `public/js/ui/gameActions.js`
- Modify: `public/js/ui/hud.js`
- Modify: `public/js/screens/game.js`
- Modify: `public/css/screens/game.css`
- Modify: `public/i18n/en.json`, `public/i18n/ja.json`, `public/i18n/ko.json`, `public/i18n/zh-TW.json`
- Test: `test/match/runner.test.js`
- Test: `test/ui/combat-speed.test.js`

**Interfaces:**
- Consumes: `g.speed { speed }`, `room.hostId === me.playerId`, the active `field.speed` / battle speed, and existing `b.start` / `b.speed` updates.
- Produces: a top-bar speed control showing the confirmed value to everyone; only the current host can interact. `actions.speed(speed)` sends the final selection.

- [ ] **Step 1: Write failing runner and HUD tests**

  Extend `test/match/runner.test.js` to prove a current-phase `b.speed` value of `4.0` rebases the live field and a value above `4.0` is ignored. Add `test/ui/combat-speed.test.js` assertions that the top-bar range is `min="0.1"`, `max="4"`, `step="0.1"`; it is operable only for the host during active combat, remains read-only for other players, commits after pointer/keyboard interaction ends, and returns to the confirmed value after rejection or a newer server update. Check the current top-bar CSS at a narrow viewport for no overlap.

- [ ] **Step 2: Run the focused tests and confirm expected failures**

  Run: `node --test test/match/runner.test.js test/ui/combat-speed.test.js`

  Expected: the 4.0 runner case and new HUD assertions fail before implementation.

- [ ] **Step 3: Implement client propagation and the control**

  Raise `public/js/battle/runner.js`'s `b.speed` upper bound to `4.0`. Add `actions.speed(speed)` in `gameActions.js`. Add a small range control to `TopBar` and pass its confirmed speed, active-combat state, and submission callback from `game.js`; show it only during an active combat phase, disable editing for non-hosts/paused states, and keep the draft local until pointer release, keyboard interaction end, or blur. Let the latest server speed update replace the draft. Keep layout within existing top-bar regions and add only the CSS needed for compact desktop/mobile display.

  Add the localized “战斗速度” UI label to the four existing UI dictionaries in `public/i18n/`; use the standard `t()` lookup and do not modify generated `data/i18n/` game data.

- [ ] **Step 4: Re-run focused tests and confirm they pass**

  Run: `node --test test/match/runner.test.js test/ui/combat-speed.test.js`

  Expected: 4.0 messages update the runner; invalid/stale updates remain ignored; host and non-host controls match the spec.

- [ ] **Step 5: Commit the client task**

  Stage only the listed client/CSS/translation/test files. Commit as `feat: add host combat speed slider`.

### Task 3: 移除本机插件并同步仓库约定

**Files:**
- Delete: local ignored package `plugins/combat-speed/` (inspect and unlink package entries without following links outside the package)
- Modify: `AGENTS.md` speed contract only, changing `0.1`–`3.0` to `0.1`–`4.0`

**Interfaces:**
- Consumes: updated built-in speed control and server range.
- Produces: no local `combat-speed` package; generic `clock.speed` / `sp.clock.onPhase` and other plugins remain intact.

- [ ] **Step 1: Verify the plugin paths before removal**

  Inspect `plugins/combat-speed` and each reparse/link target. Confirm the resolved target stays inside this package before removal; remove only the `combat-speed` package entries and preserve `plugins/life-rescue`, audio, and any target outside this package.

- [ ] **Step 2: Remove the package and update the speed contract**

  Delete the local `plugins/combat-speed` package. Change only the combat-speed SDK contract line in `AGENTS.md` to `0.1`–`4.0`; preserve the existing uncommitted room-layout edit in that file.

- [ ] **Step 3: Verify the local package cleanup and scoped diff**

  Run the strict plugin check for `life-rescue`; confirm `plugins/combat-speed/` is absent and `plugins/life-rescue/` remains. Inspect the staged diff to confirm no generated plugin index, unrelated plugin, or pre-existing edit was staged. The live `/plugins/index.json` check runs after the server restart in Task 4.

- [ ] **Step 4: Commit the scoped repository rule**

  Stage only the speed-contract hunk from `AGENTS.md` (not its existing room-layout hunk). Commit as `docs: align combat speed range with host control`. The ignored package deletion is a local runtime cleanup and will not appear in Git history.

### Task 4: 集成验证与浏览器联调

**Files:**
- Test: all changed tests and full repository suite
- Build: Vite production build
- Runtime: local server and browser sessions

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: recorded automated test/build and live browser results for host, guest, speed propagation, new Match reset, and plugin list.

- [ ] **Step 1: Run focused and existing local-update tests**

  Run the new combat-speed tests plus `test/ui/room-mobile.test.js` and `test/ui/life-rescue.test.js` (these files already have unrelated uncommitted local edits and must remain untouched by this task). Confirm all pass or record any unrelated existing failure by exact test name.

- [ ] **Step 2: Run the full suite and build**

  Run: `npm test`

  Run: `npm run build`

  Expected: report full output and the actual exit code for each. Do not treat a timeout or partial output as success. Confirm `git diff --check` and verify generated build output is not staged.

- [ ] **Step 3: Rebuild/restart and verify the live browser behavior**

  Restart the local app with its authorized sandbox plugin setting. In two local browser sessions, create/join a room, start combat, set the host slider to `4.0`, verify both views receive the same confirmed speed and the guest control is read-only, complete a phase and verify the next phase retains the value, then create a new Match and verify `2.0`. Confirm the plugin list has no `combat-speed` and still has `life-rescue` and audio. Record viewport size and any console/runtime errors.

- [ ] **Step 4: Review final Git scope**

  Confirm only this feature's code/tests/docs are committed, all pre-existing uncommitted room, plugin, and UI changes remain present and unstaged, and the local ignored speed plugin package is absent.
