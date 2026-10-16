# M3 安全与故障审查

> 后续变更：文件运行时已采用标准库优先实现及新的部署权限边界，见 [PORTABILITY.md](PORTABILITY.md)。本页此前的 Linux openat2/UID/硬链接拒绝和镜像验收结果属于对应历史构建，不能直接当作新实现的验证；独立 Python 备份工具仍是 Linux 专用。


本记录区分代码检查、自动化复现和未完成门槛，不代表独立渗透测试或所有环境的安全证明。默认部署保持回环端口；最终公开暴露前按下面剩余项目复核实际镜像和代理。

## 信任边界

- 浏览器和上传文件可以不可信，所有正文、目录、索引、回收站、下载与预览接口需要有效会话。仅登录、静态应用资源和无内部信息的 liveness 公开。
- workspace 中的路径、文件类型和内容均不视为可执行程序。正文权威是普通文件；不解压附件、不启动 shell、不执行用户源码或 HTML/SVG。
- app-data、部署配置、镜像、宿主机和运行 UID 属于运维信任边界。私有账号目录/文件有类型检查，权限由部署者管理，但不防御恶意同 UID 进程持续替换 SQLite 命名空间。workspace 与 app-data 必须独立，单实例写入。
- 外部编辑器被允许，不等于提供对不协作外部进程的全局文件系统事务。最后一次版本检查与 rename 之间的竞争限制仍按 `PORTABILITY.md` 说明；浏览器冲突与备份停写要求不能省略。

## 当前证据

| 边界 | 实现/检查 | 自动化证据与范围 |
| --- | --- | --- |
| 路由鉴权 | 私有路由统一 protect；原文件不可作为静态资源访问 | `security_test.go` 枚举 21 个私有入口及 GET 的 HEAD，缺会话时在业务/存储之前返回 401，禁止缓存且不开放 CORS |
| 修改来源与 CSRF | 会话后验证 Origin、Sec-Fetch-Site 与独立 CSRF；无 Origin 的非浏览器客户端仍须 CSRF | 同一测试覆盖所有修改入口，错误/不透明来源、跨站标记、缺失/错误 CSRF 均 403；跨站登录也拒绝 |
| 密码与会话 | Argon2id；随机会话与 CSRF；数据库保存令牌摘要；Cookie HttpOnly/Secure/SameSite Strict | auth/API 测试覆盖重启、令牌轮换、撤销、限速、离线重置与 Cookie 属性；离线重置事务失败不部分修改 |
| 高成本登录 | 一个在途密码校验，忙时不排队、不消耗密码错误次数 | auth 测试验证排队拒绝；实际并发 HTTP handler 测试验证 8 个同时请求中 1 个成功、7 个 429，忙时 Retry-After 为 1 秒 |
| 路径与类型 | 当前使用 os.Root 根内解析并拒绝静态链接/特殊文件；硬链接与嵌套挂载由部署管理，详见 PORTABILITY.md | storage 测试覆盖穿越、链接/FIFO、符号链接换位竞争；回收站测试覆盖不安全子树和跨设备恢复 |
| 条件写与故障 | 强版本、单实例串行、私有同目录临时文件、fsync、rename；错误保留缓冲区 | stale-write、并发写、外部修改、浏览器保存失败/恢复测试；`faults_linux_test.go` 使用隔离子进程的 RLIMIT_FSIZE 产生实际部分写入/EFBIG，并观察临时文件后 SIGKILL，最终正文只允许完整原版或新版 |
| 上传 | 有界流式写入，不信任 Content-Length/扩展名；原始名称验证、同名不覆盖、完整单 part 后发布 | attachment API 测试覆盖路径穿越、碰撞、超限、多个 part、拒绝 SVG 图片入口；失败不留下目标文件 |
| 预览与下载 | 图像真实类型/尺寸检查；HTML/SVG 不活动预览；原件 octet-stream attachment；sandbox CSP、nosniff、same-origin CORP | attachment 测试检查响应类型、拒绝 SVG 预览、隔离头和原始字节；PDF 由 PDF.js canvas 渲染，不构建注释/脚本/XFA DOM |
| Markdown 链接 | 工作区链接有界解析；外链只由桥接显式打开 HTTP(S)，noopener/noreferrer；相对图片指向认证预览 | bridge 单元测试拒绝活动协议、越界路径与非法编码；已检查当前安装的 Milkdown link mark/tooltip 使用 sanitizeLinkHref。主/辅助点击的历史 HTTPS 验证见下文，新构建需重新验证 |
| 应用响应 | CSP 禁止对象、内联脚本、非同源脚本与 framing；不输出绝对路径到文件 API 错误 | router 测试验证静态/API 的 CSP 和 nosniff；生产 CSP 的历史镜像执行探针见下文，新构建需重新验证 |
| 服务器恢复 | 离线双卷快照校验、新目录发布、撤销旧会话，搜索从真实文件重建 | 主机及原生 amd64 HTTPS 容器备份恢复演练见 [验收记录](ACCEPTANCE.md)；不是所有文件系统的断电证明 |

