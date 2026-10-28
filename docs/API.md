# HTTP 接口协议

基础路径为 `/api/v1`。本文维护共用规则与浏览器私有协议；应用令牌接口的参数、响应、权限和 operationId 以 [OpenAPI](../backend/internal/httpapi/openapi.json) 为唯一契约，接入流程见 [APPLICATION_API](APPLICATION_API.md)。不在这里复制完整应用路由表。

## 认证与身份

- 浏览器使用 HttpOnly／Secure／SameSite Cookie；修改请求必须通过来源校验并携带 `X-CSRF-Token`。
- Access Token 使用 `Authorization: Bearer`；存在无效 Authorization 时不回退 Cookie，不授予账号管理、私有分享或永久清理权限。
- 公开文档、健康检查、公开分享有各自边界；文档可读不等于获准调用业务。HEAD 沿用对应 GET 的授权，SSE 除外。
- 页面固定首次认证的 `workspaceId`，以 `X-Folio-Workspace` 或文件 URL 的 `workspace` 传递；它不是凭据或文件版本。身份变化返回 `409 workspace_changed`，停止写入并保留草稿，不自动采用新身份重试。
- 响应使用 `Cache-Control: no-store`。JSON 错误为 `{error:{code,message,details}}`，以状态和 code 分支，不以中文 message 分支，不暴露绝对路径。

## 路径、正文与条件写入

- 路径为 UTF-8 工作区相对路径。定位已有条目的 `path` 在 query，新建文件／目录的 `path` 在 JSON body，不互相回退。查询参数 URL 编码，JSON 路径不预编码。
- 必需路径缺失／空值返回 `400 path_missing`，`details.expected` 为 `query:path` 或 `body:path`；body null 同样缺少有效字符串，类型错误是 `invalid_request`。真正非法路径才是 `path_invalid`。列目录的可选 path 与上传 directory 可为空表示根目录。
- 认证／权限／CSRF 先于参数检查；必需 query path 先于正文与版本校验。修正参数位置不能绕过 If-Match。
- 创建／保存必须显式提供字符串 `content`；空字符串是合法空正文，缺失／null 不得创建或清空文件。
- `revision` 为不透明值；响应头 ETag 包含双引号，JSON revision 不包含。更新、移动、回收使用读取时完整强 `If-Match`，拒绝裸值、弱 ETag 和星号；新建不覆盖同名目标。
- PUT 为完整替换，不是追加。按行响应仍携带**完整文件版本**；必须检查 `isPartial`，不能把片段 PUT 成整篇。跨段读取固定首段 ETag，行号和 diff 坐标均按完整文件计算。
- PATCH 是严格单文件 unified diff：核对版本、位置、上下文和换行，不模糊应用、不部分提交。dryRun 不保存、不预留版本或配额；无变化结果不重新落盘。格式与字段见单操作契约。
- 正文保留 BOM、LF／CRLF／CR 与未修改字节。下载／预览是字节流，支持 HEAD／Range；416 或底层错误可能是 text/plain，先检查状态与 Content-Type。日期 If-Range 不能替代正文强版本。

## 错误与恢复

| 状态／代码 | 客户端行为 |
| --- | --- |
| 400 `path_missing` | 按 details.expected 补值或修正位置，不猜路径转义来绕过 |
| 400 `path_invalid`／`invalid_request`／`invalid_patch` | 核对路径、类型或补丁语法，不降级为无条件覆盖 |
| 401／403 | 核对认证、到期、撤销与权限，不自动提权或回退凭据 |
| 404 `not_found`／`trash_not_found` | 刷新路径／回收列表；不将不存在解释为损坏 |
| 409 `target_exists`／`patch_mismatch`／`file_changed` | 保留候选并核对目标或原文；外部移动不按名称猜测追踪 |
| 409 `workspace_changed` | 停止写入，确认工作区及恢复命名空间 |
| 412／428 | 保留候选，重读比较或补原版本；禁止换新 ETag 重发旧候选 |
| 413／415 | 核对实际限额、配额和类型，保留草稿／上传原件 |
| 422 `trash_damaged` | 保留恢复记录／副本，检查损坏，不自动清理 |
| 429 | 遵守 Retry-After，重试有次数与时间上限 |
| 500 `durability_uncertain`／`trash_incomplete` | 可能已提交，先核对文件与恢复记录，不能盲重试 |
| 503／网络结果未知 | 明确失败或待确认；索引故障不意味着正文保存失败 |

