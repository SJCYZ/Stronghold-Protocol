# 游戏登录鉴权与单局访客分享实施计划

建议执行方式：使用 `superpowers:subagent-driven-development`。项目 `AGENTS.md` 明确要求用 GPT-6 Luna 子代理分工；先锁定两仓共享协议，再分别处理 WGS、Stronghold 服务端与界面，避免两端并行各自定义接口。

## Goal

登录与游玩入口只接受两类身份：由 Web Gerber Share Station（WGS）一次性 SSO 授权建立的账号会话，或由已登录玩家分享、严格绑定到一个 Stronghold 房间和一局的访客会话。继续支持本局访客断线重连；游戏结束、取消、房间关闭后，访客凭证不能再次使用。

## Architecture

- WGS 继续负责账号密码、MFA、登录 Cookie 和账号状态。Stronghold 不提供注册、不接收密码；WGS 通过预登记 client、精确回调地址、state、PKCE 和服务端 client secret 发放一次性授权码。授权码摘要存 Redis，60 秒过期且只能兑换一次。
- WGS 提供游戏专用授权、服务端兑换、服务端核验接口。接口复用现有 WGS 会话与账号记录；只检查账号有效、未封禁/删除、邮箱已验证、QQ 已绑定，明确绕开全站 SMTP 初始化门槛。
- Stronghold SSO 回调由服务端兑换授权码，并将 WGS subject、auth_version 与不超过原 WGS 登录会话寿命的服务端 SSO 会话引用写入 Stronghold 账号 Session。浏览器只拿 Stronghold 自身的一次性登录票据及本地重连令牌。
- WGS 授权码、Stronghold 登录票据和访客票据均短时、一次性且绑定原始流程；WGS 会话引用、client secret 和访客码摘要不发送给浏览器。
- 房间分享码是独立的 128 位随机秘密，不复用四字符房间定位码。服务端只保存摘要、房间 ID 和下一局 generation。访客在开局前通过 POST 兑换，可多人使用同一码；兑换产生各自一次性 Stronghold 访客票据，首个有效 hello 消耗票据并加入该码绑定的房间。
- 对局开始时，房间 generation 固定；关闭首次分享码兑换，只保留已加入访客各自的本地重连令牌。对局结束、取消、替换或房间关闭时撤销分享码、访客 Session 和未消费访客票据。
- Stronghold 服务端在身份创建、WS hello、账号重连及创建/加入/匹配/观战等权限边界做授权。客户端按钮、昵称、旧匿名 token 和四字符房间码都不构成身份凭据。

## Tech Stack

沿用现有技术栈：Stronghold Node.js/ESM、WebSocket、现有 Redis 快照；WGS FastAPI、SQLAlchemy、Redis、现有 `gs_session` Cookie 和 Vue 登录页。无需引入新的身份服务或第三方库。

## Spec

[游戏登录鉴权与单局访客分享设计](../specs/2026-10-21-game-auth-sso-design.md)

## Global Constraints

- 当前写入授权仅覆盖 Stronghold；WGS 项目在本阶段只读。进入 WGS 实施前，应先将其纳入可写工作区并使用该项目自己的 Git 分支；未获工作区写入授权前不修改 WGS。
- 所有客户端与文档新增内容使用中文；维护现有语言包约定，不改无关 UI、游戏规则或账号注册流程。
- 任何 redirect URI 都必须是服务端预登记的精确值；SSO 交易校验 state 与 PKCE；一次性凭证须原子消费，错误/过期/重放均拒绝。
- 账号权限以 WGS 当前数据库状态为准；不能用用户可控的 subject、昵称、客户端标记或旧 token 代替核验。SMTP 初始化状态不得进入游戏资格判断。
- 访客范围由服务端票据和 Session 绑定；客端传入的 room、generation 或身份字段不得扩大范围。访客不能创建房间、发起/加入匹配队列、加入其他房间或旁观。
- WGS 不可用时，新账号登录、账号重连和账号的新局边界操作失败关闭；已经运行中的 WS 不因之后停用账号而被强制中断。访客本局重连不依赖 WGS。
- 升级前缺少身份类型的匿名 Session 一律拒绝，不推断身份或迁移权限；按已确认方案，这可能导致旧匿名对局不能续玩。
- 不查看、输出、记录或提交真实密码、Cookie、会话引用、client secret、授权码、分享码或访客/登录票据。提交仅包含本计划及后续经审阅的本功能改动；不碰主工作树现有的 `AGENTS.md` 修改。

## Implementation Tasks

### 1. 固定并记录 SSO HTTP 协议与部署配置

