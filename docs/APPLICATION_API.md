# 应用 API 接入指南

Folio 提供同源 `/api/v1` HTTP 接口，支持脚本和 Agent 使用 Access Token 操作本人工作区。已有文件操作直接复用，不建立另一套文件存储或正文格式。

在“用户设置 → 应用”生成令牌、选择权限和有效期。完整令牌仅显示一次，服务端保存摘要；丢失后删除重建。通过 HTTPS 传输；本机隔离开发可使用 HTTP。不要将令牌放进 URL、仓库、日志或浏览器 localStorage。

在线说明位于 `/api-docs`，可从应用页“API 文档”进入；说明页只读，不执行文件操作。机器契约位于 `/api/v1/openapi.json`，也保存在 [openapi.json](../backend/internal/httpapi/openapi.json)。定义遵循 [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0.html)，可供客户端工具导入。公开 JSON 只含静态协议，不含真实账号、文件或凭据；网页说明仍需登录。

## 连接与身份

下例使用 shell 和 curl。通过自己的安全凭据配置提供 `FOLIO_ACCESS_TOKEN`，将 `FOLIO_URL` 设为站点地址，不包含末尾 `/api/v1`：

```sh
export FOLIO_URL='https://你的域名'
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $FOLIO_ACCESS_TOKEN" \
  "$FOLIO_URL/api/v1/application"
```

返回 `apiVersion`、`user:{id,username}`、`workspaceId` 和当前 `token:{id,name,prefix,createdAt,expiresAt,lastUsedAt,permissions}`，不返回完整令牌、摘要、CSRF、管理员身份或其他令牌。`expiresAt=0` 为永久；`lastUsedAt=0` 为尚未使用，使用时间最多每分钟更新。此接口只接受 Bearer，Cookie 单独调用返回 `403 token_required`。

Bearer 请求无需 Cookie、Origin 或 CSRF。无效令牌返回 `401 unauthenticated` 和 `WWW-Authenticate: Bearer ...`，即使同时存在有效 Cookie 也不会回退。账号禁用、改密、管理员重置会撤销对应账号令牌；离线改密和备份恢复清除全部。已开始请求可能完成。

## 权限

权限覆盖本人整个工作区，暂无目录限制；账号 ID／workspaceId 参数不能选择其他用户资源。`write` 包含 `read`。

| 权限 | 只读 | 读写额外允许 |
| --- | --- | --- |
| files | 浏览目录、读正文／版本／元数据、下载／预览、限额与用量 | 新建文本／目录、条件更新／移动、附件上传 |
| search | 查询名称／正文摘要及索引状态 | 异步重建索引 |
| trash | 回收记录列表 | 回收与恢复，另需 files=write |

`search=read` 本身包含可命中正文的摘要，不要求 files 权限。令牌不能访问账号、系统、令牌管理、私有分享管理／转存，也不能永久删除回收站文件。公开分享仍使用独立访客规则，不因应用令牌自动授权。

## 路径、目录与新建

路径为 UTF-8 工作区相对路径，根目录用空字符串；拒绝绝对路径、`..`、反斜线、链接和特殊文件。查询参数用 URL 编码；JSON 中不预先 URL 编码路径。目录列表只返回直接子项，默认 200、最多 1000 项，以 offset/limit 分页；不能假设宿主变动期间是快照。

```sh
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $FOLIO_ACCESS_TOKEN" \
  --data-urlencode 'path=笔记' --data-urlencode 'offset=0' --data-urlencode 'limit=100' \
  "$FOLIO_URL/api/v1/workspace/tree"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $FOLIO_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  --data '{"path":"笔记"}' "$FOLIO_URL/api/v1/directories"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $FOLIO_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  --data '{"path":"笔记/示例.md","content":"# 示例\n","encoding":"utf-8"}' \
  "$FOLIO_URL/api/v1/files"
```

根据自己的工作区依次选择需要的命令；目录和文件创建不会覆盖同名目标，同名返回 409；父目录须存在。不递归创建目录，不提供批量事务。

## 条件读写

