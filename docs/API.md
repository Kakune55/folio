# HTTP 接口协议

基础路径 /api/v1。除上传/下载流外使用 JSON。下表记录已实现接口；PATCH /settings 尚未实现，不作为客户端可调用能力。代码字段与协议名称保留英文。

## 通用约定

- 除登录、公开分享、静态资源与无内部信息的健康检查外，接口需要有效会话或明确获准的 Access Token（令牌路由白名单见末节）。登录与 me 返回 {id,username,admin,csrfToken,workspaceId}，登录请求为 {username:"admin",password:"..."}。
- 修改请求携带 X-CSRF-Token，并通过 Origin/Sec-Fetch-Site 校验。Cookie 为 HttpOnly、SameSite Strict，默认 Secure；API 使用 Cache-Control: no-store。
- 路径使用正确编码的工作区相对路径，不接受服务器绝对路径。元数据/文本使用 UTF-8，二进制传原始字节。
- revision 为不透明强版本；更新、移动、删除必须提供 If-Match: "<revision>"。缺少条件返回 428，陈旧版本返回 412。新建接口始终不覆盖，同名返回 409，无需 If-None-Match。
- 时间戳仅供参考，不是并发依据。列表仅按明确的分页/限额返回，不承诺外部变动中的一致快照。
- 错误形状：{"error":{"code":"revision_conflict","message":"中文说明","details":{}}}，不暴露绝对路径。

## 已实现路由

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| POST | /auth/login | 登录 |
| POST | /auth/logout | 撤销当前会话 |
| GET | /auth/me | 当前账号、CSRF 与工作区身份 |
| GET | /workspace/tree?path=&offset=&limit= | 列出目录直接子项 |
| GET | /files/metadata?path= | 文件分类与预览元数据 |
| GET | /files/revision?path= | 有限文本版本，不返回正文 |
| GET | /files/content?path= | 读取 UTF-8 正文与版本 |
| PUT | /files/content?path= | 条件更新现有文本 |
| POST | /files | 不覆盖地创建文本文件 |
| POST | /directories | 创建目录 |
| GET | /entries/revision?path= | 文件或完整子树版本 |
| PATCH | /entries/move | 条件重命名/移动 |
| DELETE | /entries?path= | 条件移入回收站 |
| GET | /trash?offset=&limit= | 回收记录 |
| POST | /trash/{id}/restore | 不覆盖地恢复 |
| POST | /uploads?directory=&image=false | 单文件流式上传 |
| GET | /files/download?path= | 认证原件下载 |
| GET | /files/preview?path= | 白名单安全预览 |
| GET | /search?q=&mode=&limit= | 名称/正文搜索 |
| GET | /search/status | 索引状态 |
| POST | /search/rebuild | 异步重建索引 |
| GET | /settings | 启动时文件限制 |
| GET | /healthz | 存活检查 |

离线密码恢复没有匿名 HTTP 入口，须停服后用同一二进制的离线命令执行。

## 文本读写与保存顺序

读取示例：GET /api/v1/files/content?path=Linux%2Fnotes.md。

```json
{"path":"Linux/notes.md","kind":"text","content":"# 笔记\n","encoding":"utf-8","revision":"sha256:opaque","size":9,"mtime":"2026-10-15T09:00:00Z"}
```

sha256:opaque 仅示意不透明值，客户端不能解析或自行生成版本。不要通过此接口解码再编码任意二进制。

PUT 使用 Content-Type: application/json、If-Match 与 CSRF 头：

```json
{"content":"# 更新\n","encoding":"utf-8"}
```

成功 200：{path,revision,savedAt}。读取后会话保存正文、基准版本与脏状态，同文件请求串行。成功响应只确认已发送快照；请求中继续输入则保持脏状态，并用新版本保存下一快照。412 保留正文、停止盲重试并比较/另存副本；网络错误保留草稿并提供显式重试，不能假装已保存。

GET /files/revision 返回 {path,revision} 及强 ETag，与正文版本一致；仅验证限额内普通 UTF-8 文本，不递归散列目录。缺失 404、非文本/目录 415、超限 413。探测失败不得推进基准版本，必须实际读取并协调正文。

## 目录、移动与回收

目录 path 默认空字符串，offset 默认 0，limit 默认 200、最大 1000；返回 {entries:[{name,path,kind,size}],total,offset,limit}，kind 为 directory 或 file，不安全条目不列出。

GET /entries/revision 返回 {path,kind,revision} 与强 ETag，文件摘要与文本版本一致。目录版本覆盖排序子树的名称、类型、目录权限和文件摘要；不安全子树明确失败，不部分忽略。