代码定位：`backend/internal/{auth,httpapi,storage,trash,search}`、`frontend/src/editors/milkdown/{bridge,engine}.ts`、`frontend/src/app/Workbench.tsx` 和 `frontend/src/viewers/PdfViewer.tsx`。错误响应使用稳定中文信息；详细本地系统错误只写服务日志，日志仍应按私有运维数据保管。

## 登录行为

同一时间只运行一次 Argon2id 校验。忙时返回 429 `rate_limited`、`Retry-After: 1`，用户稍后重试即可；不自动重发密码，不建立后台等待队列。按连接来源的失败次数上限仍为 10 分钟内 5 次，触发后 `Retry-After: 600`。来源记录最多 1000 条；不信任任意 X-Forwarded-For，因此代理后的来源限速可能共享。全局在途上限控制高成本计算和等待连接，不替代代理级流量限制或抵御分布式拒绝服务。

## HTTPS 构建验证（2026-10-16）

`CONTAINER_ENGINE=podman FOLIO_TEST_IMAGE=<image> make container-review` 使用实际嵌入 SPA 的 HTTPS 容器和 512 KiB tmpfs 工作区，未填满宿主磁盘。已在原生 amd64 与 QEMU 11.1.2 arm64 上通过：生产 CSP 实际阻止 DOM 插入的内联/外部脚本，HTML/SVG/Markdown 原文保留、活动预览拒绝、原件下载隔离，危险链接主/辅助点击、站内打开、外链 noopener/无 Cookie/Referrer、远程图片不发请求及匿名读取拒绝。保留例外仅为本次测试证书 SPKI，浏览器未全局忽略 HTTPS 错误；宿主另行完整验证 CA/主机名。

磁盘满使用真实内核 ENOSPC：占位文件后保存较大草稿得到 500，日志确认 no space left on device，旧正文精确不变；完整草稿可下载并在实际刷新后从 IndexedDB 显式恢复，移除占位文件到跨设备回收站后可条件保存原稿。保存请求没有注入模拟失败。工作区是临时容器 tmpfs，不以它证明持久卷断电恢复。

证据为 `artifacts/security/container-review-{amd64,arm64}.json`，镜像 ID 和时间记录在其中。两架构的实际两 bind mount 部署/重启/离线改密验收另见 `artifacts/container/container-acceptance-*.json`；健康检查保留。ARM 运行的是 ARM Go 二进制，但使用 QEMU 与宿主内核，非原生硬件。

## 剩余范围与边界

- 换行修复后的当前镜像已重新验证安全/ENOSPC 与双架构运行，最终 ID/归档见 `ACCEPTANCE.md`；后续产品代码改变后仍需要更新对应证据，不能沿用旧 ID 声称新构建已测。
- SIGKILL 覆盖从临时文件创建后到替换完成的竞争窗口，不精确控制每个 fsync/rename 指令，也不等同断电或所有文件系统证明。
- 无障碍与 1202 文件/较大正文检查现已形成独立的生产构建 QA，当前结果和适用范围见 `QUALITY.md`；真实读屏器与全部动态编辑器部件仍未宣称通过。依赖审计发现的间接 KaTeX 旧副本已定向对齐到 Crepe 使用的 0.19.0，本次普通 npm ci/审计为 0 已知告警，没有强制降级编辑器。
- 实际外部代理的 TLS、Host/Origin、请求大小和状态码透传需要部署者核验；当前环境的 rootless Podman 证据不能冒充 Docker daemon 部署。