- 明确 WGS client 注册配置、精确 Stronghold callback、Stronghold 出站地址/超时、Redis key/TTL 和错误响应。
- 文档化接口：
  - WGS 浏览器入口：`GET /api/v1/game-sso/authorize`，接受登记的 client、回调、state、S256 challenge。
  - WGS 服务端兑换：`POST /api/v1/game-sso/token`，验证 client secret、callback、PKCE，并原子消费 60 秒授权码。
  - WGS 服务端核验：`POST /api/v1/game-sso/introspect`，检查原 WGS 会话仍有效及账号当前资格，返回 subject/auth_version/有效期。
  - Stronghold 登录入口/回调：`GET /auth/wgs/start`、`GET /auth/wgs/callback`；回调兑换成功后生成 60 秒过期的 Stronghold 登录票据，并以 fragment 返回标题页。
  - Stronghold 访客兑换：`POST /auth/guest/redeem`，分享秘密只走请求正文，返回短时 Stronghold 访客票据。
- WGS 未登录时将浏览器引导到现有 `/auth` 登录页；登录成功后只允许返回同源且仍经过 WGS allowlist 校验的原授权请求。
- 将 client 列表/secret、Stronghold WGS 地址与 secret 加入现有服务端配置和部署文档；样例仅用占位值。

涉及：Stronghold `server/index.js`、`server/http/routes.js`、`docs/DEPLOY.md`；WGS `backend/app/config.py`、`backend/app/main.py`、部署配置说明，以及新增 `docs/GAME_SSO.md`（若 WGS 文档目录已有对应安全/部署文档则沿用现有位置）。

完成条件：两端路径、请求字段、状态码、时限和配置名完全一致；秘密只存在于服务端配置。

### 2. 在 WGS 增加游戏专用 SSO 提供方

- 新增小型 SSO 模块管理 client allowlist、授权码摘要、票据原子兑换和 opaque session reference。
- 新增游戏资格依赖：基于 `get_current_user`，检查有效、未封禁/删除、邮箱已验证及 QQ 已绑定；不调用 `require_shell_user`，因此 SMTP 全站初始化状态不阻断游戏 SSO。
- 授权入口验证已登录会话及回调登记；未登录时返回现有登录页并保存安全的授权续接路径；授权后只向登记回调重定向一次性 code 与原 state。
- token 兑换要求 client 认证与 PKCE verifier 匹配；授权码同时绑定 client、callback、WGS 会话和 auth_version，使用 Redis 原子消费。
- introspect 只允许登记 client 调用，检查 opaque 引用所绑定的 WGS 会话仍在 Redis、auth_version 未变且账号仍满足资格。响应不包含 WGS Cookie/token。
- 仅对现有登录页增加安全续接 `next` 行为，正常登录、注册和 MFA 流程保持原行为。

涉及：新增 `backend/app/game_sso.py`，修改 `backend/app/main.py`、`backend/app/dependencies.py`、`backend/app/config.py`、`frontend/src/pages/AuthPage.vue`；若登录请求封装需要调整，再修改 `frontend/src/lib/api.ts`。

完成条件：不符合资格的账号无法授权或核验；SMTP pending 不影响符合资格账号；错误 client/callback/state/PKCE、过期或重复 code 均失败关闭。

### 3. 在 Stronghold 建立账号与访客会话凭据

- 新增 WGS SSO 客户端模块，生成 state/PKCE，短时保存事务，限制重定向及网络超时；仅后端调用 token/introspect。
- 用服务端保存的一次性 Stronghold 登录票据将回调身份传到首次 hello；票据只含/引用已核验的账号身份，不把 WGS session reference 交给浏览器。
- 新增访客兑换服务：在请求正文接收分享码，检查房间仍开放、未开局、generation 一致及速率限制；同一有效分享码可产生多个彼此独立的访客票据。票据 60 秒过期、一次性、绑定 invite ID/room ID/目标 generation。
- 扩展 `Session` 身份为 account/guest；新 hello 必须消费有效登录票据、访客票据，或携带已知且具有身份范围的本地重连 token。空身份 hello、随机 token、升级前匿名 token 都拒绝。
- account Session 保存服务端 WGS opaque 引用/auth_version；guest Session 保存 invite ID、room ID、match generation。两类 Session 使用互不混淆的 Stronghold 本地重连 token。

涉及：新增 `server/auth/wgsSso.js`（或在现有 HTTP 结构内放置等职责模块），修改 `server/net.js`、`server/index.js`、`server/http/routes.js`。

完成条件：身份只由服务端消费的一次性票据或已有强范围 Session 建立；客户端提供的身份字段不起授权作用。

### 4. 在 Lobby 入口实施房间与单局权限