`details.currentRevision` 仅在确有非空当前版本时附带。恢复成功通常清理记录，之后为 `trash_not_found`；仍可读取的旧 restored 记录可返回 `already_restored`，均不等于损坏。

## 浏览器账号与系统接口

下列私有接口不向应用令牌开放。请求／响应为 JSON，修改沿用 Cookie、来源及 CSRF 保护。

| 方法／路径 | 请求或主要响应 |
| --- | --- |
| POST `/auth/login` | `{username,password}` → `{id,username,admin,csrfToken,workspaceId}` 并设置 Cookie |
| GET `/auth/me` | 当前浏览器账号、CSRF 与工作区身份 |
| POST `/auth/logout` | 撤销当前会话，`{ok:true}` |
| POST `/auth/password` | `{oldPassword,newPassword}`；成功撤销本账号会话／令牌并清当前 Cookie |
| GET `/admin/users?q=&offset=&limit=` | 管理员分页搜索，`{entries,total,offset,limit}` |
| POST `/admin/users` | `{username,password,enabled,quota}`，201 用户元数据 |
| PATCH `/admin/users/{id}` | `{username,enabled,quota,password:""}`，不授予管理员角色 |
| POST `/admin/users/{id}/password` | `{password}`，独立重置，撤销指定账号会话／令牌 |
| GET／PUT `/admin/settings` | `{limits:{Text,Image,PDF,Attachment,ImagePixels},indexLimit}` |
| GET `/admin/status` | Go／平台、uptime、CPU、Goroutines、已打开工作区及内存／GC 指标 |
| GET `/admin/disk` | 显式统计 workspace／appData 的字节、条目及卷容量 |
| GET／POST `/user/tokens` | 列出本人元数据／生成令牌；完整 token 仅生成响应一次返回 |
| DELETE `/user/tokens/{id}` | 删除本人令牌，其他账号或不存在均 404 |
| DELETE `/trash/{id}` | 永久删除本人的完整 ready 记录；残缺／损坏记录拒绝清理 |

用户名为 1–64 位 ASCII 字母／数字／下划线／点／短横线，首字符为字母或数字，大小写不敏感唯一。账号密码为 8–1024 UTF-8 字节，各建号／改密／离线入口一致。quota 为 0–2^50 字节整数，0 是零额度。首个管理员不可禁用，不提供删除账号、角色提升或管理员浏览他人正文入口。

令牌创建为 `{name,expiresAt,permissions:{files,search,trash}}`；name 去首尾空白后 1–80 字符，权限 none/read/write 至少一项非 none，每账号最多 100 条（含过期记录）。时间为 Unix 秒，expiresAt=0 永久，否则在未来且不超过 366 天。元数据包含前缀、创建／最近使用／到期及权限，不返回摘要或完整值；lastUsedAt=0 表示未使用，更新时间最多每分钟落库一次。

管理员限额：文本／索引 1 字节–100 MiB，附件最大 1 GiB，图片／PDF 不高于附件，像素最多 10 亿；保存持久化后在线生效。在途操作可能按开始快照完成。状态内存不是 RSS，磁盘逻辑大小不是占块／配额，同卷容量不能相加；磁盘统计失败明确报错，不当作零。

## 工作区 SSE

`GET /workspace/events?workspace=<身份>` 只接受同账号浏览器 Cookie，拒绝 Bearer，检查来源及工作区；不在应用 OpenAPI 中。响应 `text/event-stream`、no-store、`X-Accel-Buffering:no`，HEAD 为 405。