移动 JSON：{"from":"Linux/old.md","to":"Linux/new.md"}。移动/删除需要精确 If-Match，不覆盖目标，不自动重写 Markdown 链接。跨设备移动不提供静默复制降级；挂载与本地信任边界由部署环境管理。

删除返回 {id,path,kind,revision,deletedAt,state,stage?}；stage 是受管理的恢复名称，不是可编辑笔记路径。回收列表同样默认每页 200、最大 1000，返回 {entries,total,offset,limit}。状态包括 ready、preparing/incomplete、damaged，异常记录保留供检查。

恢复 POST 不需要正文，但需要 CSRF；成功返回 {path}，目标碰撞 409，原父目录缺失 404，不自动选择其他路径。500 或连接失败可能发生在目录变更后，客户端须保留缓冲并刷新目录/回收站协调，不能假定原路径仍在。

## 附件与限额

元数据返回 {path,size,mtime,mediaType,viewer}，viewer 为 markdown、text、image、pdf 或 binary。按实际字节分类，静态链接和特殊文件拒绝；硬链接由部署管理，SVG/HTML 不活动预览。

上传只允许一个名为 file 的 multipart 部分，原始 filename 必须是纯文件名，穿越明确拒绝而非截断。image=true 仅接收支持且限额内的位图。成功 201 返回元数据；同名 409、超限 413、图片/预览不兼容 415 preview_unavailable。多个部分或不完整请求不得提交目标，多个文件分请求且不是批量事务。中断可能发生在服务端提交后，应先检查目录再重试。

下载强制 octet-stream 与 attachment，支持 Go 文件响应的 Range 下载。预览仅允许验证过的位图或有界 PDF 类型检查，带 sandbox CSP 与 nosniff；PDF 客户端以画布渲染，不构建活动页面。不解压归档。

GET /settings 返回 {limits:{text,image,pdf,attachment,imagePixels}}，除 imagePixels 外均为字节数。只读启动配置，环境变量与默认值见 [README](../README.md)。

## 搜索

GET /search 返回 {entries:[{path,name,excerpt}],truncated,limit,status}。省略 mode 为全文，mode=names 为名称/路径子串。空全文返回无结果，空名称查询列文件。查询为最多 200 个 Unicode 字符的字面文本，不支持 FTS 运算符或正则；limit 默认 50、最大 200，超出标记 truncated，无分页。摘要为纯文本，支持 ASCII 大小写不敏感，不承诺 Unicode 规范化或重音折叠。

GET /search/status 返回 {indexing,indexedAt,files,warning?}；POST /search/rebuild 需要 CSRF，返回 202 {accepted:true}，异步完成。缓存错误 503 index_unavailable 不阻断文件读写；warning 表示可能陈旧。索引正文限额见 README，刷新节奏见 [架构](ARCHITECTURE.md)，不包含未保存正文、PDF/OCR。

## 工作区身份

workspaceId 由应用初始化盐、用户 ID 与平台根身份派生，Linux 使用设备号/inode，Windows 使用卷/文件身份；它不是凭据或内容版本。页面请求以 X-Folio-Workspace 固定身份，预览/下载 URL 使用 workspace 查询字段。

身份不符时，受保护的非认证接口在存储前返回 409 workspace_changed；客户端停止写入、保留/下载草稿并重新加载，不能自动采用新身份重试。缺少身份字段的旧客户端仍沿用原接口行为。迁移根或 app-data 可改变命名空间，浏览器缓存不属于服务器备份。

## 错误与边界

| 状态 | 常见代码 |
| --- | --- |
| 400 | path_invalid |
| 401 / 403 | unauthenticated / forbidden |
| 404 | not_found |
| 409 | target_exists、file_changed、workspace_changed、operation_in_progress |
| 412 / 428 | revision_conflict / precondition_required |
| 413 / 415 | too_large / unsupported_file_type、preview_unavailable |
| 422 | trash_damaged |
| 429 | rate_limited |
| 500 | internal_error、durability_uncertain、trash_failed、trash_incomplete |
| 503 | trash_unavailable、index_unavailable |

file_changed 表示操作中的文件/父身份发生变化；durability_uncertain 表示替换后目录同步失败，客户端保留草稿并重读协调。外部写入者竞争窗口及平台持久性限制见跨平台说明，不保证全局文件系统条件交换。

登录仅允许一个在途密码校验，忙时 429、Retry-After: 1，不排队且不消耗来源密码错误配额；来源失败次数触限时 Retry-After: 600。客户端保留输入并显式重试，不自动反复发送密码。

## 用户管理与配额