`GET /files/content?path=...` 返回原始 UTF-8 正文、版本以及强 ETag 响应头。正文保留 BOM、LF／CRLF／混合换行。只读取已保存文件，看不到浏览器未保存草稿；修改后浏览器沿用原有版本探测与冲突保护。

客户端必须保留原始内容及版本，只改变目标内容；不要通过默认文本换行转换无意改写整篇文档。以下 Python 标准库示例演示“读取 → 以本地候选文件条件更新”，不自动重试，不跟随重定向携带凭据：

```python
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None

base = os.environ['FOLIO_URL'].rstrip('/') + '/api/v1'
headers = {'Authorization': 'Bearer ' + os.environ['FOLIO_ACCESS_TOKEN']}
client = urllib.request.build_opener(NoRedirect())
path = '笔记/示例.md'
url = base + '/files/content?' + urllib.parse.urlencode({'path': path})
with client.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
    original = json.load(response)
    etag = response.headers['ETag']

# 原始字节读取不会替你把 CRLF 变成 LF；候选正文由调用方准备并保留。
candidate = Path('candidate.md').read_bytes().decode('utf-8')
body = json.dumps({'content': candidate, 'encoding': 'utf-8'}, ensure_ascii=False).encode('utf-8')
request = urllib.request.Request(url, data=body, method='PUT', headers={
    **headers, 'If-Match': etag, 'Content-Type': 'application/json',
})
with client.open(request, timeout=30) as response:
    saved = json.load(response)
    print(saved['path'], saved['revision'])
```

该示例会写入既有文件，仅在已准备候选正文时运行。读取后再编辑候选内容期间，必须继续使用同一次读取的版本，不能为绕过冲突而先取一个新版本。`428` 表示缺少条件，`412` 表示版本陈旧：保留候选正文，重新读取比较、由调用方决定合并或另存。客户端不得自行生成版本、使用 `If-Match: *` 或自动换成最新版本反复覆盖。

`PATCH /entries/move`、`DELETE /entries` 同样必须携带原文件／完整目录子树版本，可先调用 `GET /entries/revision`。移动不覆盖目标，不自动改写链接；跨设备移动不静默复制。

## 附件、下载与 HEAD

先读 `GET /settings` 和 `GET /workspace/usage` 做客户端预检；服务端仍执行流式大小、图片像素与最终配额核对。配额 0 是零额度，不是无限。

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $FOLIO_ACCESS_TOKEN" \
  -F 'file=@./image.png' \
  "$FOLIO_URL/api/v1/uploads?directory=%E7%AC%94%E8%AE%B0&image=true"

curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $FOLIO_ACCESS_TOKEN" \
  --data-urlencode 'path=笔记/image.png' \
  --output ./downloaded-image.png "$FOLIO_URL/api/v1/files/download"
