# 任务 2 实施报告

- RED：初次状态回归确认 pending roster 与 PlayerState 标记缺失；补充真实 `settle()` + SDK 注册测试后，20 秒断言失败，揭示 Match 误读 `offerRescue` 参数（单目标而非 `targetIds`）。
- GREEN：Match 现在处理 SDK 的目标数组和时限字段，仅接受恰为 20 秒的有效请求；实现真人付款资格检查、插件回调内原子扣款/复活、超时清理、intent 校验、公开视图、安全检查点字段及审计约束。
- 验证：指定命令 `node --test test/match/life-rescue.test.js test/match/snapshot.test.js test/match/life-rescue-host.test.js` 最终 21 项全部通过。覆盖真实 SDK 回调开窗、无合格者 3 秒回退、缩短时限被拒、同目标竞争，以及临时脚本插件经 Match Worker 创建、扣款和复活。
- 文件：Match、PlayerState、snapshot、protocol、audit/invariants 及 Match/host 救援回归用例与临时 Worker Match fixture。
- 限制：未实现 UI、正式插件包或 SDK 文档；Worker 测试的目标生命状态由测试专用 Match fixture 驱动。
