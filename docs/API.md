# HTTP 接口协议

基础路径 /api/v1。除上传/下载流外使用 JSON。下表记录已实现接口；PATCH /settings 尚未实现，不作为客户端可调用能力。代码字段与协议名称保留英文。

## 通用约定

- 除登录、静态资源与无内部信息的健康检查外，接口需要有效会话。登录与 me 返回 {username,csrfToken,workspaceId}，登录请求为 {username:"admin",password:"..."}。
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

离线密码恢复没有 HTTP 入口，见 [改密说明](PASSWORD.md)。

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

移动 JSON：{"from":"Linux/old.md","to":"Linux/new.md"}。移动/删除需要精确 If-Match，不覆盖目标，不自动重写 Markdown 链接。跨设备移动不提供静默复制降级，挂载与本地信任边界见 [跨平台说明](PORTABILITY.md)。

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

workspaceId 由账号初始化盐与平台根身份派生，Linux 使用设备号/inode，Windows 使用卷/文件身份；它不是凭据或内容版本。页面请求以 X-Folio-Workspace 固定身份，预览/下载 URL 使用 workspace 查询字段。

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