```

上传必须只有一个名为 `file` 的文件 part；文件名须为纯文件名。多文件分请求，每个请求独立提交，不会覆盖同名文件。

下载返回原始字节，不能当 JSON 解析；支持 `Range: bytes=0-1023` 与 206 响应。`HEAD` 与对应 GET 使用同一读取权限，只返回头部。预览仅限安全位图／PDF，并带隔离响应头；HTML／SVG 不活动预览。无效 Range 的 416 以及底层文件服务错误可能是 `text/plain`；客户端先检查状态与 Content-Type。API 的错误响应也保持 `Cache-Control: no-store`。

## 搜索与回收恢复

`GET /search?q=...` 默认全文，`mode=names` 为名称／路径搜索，查询最多 200 个 Unicode 字符；limit 默认 50、最大 200，没有分页，检查 `truncated`。只支持字面查询，不支持正则或 FTS 语法。空全文无结果，空名称查询列文件。

保存后索引异步更新；`GET /search/status` 的 `indexing` 含排队与处理中任务，`warning` 表示可能陈旧。`POST /search/rebuild` 返回 202 仅表示已接受，要查询状态确认完成；客户端设置等待上限，不能无限忙等。直接宿主文件修改不自动更新索引。

回收流程是读取版本 → `DELETE /entries?path=...` 携带 If-Match → 保存返回的记录 ID。`GET /trash` 分页列出当前账号记录；`POST /trash/{id}/restore` 不需正文，恢复到原路径且不覆盖目标，父目录须存在。回收不释放配额，损坏／未完成记录保留供检查；令牌不支持永久删除。

## 失败与重试

JSON 错误形状为 `{error:{code,message,details}}`，以 code 决定处理，message 为简体中文提示；二进制接口及代理错误可能不是 JSON。

| 状态／错误 | 调用方处理 |
| --- | --- |
| 401 | 检查令牌到期、撤销与账号状态，重新申请；不尝试回退 Cookie |
| 403 | 检查当前权限，不自动提升权限 |
| 404 | 核对当前路径，外部移动不会被自动追踪 |
| 409 target_exists | 核对既有文件，选择新路径，不覆盖 |
| 409 workspace_changed | 停止写入，人工确认工作区后重新申请令牌 |
| 412／428 | 保留候选内容，读取并比较；补上原版本，不能盲重试 |
| 413／415 | 检查配额、限额和文件类型，保留原件 |
| 429 | 遵守 Retry-After；设置次数和等待上限 |
| 500 durability_uncertain／回收中断 | 操作可能已提交，先核对文件与回收记录，保留候选正文／原件 |
| 503 index_unavailable | 搜索索引故障；文件读写不必因此停止 |
| 超时／连接断开 | 结果未知，先读取确认，不能假定未提交 |

目前没有幂等键、批量事务、自动合并、目录级令牌授权、OAuth 或 MCP。客户端可以保存自己的任务状态，但不能绕过服务端原版本与文件边界验证。

## 可复现验证

后端契约一致性测试包含在 `go -C backend test ./...` 中。完整隔离演练使用单独 Python 环境，开发校验依赖不进入生产服务：

```sh
python3 -m venv /tmp/folio-api-validation
/tmp/folio-api-validation/bin/pip install -r scripts/requirements-api-test.txt
/tmp/folio-api-validation/bin/python scripts/application-api-test.py
```

脚本构建并启动临时 Go 服务、创建隔离账号和文件，用纯 Bearer 调用所有契约操作，验证 JSON 响应结构及关键授权／冲突边界；报告位于 `artifacts/application-api/contract-report.json`。脚本不会访问日常服务或读取真实用户令牌。


## 给 Agent 的入口

先读取同源 `/api/v1/agent.md`，再读取 `/api/v1/openapi.json`。前者说明任务流程和失败恢复，后者给出精确字段与权限；两者均可匿名获取，实际操作仍需 Bearer。指南源文件为 [AGENT.md](../backend/internal/httpapi/AGENT.md)，不会覆盖项目根目录的 AGENTS.md，也不会自动安装 Skill。


## 使用 diff 局部修改

`PATCH /api/v1/files/content?path=...` 使用现有 files=write 权限（Cookie 仍需 CSRF），要求完整强 If-Match。JSON 为 `{diff,dryRun?}`，dryRun 默认 false。采用 [unified diff](https://www.gnu.org/software/diffutils/manual/html_node/Detailed-Unified.html) 的单文件严格子集，按指定行号核对上下文和删除内容，不做偏移搜索或模糊匹配，不依赖 git／patch 进程。

```http
PATCH /api/v1/files/content?path=notes%2Fexample.md
Authorization: Bearer <Access Token>
If-Match: "<读取时的 revision>"
Content-Type: application/json

