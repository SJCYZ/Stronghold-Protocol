# 完整资源导入包

网站提供动态资源校验清单，不提供部署分包索引或批量 ZIP 下载。旧的 /data/resource-packs.json 和 /resource-packs/*.zip 地址统一返回 404；正常游戏资源仍由界面与对局按需请求并缓存。

在具备完整资源的本机生成单个浏览器可导入的 ZIP：

- node tools/fetch-assets.mjs --voice-all --add-only
- node tools/install-skins.mjs add-all
- node tools/asset-hashes.mjs
- npm run resource:package

生成路径为 artifacts/stronghold-resource-import-资源版本.zip。包覆盖当前服务器资源清单中的地图、人物、基础模型、已安装的全部皮肤、全语言语音、音效、音乐和官方技能特效等条目。资源包只写入清单中存在真实指纹且本地字节匹配的文件。

生成器会在写出最终 ZIP 前验证所有文件。遇到缺失文件、过期或合成指纹、单文件超过 24 MiB、资源数超过 50,000，或 ZIP 超过 2 GiB 时停止并报告原因，不覆盖已有同名包。生成的 ZIP 位于 Git 忽略目录，不会进入源码提交或游戏网站。

玩家通过资源管理器的“导入 ZIP”主动导入。导入逐文件校验路径、CRC、实际大小和 SHA-1，并且只接受当前服务器清单中的有效文件。部分包导入后可以继续导入其他 ZIP；资源管理器只报告清单与本机缓存的缺项，不会自动补下载。

完整的清单与导入行为见 ASSETS.md 的“Resource checklist and manual ZIP import”一节。