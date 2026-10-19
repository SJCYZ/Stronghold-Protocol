# Task 4 实施报告：life-rescue 插件与 SDK 文档

## 状态

已完成并提交实现：`8ddf21c8`（`feat: 添加生命救援脚本插件`）。

## RED / GREEN

RED：先新增 `test/plugins/life-rescue-script.test.js`，再运行计划测试。三个断言按预期失败：manifest 不存在、插件入口不存在。失败不是导入错误或测试环境问题。

```text
node --test test/plugins/life-rescue-script.test.js
tests 3
pass 0
fail 3
```

GREEN：实现后，插件行为的两项检查先通过；默认设置断言发现 manifest 还含有合法的中英文 label。将断言收窄为测试必需的 `type/min/max/default` 字段后，按计划重跑：

```text
node tools/plugin.mjs surface --write
wrote docs/PLUGIN-API.md

node tools/plugin.mjs check life-rescue
1 folder(s): 0 problem(s), 0 warning(s)

node --test test/plugins/life-rescue-script.test.js
tests 3
pass 3
fail 0
```

## 改动

- 新增 `plugins/life-rescue/plugin.json`：脚本插件，`sim.code` 与 `match.life` 权限；`lifeCost` 为 1–100 整数，默认 10。
- 新增 `plugins/life-rescue/sim/index.js`：从 `sp.settings.lifeCost` 读取唯一配置；只在存在未救援待淘汰目标且有真人存活捐赠者付款后仍至少保留 1 LP 时登记 `{ cost, durationMs: 20_000, targetIds }`。确认回调只按要求先 `changeLife(rescuerId, -lifeCost)`，再 `revive(targetId, 1)`。
- 更新 `docs/PLUGINS.md`、`docs/design/match.md`，生成 `docs/PLUGIN-API.md`。
- 新增 `test/plugins/life-rescue-script.test.js`，覆盖权限/设置契约、捐赠者资格与确认操作。

## 边界

插件没有默认启用；仍由现有房间插件选择、内容锁定及同意流程控制。实际付款资格、截止时间、竞态和复活由 Match SDK 回调闭包再次验证，插件不处理客户端身份、支付校验或库存恢复。按任务要求未运行其他测试或完整套件；浏览器与部署行为不在本任务验证范围。