- GET /workspace/usage：当前用户 {used,quota}，单位字节，包含回收载荷。统计失败返回错误，不能解释为零用量。
- GET /admin/users?q=&offset=0&limit=20：仅管理员，字面用户名搜索；返回 {entries,total,offset,limit}，条目为 {id,username,admin,enabled,quota,used,usageError?}。用量读取失败时 used 为 null，附 usageError。
- POST /admin/users：仅管理员，JSON {username,password,enabled,quota}，返回 201 用户元数据。初始密码必填；不接受客户端指定角色、ID 或目录。
- PATCH /admin/users/{id}：仅管理员，JSON {username,enabled,quota,password:""}，返回 200 用户元数据。密码非空时可重置并撤销该用户会话；界面使用下方独立重置接口，避免重置密码覆盖其他设置。
- POST /admin/users/{id}/password：仅管理员，JSON {password}，只更新密码、撤销指定用户全部会话，返回 {ok:true}。
- POST /auth/password：当前用户，JSON {oldPassword,newPassword}，原密码验证通过后更新并撤销该用户全部会话、清除当前 Cookie，返回 {ok:true}；页面保留正文并允许重新登录。
- DELETE /trash/{id}：永久删除当前用户完整 ready 回收记录及载荷，返回 {ok:true}；未完成或损坏记录拒绝删除。

所有修改接口沿用 Origin/CSRF 校验。用户 ID 为正整数，用户名为 1–64 位 ASCII 字母/数字/下划线/点/短横线且首字符为字母或数字，大小写不敏感唯一；密码为 12–1024 字节；quota 为 0–2^50 字节整数（0 表示不允许增长）。首个管理员不可禁用，不提供删除账号、公开注册、授予管理员或跨用户文件操作接口。

新增错误：400 invalid_user、409 username_exists、403 invalid_password、413 quota_exceeded、503 workspace_unavailable。配额不足保留原正文和待上传原件，不盲重试；降低配额到已用以下不会清理文件。禁用和改密撤销后续请求会话，已在执行中的请求可能完成。

### 上传前检查与失败提示（2026-10-17）

客户端在发送附件前读取 /settings 与 /workspace/usage，按文件名和前 512 字节判断图片/PDF限额，显示实际大小、类型上限或剩余配额。超过已知限额不发送上传正文；失败原件仍保留在页面供下载/重试。该检查不替代服务端流式限额、最终配额复核和文件验证，不能预知外部代理的更低限制。非 JSON 的 HTTP 413 单独提示服务器/代理大小拒绝；无有效响应时说明结果待确认，不直接断言网络中断。

## 统一搜索（2026-10-17）

只有一个搜索入口，Ctrl/Cmd+P 与 Ctrl/Cmd+Shift+F 打开同一窗口，不提供名称/全文切换。复用现有名称与全文查询接口并行请求，180ms 防抖、查询键与取消信号隔离迟到响应；空查询仅列文件。文件匹配优先、正文匹配随后，按路径去重，同时命中时补充摘要。结果逐类显示，互不等待，错误独立呈现；全部完成且无错误才显示无匹配。键盘选中按路径保持，补充结果和摘要时维持选中项的滚动位置，编辑器会话不受影响。

服务端全文接口仍兼容原有包含路径的查询语义。正文索引按实际 UTF-8 内容识别，无扩展名白名单，默认正文上限 5 MiB；常见文本、配置、日志、源码和无扩展名文本均可搜索。非 UTF-8、NUL、PDF、位图和超限正文不索引；HTML/SVG 仅搜索源码，不执行。未保存草稿不参与搜索。

## 索引更新通知（2026-10-17）

文件新建/保存、上传、移动、回收、恢复通过 API 完成后，异步通知对应用户索引，仅核对受影响路径和子树；连续变更合并，移动同时核对旧、新路径。接口返回仍表示文件操作结果，不等待索引完成；GET /search/status 的 indexing 包含待处理任务，files 为已提交索引总数。部分失败可能已经变更磁盘时安排路径核对，恢复目标不确定时全量补偿。空目录创建、账号管理、永久删除回收载荷不触发索引。

取消索引周期扫描和周期重建。直接修改宿主目录不会自动刷新搜索，可 POST /search/rebuild 或重启服务后访问工作区；启动全量重建会补偿未发送或未处理的事件。索引异常保留 warning，完整重建成功前不以其他路径成功掩盖故障；文件正文及编辑器版本保护不变。队列超过 256 个独立路径时仅安排一次全量核对，不开启轮询。

## 当前文件索引状态（2026-10-17）