| event | JSON data／含义 |
| --- | --- |
| `resync` | `{reset:true}`，每次连接要求完整核对 |
| `change` | `{paths:[相对路径],source?:{name}}` 或 `{reset:true}`，只提示重新读取 |
| `auth` | `{}`，会话失效，客户端重新核对认证并停止流 |

每账号最多 4 条连接；每连接有界队列，慢连接合并 reset。15 秒心跳及每次变更前重新认证，重连提示 retry:2000。不发送正文或版本，不提供 Last-Event-ID 重放；source 仅来自可信 Token 名称，不是精确版本作者或审计记录。

宿主写入不产生 SSE，客户端仍保留焦点／重连／可见时及定期版本核对。服务关闭终止连接，代理须允许流式传输。通知展示与接受／等待／条件回滚见 [DESIGN](DESIGN.md#远程更新与差异)，一致性实现见 [ARCHITECTURE](ARCHITECTURE.md)。

## 分享私有与公开协议

管理／转存使用账号 Cookie、CSRF 与工作区保护；公开读取使用独立访客资格，不接受任意工作区 path。新分享为 16 字符 Base64URL ID，兼容旧 48 字符十六进制 ID。所有分享响应 no-store，公开页面／接口 noindex、nofollow、noarchive，Referrer-Policy 为 no-referrer。

| 方法／路径 | 行为 |
| --- | --- |
| GET `/shares?offset=&limit=` | 本人记录，默认 20、最多 50／页，返回分页结构 |
| POST `/shares/analyze` | `{root,include}`，递归返回候选与警告，等待显式确认 |
| POST `/shares` | 创建确认清单及访问限制，201 分享记录 |
| PUT `/shares/{id}` | 携带最新 version 更新本人设置／清单，不重置已用次数 |
| DELETE `/shares/{id}` | 先暂停，再清理快照及记录；失败保留可重试记录 |
| POST `/shares/{id}/import` | `{file,directory}`，转存至本人的新目录，201 `{path}` |
| GET `/public/shares/{id}` | 仅返回是否受密码保护，不泄露正文／清单 |
| POST `/public/shares/{id}/enter` | `{password}`，验证、计次并设置访客 Cookie |
| GET `/public/shares/{id}/manifest` | 有资格时读取确认清单 |
| GET `/public/shares/{id}/files/{file}/metadata` | 清单内文件的安全类型与元数据 |
| GET `/public/shares/{id}/files/{file}/content` | 文本 `{metadata,content,html}`，html 是只读派生内容 |
| GET `/public/shares/{id}/files/{file}/preview` | 安全位图／PDF，支持 Range |
| GET `/public/shares/{id}/files/{file}/download` | 原件下载，支持 Range |

创建／更新字段为 root、title、mode（snapshot/live）、files（`{path,revision}` 数组）、expiresAt（0 永久）、maxVisits（0 不限，最多 1000000）、password（可选六位数字）、disabled。更新另需 version；密码省略保留，空字符串移除。files 省略只改访问设置，提供则重新验证递归可达清单及文件版本；root／mode 不可改，主文件不能移除，实时只允许主文件。

新清单或访问设置变化使旧访客资格失效。成功进入计一次，同浏览器资格 30 分钟内刷新不重复计次，HEAD 不计次；公开访客资格有界，容量不足返回 429，不扣次数。暂停／过期／次数用尽／来源身份变化为 410；已过期记录可能清理为 404，不可续期复活。分享者禁用后拒绝读取；离线改密不自动撤销公开分享，应在管理中暂停。

文件版本不符为 412，管理 version 陈旧为 409；清单外文件或不存在为 404。HTML／SVG 不活动预览，未知原件仅下载。转存不覆盖，结果不确定时核对目标目录。产品限制见 [SPEC](SPEC.md#安全分享与账号边界)，存储和配额计费见 [ARCHITECTURE](ARCHITECTURE.md)。