- 账号 Session 沿用当前已授权房间、创建/匹配/观战能力；账号在重连及新局权限边界重新 introspect，WGS 故障时拒绝相关操作。
- 账号玩家在所属房间且未开局时可创建/更新该房间下一局的分享码；原四字符房间码继续只用于定位。
- guest ticket 首次 hello 消耗后，由 Lobby 按票据范围进入指定房间，不接受客户端传入的其他房间号。访客不能发起匹配队列、创建房间、旁观或替账号创建/启动后续对局；房内准备、聊天及当前局游戏操作沿用现有成员规则。
- 分享码在比赛开始的串行边界关闭新兑换，并将已加入访客绑定到唯一 generation。只有这批访客可在该场活动期间以各自 token 重连。
- 在 match finish/cancel/replace、room close 和失效清理路径中撤销邀请和 guest Session；连接中的访客可收到当前局最终结果，但不得恢复或进入下一局。

涉及：`server/lobby.js`（房间命令授权、邀请创建、开局/结束/房间关闭生命周期）；必要时调整 `server/net.js` 的身份创建钩子。房间状态向客户端仅广播邀请是否可用，不广播摘要或秘密。

完成条件：所有 HTTP/WS/房间与队列入口都由服务端同一身份规则限制；不依靠前端隐藏按钮。

### 5. 将最小身份范围纳入 Redis 恢复

- `server/persist.js` 的 Session 文档保存 account/guest 类型和最小服务端范围；不保存一次性登录/访客票据。
- 房间持久化保存邀请码摘要、失效状态、目标/活动 generation。旧文档缺少身份类型时 Session 不予恢复；不按原 playerId、token、nickname 或房间席位补身份。
- 恢复时校验账号/访客重连窗口和房间 generation；过期、已结束或替换的 guest Session 清理，不将旧邀请挂到新局。仅有效账号引用在后续账号权限边界调用 WGS 核验。
- 保留当前 Redis snapshot 格式的其余字段、TTL 和检查点行为。

涉及：`server/persist.js`、`server/lobby.js` 及其 room/session 文档映射。

完成条件：重启后有效账号和本局访客仅恢复原范围；旧匿名会话和旧局访客不能获得权限。

### 6. 接入标题页、房间邀请与语言资源

- 标题页提供 WGS 登录、分享码/分享链接进入；登录及访客都以 Stronghold 本地重连 token 参加 hello，回调只把 Stronghold 登录票据经 fragment 交给页面，读取后立即移除 fragment。
- 邀请链接将分享秘密放在 URL fragment，前端读取后调用 POST 兑换并清除 fragment；不要将秘密放 query、访问日志、复制以外的持久化或分析事件。
- 房间仅向有账号身份的玩家显示“生成/复制本局分享码”；区分原房间定位码与一次性局邀请。
- 按仓库语言资源来源维护新增 UI 文案，不改已有缩放/布局规则。
- 前端的拒绝/过期状态显示明确登录或获取新分享码的提示；服务器仍执行全部权限判断。

涉及：`public/js/net.js`、`public/js/screens/title.js`、`public/js/screens/room.js`、`data/i18n/*.json`。若这些语言文件由其他源码生成，按仓库现有生成路径维护源文件，不直接覆盖构建产物。

完成条件：账号和访客入口可用，分享秘密在页面处理后从地址栏移除，老匿名 token 显示重新登录/获取新码提示。

## Global Constraints for Review

- **身份伪造**：客户端传入 user ID、昵称、普通 token 或 room ID 不能成为账号身份或扩大访客范围；WGS 返回的 auth_version 和会话引用来自服务端核验。
- **单次性和重放**：SSO code、登录票据、访客票据有 TTL、绑定上下文且原子消费；分享码只可在指定房间的指定局开局前兑换。
- **边界完整**：逐个复核 hello/reconnect、room create/join/watch/start、match join、房间关闭和 Match finish/cancel/replace；guest 不可滑入下一个 generation。
- **停用语义**：账号新建/重连/新局操作受实时 WGS 核验；SMTP pending 被排除；当前活动 WS 不被事后封禁强制断开。
- **恢复语义**：Redis 重启路径不延长邀请码或访客会话有效期，不恢复升级前匿名身份，不让旧局清理影响同房间的新 generation。

## Review Focus

本计划先按下列行为审阅，避免把实现扩展到未批准范围：

1. 有效账号条件严格为已绑定、邮箱已验证、有效且未封禁；不受 SMTP 初始化状态影响。
2. 登录 code 和本地 ticket 有短 TTL、固定回调、state/PKCE 校验和一次消费。
3. 同一个分享码允许多位队友在开局前进入；开局后不再发新访客票据，只有已加入者可在本局重连。
4. 对局结束、取消、替换或房间关闭后，guest 不能以旧票据或重连 token进入任何后续对局。
5. 旧匿名 Session 不迁移；WGS 故障时账号新登录/重连/新局边界失败关闭，而当前活动 WS 保持现状。

## Out of Scope

- WGS 注册、密码/MFA、SMTP 流程及后台管理权限变更。
- Stronghold 游戏规则、现有房间码语义、生产部署和线上会话的手工迁移。
- 游客跨局身份、好友系统、跨项目账号密码同步、第三方 OAuth provider 或社交账号等级。