GET /search/file-status?path=<相对路径>&revision=<可选已保存版本> 需要账号鉴权及工作区身份校验，返回 {size,bodyLimit,state}，大小和上限单位为字节。state 为 indexed、names_only、too_large、pending、not_indexed 或 error。对照已提交索引记录和已保存版本判断，不信任扩展名推断索引成功；空文本可为 indexed。revision 仅用于发现当前会话版本与索引版本不同，不作为权限或磁盘写入条件。非法路径 400、不存在 404、目录或特殊文件拒绝、索引不可用 503。状态查询只读取安全文件元数据和 SQLite 已提交记录，不重新读取正文或计算摘要。只有 pending 状态短暂轮询，切换文件/保存后的新版本会重新查询，手动重建使状态缓存失效。

默认 FOLIO_MAX_INDEX_BYTES 从 1 MiB 提高到 5 MiB；环境变量仍可覆盖。启动首次访问工作区时全量重建，因此原先仅索引名称、现在不超过 5 MiB 的文本会自动补上正文。


## 系统设置与状态（2026-10-17）

所有接口仅管理员访问，沿用会话、工作区身份、Origin/CSRF 校验：

- GET /api/v1/admin/settings：返回 {limits:{Text,Image,PDF,Attachment,ImagePixels},indexLimit}，字节/像素整数。
- PUT /api/v1/admin/settings：提交同结构完整设置；文本与索引 1 字节–100 MiB，附件 1 字节–1 GiB，图片/PDF 正整数且不得高于附件，像素 1–10 亿。400 invalid_settings / 500 settings_failed；失败不改变生效配置。保存后在线生效、索引变化自动重建。GET /settings 继续返回当前工作区有效限额。
- GET /api/v1/admin/status：返回 goVersion、platform、uptime（秒）、goroutines、cpus、openWorkspaces、indexedFiles、memory（Go runtime.MemStats）、lastPauseNs、sinceGC（秒）。indexedFiles 仅包括已打开工作区。
- GET /api/v1/admin/disk：显式扫描 workspace/appData，分别返回 bytes、files、directories（包括根目录）、total、available（所在卷）；volumeError 表示卷容量不可用。扫描失败 503 disk_unavailable，并发扫描 409 operation_in_progress。逻辑文件大小不等于实际磁盘占块或用户配额；appData 含数据库、索引、回收站。

保存设置覆盖持久化值，重启继续使用；环境变量仅为未保存系统设置时的初始值。降低限制不清理文件；超过新文本上限的已有文件可能无法继续编辑，仍可下载，管理员可恢复上限。


## 本机标签恢复（2026-10-22）

本功能不新增接口。复用带工作区身份校验的 GET /files/metadata 与 GET /files/content，恢复不提交正文；后续编辑继续使用 If-Match 条件保存。浏览器路径记录不构成授权，服务端继续验证身份及路径边界。

## 分享接口（2026-10-22）

新建分享 ID 为 16 字符 Base64URL（A–Z、a–z、0–9、下划线及连字符，区分大小写）；公开页面 /s/{id} 与全部分享 API 兼容原 48 字符小写十六进制 ID。旧记录和 URL 不迁移；附件 ID、访客令牌、版本长度不变。

管理与转存接口沿用账号 Cookie、来源、CSRF 和工作区身份保护。公开接口使用独立分享资格，不接受用户路径选择其他资源。全部 API no-store，公开页与公开接口 noindex/nofollow/noarchive；Referrer-Policy no-referrer。文件原件仅下载，位图／PDF 才允许隔离预览。HEAD 不计次，进入只能 POST。

| 方法 | 路由 | 行为 |
| --- | --- | --- |
| GET | /shares | 当前分享者记录列表，最多 1000 条 |
| POST | /shares/analyze | {root,include}，递归分析候选 files 与 warnings；include=false 仅主文件 |
| POST | /shares | 创建确认清单与访问限制，返回 201 分享记录 |
| PUT | /shares/{id} | 更新本人的分享，必须提供最新 version，保留已用次数 |
| DELETE | /shares/{id} | 先暂停、再清理快照和记录；失败保留可重试管理记录 |
| POST | /shares/{id}/import | {file, directory}，file 为包内 ID，directory 为接收工作区新目录，返回 201 {path} |
| GET | /public/shares/{id} | 返回 {protected}，不返回标题／正文／清单 |
| POST | /public/shares/{id}/enter | {password}，验证并扣一次进入次数；已有资格复用，不重复扣；设置访客 Cookie |
| GET | /public/shares/{id}/manifest | 有效资格下返回确认清单与公开记录 |
| GET | /public/shares/{id}/files/{file}/metadata | 当前安全类型与文件元数据 |
| GET | /public/shares/{id}/files/{file}/content | 仅文本，返回 {metadata,content,html}，Markdown HTML 为只读派生展示 |
| GET | /public/shares/{id}/files/{file}/preview | 仅安全位图／PDF，支持 Range，不计次 |
| GET | /public/shares/{id}/files/{file}/download | 原件下载，支持 Range，不计次 |

