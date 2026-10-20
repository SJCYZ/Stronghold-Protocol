# 房主手动调速

房间插件 ID：`combat-speed`。

房主在房间插件面板选入后，战斗 HUD 才会显示手动速度滑条。速度范围为 0.1–4.0，步进 0.1；更改由服务端广播，并在当前房间的整场对局中沿用。新对局仍从 2.0 倍开始。

服务器须启用脚本沙箱，并且房间选择此插件。插件仅注册 SDK 战斗时钟，不设置自动曲线；房主调速使用游戏原生滑条和服务端权限校验。

验证：`node tools/plugin.mjs check combat-speed --strict`、`node tools/plugin.mjs test combat-speed`、`node tools/plugin.mjs pack combat-speed --zip`。