{"diff":"@@ -2 +2 @@\n-旧内容\n+新内容\n","dryRun":true}
```

以上代表替换第二行，只传差异。实际调用必须先读取真实文件，使用真实版本和真实第二行；示意 ETag 不能直接使用。正式保存将 dryRun 设为 false，继续携带同一次读取的版本；如果期间变更，412 拒绝。预检不预留配额，保存仍可能遇到配额或磁盘错误。

支持多个有序非重叠 @@ 块，单行计数可省略 ,1，空范围须明确 ,0；上下文用空格、删除用 -、新增用 +。可以不带文件头；若带 ---／+++，两者必须匹配请求 path（也接受 a/path、b/path 及 Tab 分隔时间戳）。不接受 diff --git、index、重命名、/dev/null、二进制、多文件或通过补丁创建／删除文件。计数、坐标和顺序错误返回 400 invalid_patch，内容／原位置不匹配返回 409 patch_mismatch，均不保存任何块；版本陈旧仍为 412。

源文件以 LF／CRLF／CR 为逻辑行分隔，补丁自身用 LF 或 CRLF。BOM 自动保留，补丁首行正文不包含 BOM；未修改行保留原始字节。连续删除／新增块中的新增行按顺序继承对应删除行的非空换行，其他新增行用源文件首个换行（无则 LF）。源或结果末行无换行须使用标准 `\ No newline at end of file` 标记；无法在结果中间留下无分隔符的行。此接口不用于统一换行或删除 BOM，外部 diff 工具若对 CR 分行规则不同，应先核对格式。

返回 `{path,revision,dryRun,changed,addedLines,deletedLines,size,savedAt?}`，size 为候选 UTF-8 字节数。dryRun 返回原 revision／ETag，不写文件、不触发索引。实际保存返回新版本，savedAt 仅在确实改写时出现；候选与原文相同则 changed=false 且不重新落盘。保存仍走已有完整文件的安全条件替换，不是原位逐块写盘。

补丁最多 1 MiB、20000 操作行和 256 块，源／结果最多 200000 行，超限 413 patch_too_large；完整候选仍遵守现有文本和配额限制。未知字段拒绝；不支持其他 diff 方言或模糊修复。上下文错误不要通过删除约束或盲换版本重试；网络失败和 durability_uncertain 仍先读回核对结果。


## 按行读取，配合 diff 局部修改

在既有 `GET /files/content` 增加可选参数，无需新的令牌权限：

```text
/api/v1/files/content?path=notes%2Fexample.md&lineCount=100
/api/v1/files/content?path=notes%2Fexample.md&startLine=50&lineCount=30
```

分别表示前 100 行、从第 50 行开始的 30 行。行号从 1 开始，传任一参数启用按行模式，缺少的 startLine／lineCount 分别为 1／100，每次最多 1000 行。完全不传时仍返回原全文结构；空值、重复、零／负数、非整数和行数超限为 400 invalid_line_range。

片段响应除原字段外，增加 startLine、endLine、lineCount（实际行数）、requestedLineCount、totalLines、returnedSize、hasMore、nextLine、isPartial。size、revision、ETag 属于完整文件，content 与 returnedSize 属于片段。hasMore=false 并不表示全文，例如从 201 行读到 EOF 仍是片段；只有 isPartial=false 才可视为完整正文。越过文件末尾是 200 空片段（实际行数和末行为 0、nextLine=0），不是 416。

跨段读取时，把首段 ETag 原样带入后续 GET 的 If-Match；文件变化则 412，不拼接不同版本。该可选条件也支持全文 GET。局部修改直接用此完整文件版本提交 PATCH，hunk 行号使用完整文件坐标，不从片段第 1 行重新编号。**不能把片段 content 直接 PUT 成整篇文件。** 需要全量更新时先取得同版本的全部正文。

保留实际 LF／CRLF／CR 分隔符，不加展示行号；末尾换行不会虚构额外一行。空文件或仅 BOM 文件为 0 行，后者在 startLine=1 时保留 BOM 字节；其他片段不携带首部 BOM。按行读取不会写入正文、不索引草稿，仍校验全文 UTF-8／特殊文件／文本上限。服务端仍读取整文件以确认完整版本与总行数，不是任意大文件的流式读取接口；行数也不是字节大小限制。


### 与已打开的浏览器协作

通过 API 成功提交文件变更后，服务端向同账号的浏览器发送 SSE 提示。浏览器重新读取并核对版本：干净正文自动更新，修改／新增／删除位置分别短暂显示黄色、绿色和红色三角；有本地草稿时保留草稿并暂停自动保存，用户手动保存时进入差异确认。Agent 继续使用原有 If-Match 条件写入，无需订阅通知。

GET /api/v1/workspace/events 是浏览器 Cookie 专用接口，不属于应用令牌的 OpenAPI 能力。SSE 不代替并发控制，也不保证宿主直接修改文件时即时通知；浏览器保留 10 秒、焦点恢复及重连后的版本检查。