创建／更新字段：root、title、mode（snapshot/live）、files（{path,revision} 数组）、expiresAt（Unix 秒，0 永久）、maxVisits（0 不限，最多 1000000）、password（可选六位数字，空字符串移除，省略保留）、disabled（true 暂停，false 继续）；更新另传 version。不允许新设过去时间，不重置已用次数；已到期记录自动删除，陈旧更新返回 404 或 410，不允许续期恢复。files 省略只修改访问设置，提供则重新验证来源递归可达清单并创建新快照；不能省略主文件，不能改变已有分享 root 或 mode。live 的 files 必须只有主文件，快照／实时转型须创建新链接。新清单和访问设置更新会使旧访客资格失效。

公开资源 ID 和分享标识不可充当账号权限；访客不能管理分享。常见错误：400 非法模式／实时含附件／密码格式，403 无访问资格／密码错误，404 分享不存在／清单外文件，409 管理版本陈旧，410 暂停／过期／次数用完／来源工作区变化，412 文件确认版本变化，413 配额／包或文件限制，429 验证／载荷繁忙，500 明确操作失败。转存失败响应不等于所有文件系统故障都尚未提交，durability_uncertain 仍须核对结果目录。Cookie 内资格令牌不进入 URL 或 localStorage。

分享列表支持 offset、limit，默认每页 20 条、最多 50 条，返回 {entries,total,offset,limit}。公开访客有效授权最多保留 10000 条，容量满时 429，过期授权在新进入事务中清理；不会因容量失败扣减访问次数。

## 用户令牌与存储分类（2026-10-26）

以下管理接口只接受浏览器 Cookie 会话；修改仍需 CSRF 与来源校验：

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| GET | /user/tokens | 当前账号最多 100 条令牌，返回 {entries} |
| POST | /user/tokens | 生成令牌，201 返回元数据及仅此一次的 token |
| DELETE | /user/tokens/{id} | 删除本人令牌，返回 {ok:true}，不存在或其他账号令牌均为 404 |
| GET | /workspace/storage | 按需统计，返回 {used,quota,categories:[{key,bytes}]} |

创建 JSON 为 {name,expiresAt,permissions:{files,search,trash}}。权限枚举 none/read/write，至少一项非 none；expiresAt 是 Unix 秒，0 为永久，非零必须在未来且不超过 366 天。name 去除首尾空白后为 1–80 个字符。元数据字段 id、name、prefix、createdAt、expiresAt、lastUsedAt、permissions；时间为 Unix 秒，lastUsedAt=0 表示尚未使用。列表不返回摘要或完整令牌。输入无效 400 invalid_token，数量超限 409 token_limit。

程序客户端在请求头发送 Authorization: Bearer folio_<64位十六进制随机值>，不得放入 URL。无效／过期／已删除／所属账号禁用为 401；有 Cookie 也不回退。无对应权限为 403 token_forbidden，绑定工作区变化为 409 workspace_changed。Bearer 不使用 Cookie 的 CSRF，但仍受正文、上传、ETag 条件写入、配额、路径边界及 no-store 约束。

| 权限组 | 只读 | 读写额外允许 |
| --- | --- | --- |
| files | workspace/tree、workspace/usage、workspace/storage、files/metadata、files/revision、files/content、files/download、files/preview、entries/revision、settings 的 GET | POST files、directories、uploads；PUT files/content；PATCH entries/move |
| search | GET search、search/status、search/file-status，包含可命中文本摘要 | POST search/rebuild |
| trash | GET trash | DELETE entries、POST trash/{id}/restore，另须 files=write |

其余私有路由不允许令牌，包括 /auth/*、/admin/*、/user/tokens、私有 /shares* 和永久删除回收记录。search 授权允许搜索本账号已保存内容，不要求 files 权限；授权范围始终为本人整个工作区，没有目录范围参数。公开分享入口维持独立访客授权规则。

categories 固定为 documents、images、media、other、trash、shares；各项 bytes 之和等于本次 used，quota=0 表示零额度，不能解释为无限。按扩展名分类，不承诺实际内容类型。失败返回明确错误，不返回伪造的零用量。索引／数据库不计费，临时文件及外部写入一致性边界同配额说明。
