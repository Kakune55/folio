# 测试与验证计划

## 优先级与基本原则

P0 为正文保留、鉴权、路径隔离和并发；P1 为编辑、上传、搜索和恢复；P2 为视觉与性能。公开暴露前，P0 场景必须有自动覆盖。只使用测试创建的临时目录、账号、浏览器配置和容器，不操作日常笔记。历史结果见 [验收记录](ACCEPTANCE.md)，当前文件层结果及平台限制见 [跨平台说明](PORTABILITY.md)。

## 验证命令

| 命令 | 范围 |
| --- | --- |
| make build | 前端生产构建、嵌入资源、Go 程序 |
| make test | 前端静态检查、单元/浏览器、Go 测试、主机双卷备份演练 |
| make qa | 实际嵌入页面的 4 条无障碍流程与 1202 文件性能流程 |
| cd backend && go test ./... && go vet ./... | 后端回归与静态检查 |
| make backup-test | 独立主机备份恢复演练 |
| make image && make container-test | 两卷 HTTPS、重启/会话/冲突/回收及离线改密 |
| make container-review | 生产 CSP、恶意内容、真实 ENOSPC 与草稿恢复 |

以上为类 Unix/Make 命令；Windows 构建和平台检查见跨平台说明。浏览器可用 CHROME_BIN 指定。容器用 CONTAINER_ENGINE 选择引擎、FOLIO_TEST_IMAGE 固定镜像；FOLIO_TEST_QEMU 显式标记仿真，不能当作原生硬件。完整本地回归为 make test 后 make qa，镜像另做容器门槛。

## 自动化覆盖矩阵

| 领域 | 必查场景与入口 |
| --- | --- |
| 路径/类型 | 绝对路径、穿越、URL 编码、NUL、Unicode、Windows 设备名/非法字符、根/子链接、特殊文件、竞争；storage/fileio 测试 |
| 写入一致性 | 陈旧/并发 ETag、短写、权限、重命名、同步失败、外部改写、原文件完整性；storage 与 faults_linux_test.go |
| 接口安全 | 私有入口及 HEAD 鉴权，修改来源与 CSRF，Cookie/撤销/限速，401/403/409/412/413/415/428；auth/httpapi 测试 |
| 编辑会话 | 切文件/模式、卸载异步创建、迟到响应、保存中输入、撤销、脏状态、冲突与关闭拒绝；会话单元及 workbench/files 浏览器测试 |
| Markdown | 标题、强调、转义、围栏语言、嵌套任务、表格、frontmatter、HTML/注释、相对链接/图片、引用链接、空白、Unicode、数学/脚注限制；固定原文语料和序列化快照 |
| 转换预览 | 原文/结果/差异、原文下载、Escape 保留、明确确认、移动布局、变化后旧结果拒绝；conversion-diff.test.ts、workbench.spec.ts、files.spec.ts；确认不得绕过 ETag |
| 源码字节 | LF/CRLF/CR、BOM、混合换行、跨行编辑、分组撤销/重做、切换、保存、下载、刷新恢复；line-endings.test.ts/spec.ts；直接核对磁盘字节，不以 textarea 值代替 |
| 附件 | 原始名称、流式限额、碰撞、不完整/多个 multipart 不提交；图片实际类型/像素、PDF 画布、未知二进制字节、HTML/SVG 隔离；attachments/browser 测试 |
| 搜索/外变 | 中英文长短词、技术标识符、标点/路径、重建、损坏隔离、重命名/删除；search.spec.ts；external.spec.ts 修改真实临时文件，含同大小同 mtime，不操作开发工作区 |
| 操作工作流 | 文件/目录/根真实鼠标拖拽、碰撞、键盘导航/移动/重命名、标签快捷键和冲突拒绝关闭；workflow.spec.ts；无效目标/伪造载荷以 DOM 探针断言无移动请求，勿混称原生手势覆盖 |
| 浏览器恢复 | 真实 IndexedDB 连续脏输入、刷新、独立浏览器重启、同路径多页面、命名空间、拒绝存储、未知记录导出/确认删除、暂停恢复与不覆盖副本；recovery.spec.ts |
| 手机 | 390×844 触屏仿真、抽屉焦点/遮罩/Escape、嵌套创建、旋转保留编辑器、短视口保存栏、普通/拍照选择器、原件保留/下载/重试；mobile.spec.ts；不代表硬件相机或 IME |
| 回收/备份 | 同盘/跨盘、原件隔离后失败、残缺记录保留、不覆盖恢复；backup-test.py 验证活实例拒绝、SIGKILL 留 WAL、复制件合并、损坏/链接/FIFO/越界拒绝、新位置原密码/旧会话拒绝、正文/附件/回收/搜索/后续保存 |
| 离线改密 | 实际 CLI、在线锁拒绝、无效服务环境仍离线运行、不初始化其他根、不泄露秘密、新旧密码/Cookie、身份稳定、撤销失败回滚、账号结构与密码读取边界；auth/config/httpapi/cmd/server 测试 |

## 视觉、无障碍与性能

三视口 1440×900、1024×768、390×844，浅色/深色/系统主题；检查空目录、多标签、长文件名、宽代码、1000+ 文件、上传、保存错误、冲突和未登录状态。覆盖鼠标/键盘/触屏、焦点、减少动态效果，不得整页横向溢出。

make qa 使用实际 Go 嵌入构建而非 Vite 开发服务。axe 扫描不排除编辑器，保留未完成项；另读 Chromium AX 正文/名称，验证键盘退出、焦点循环/返回、抽屉交接及关闭标签不删文件。性能实际遍历 1202 文件、搜索、162508 字节 Markdown 与 1060800 字节文本，核对完整保存内容。预算、原始测量和读屏器限制统一见 [质量记录](QUALITY.md)，输出 artifacts/qa/。

## 故障与容器证据

Linux 子进程用 RLIMIT_FSIZE 产生 EFBIG 部分写入，inotify 观察临时保存后 SIGKILL；只允许完整旧版或新版，不等价真实磁盘满或所有崩溃阶段。

container-review 使用自身 512 KiB tmpfs 获取真实 ENOSPC，日志确认错误，验证旧原文、草稿下载、刷新后显式恢复、释放空间后条件保存；不填满宿主盘。实际 HTTPS 浏览器探针检查 CSP 阻断、恶意链接/内容、远程图片不请求与匿名拒绝。临时测试域名使用保留 .invalid 并拦截，证书只固定临时 SPKI，宿主另验 CA/主机名。

container-test 使用两 bind mount 和独立持久浏览器配置，真正关闭浏览器、重启容器、重新打开后验证正文、会话、外部冲突和回收恢复；第三阶段停服，仅挂 app-data 离线改密，核对旧凭据失效与工作区身份不变。备份 HTTPS 容器演练可用 python3 scripts/backup-test.py --engine podman --container-image <镜像>。

原始容器、安全与备份报告分别在 artifacts/container/、artifacts/security/、artifacts/backup/，必须绑定时间、架构和镜像摘要。旧构建、Wine、交叉编译、仿真和真机结果分别描述；不能冒称断电保证、完整 WCAG 认证、真实手机或 Docker daemon 验证。

## M4 多账号补充

backend/internal/httpapi/accounts_test.go 覆盖用户管理、同名正文/下载/搜索隔离、越权拒绝、工作区身份、并发配额、回收载荷、改名/改密、禁用会话、超额缩小；storage/quota_test.go 覆盖流式读取边界、超额上传无提交、旧正文保留、统计故障、恢复及永久删除计费。frontend/tests/browser/users.spec.ts 覆盖管理表单与普通用户拒绝、改密/禁用撤销、返回工作区保留真实编辑器、axe 明暗扫描与 1440/1024/390 视口截图。

Windows 无符号链接权限时仅跳过链接样本或子场景，其余断言继续；不能将这些结果描述为链接安全实测。Playwright 在 Windows 使用 python、CHROME_BIN 指定本机 Chrome，测试服务器使用独立临时目录和 .exe 后缀；测试用管理员真实目录为临时 workspace/1/。

## 2026-10-17 工作区 UI 优化实测

涉及 frontend/src/features/auth/AccountControls.tsx、features/explorer/{FileIcon,Explorer}.tsx、features/search/SearchDialog.tsx、app/Workbench.tsx、styles/app.css、package.json/package-lock.json，以及 DESIGN.md 与 THIRD_PARTY.md。使用 @react-symbols/icons 1.4.1（MIT）自动识别文件名和扩展名；未知文件使用默认图标。配额细条位于数字下方并铺满侧栏内容宽度，底栏固定左右分区。

本次执行（与 MULTIUSER.md 的上一轮历史记录分开）：

- cd frontend; npm run build、npm run lint 通过；npm test 的 20 项通过。构建仍有既有编辑器大分块提示。
- CHROME_BIN 指定本机 Chrome；npx playwright test tests/browser/users.spec.ts tests/browser/mobile.spec.ts tests/browser/search.spec.ts tests/browser/recovery.spec.ts：13 项通过，覆盖配额失败恢复、搜索、手机和本机恢复稿。
- python scripts/copy-dist.py、Go 生产二进制构建通过，已更新本地 127.0.0.1:8080。本轮没有清理用户数据。
- 生产页面探针使用浏览器路由模拟文件树与配额，未向实际工作区写入样本文档。验证 0% / 50% / 超额封顶、12 种不同文件图标、最终全宽条高度 4px；1440/1024/390 三视口明暗主题均无 axe 违规及页面横向溢出。截图与结果在 artifacts/ui-polish-*.png、artifacts/ui-polish-smoke.json。
- 首次探针发现恢复入口可见名称与辅助名称不一致，已改为“浏览器恢复稿”，最终扫描通过。最终底栏 DOM 探针切换空/未保存/保存中/保存失败状态，恢复按钮和整条栏的几何位置保持一致；此前实际编辑保存探针也验证了状态切换稳定。

本次为界面调整，正文读写与认证协议无变更；未执行新的容器/备份或硬件手机验收，历史结果不作为本轮执行证据。图标只做类型提示，不提供额外文件预览能力；资源本地构建，不上传文件名到外部服务。

## 2026-10-17 上传错误提示修复

涉及 services/{api,upload-limits}.ts、tests/browser/attachments.spec.ts 与 API.md。上传前读取实际类型大小限制和剩余配额；非 JSON 的 413 显示明确拒绝原因，无响应不再直接归为网络中断。实际执行 npm run build、npm run lint、npm test（20 项）通过；CHROME_BIN 指定本机 Chrome，npx playwright test tests/browser/attachments.spec.ts tests/browser/mobile.spec.ts 的 6 项通过。新增浏览器用例使用小限额模拟大文件条件，验证附件/图片/PDF超限和配额不足时零上传请求、HTML 413 明确提示、原件下载入口保留。生产前端嵌入与 Go 构建通过并更新本地服务。本轮未修改大小上限、服务端文件写入或配额最终检查；前置检查不能预知代理限制与上传中配额变化，服务端仍为最终裁决。未执行真实大文件弱网/外部代理专项测试。

## 2026-10-17 统一搜索实测

涉及 frontend/src/features/search/SearchDialog.tsx、app/Workbench.tsx、styles/app.css、tests/browser/search.spec.ts、tests/qa/{accessibility,performance}.spec.ts、backend/internal/search/index_test.go 及 SPEC/DESIGN/ARCHITECTURE/API.md。统一入口并发查询名称和正文，按路径去重与补摘要，独立加载/失败，保留选中路径和视口位置。固定结果区高度，避免异步补充导致弹窗重新居中；必要时保留列表尾部滚动余量，下一查询重置。桌面辅助名称包含可见快捷键，手机保持简短。

本次实际执行（不引用历史结果作为本轮证据）：

- cd frontend; npm run build、npm run lint、npm test 通过，单元测试 5 文件共 20 项；构建保留既有大分块提示。
- CHROME_BIN 指定本机 Chrome、PYTHONUTF8=1；npx playwright test tests/browser/search.spec.ts tests/browser/mobile.spec.ts：9 项通过。最后辅助名称修正后单独重跑 search.spec.ts，6 项通过。覆盖双快捷键、真实文件打开与正文保留、异步去重、独立失败、迟到响应隔离、内容先到而名称后到时选择与像素位置保持、错误下继续打开。
- python scripts/copy-dist.py 后，npx playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts：4 项通过，使用 Go 嵌入生产页面，1440×900 / 390×844 明暗主题、axe 与焦点验证。首次检查发现桌面可见快捷键未包含于辅助名称，已修正后全部通过。未重新执行性能用例，其入口选择器同步更新。
- cd backend; go test ./internal/search ./internal/storage 通过（storage 命中缓存），go build -o ../bin/folio-next.exe ./cmd/server 通过。新增真实临时文件测试覆盖 17 种常见文本/配置/源码/无扩展名文件的正文搜索，并排除 NUL、无效 UTF-8、超限文本和 PDF 正文，同时保留二进制名称搜索。
- git diff --check 通过；生产二进制已更新本地 127.0.0.1:8080，健康检查正常。现有用户与工作区数据未清理。

正文索引原已按内容识别，本次未增加扩展名白名单或改变写入/权限协议。默认正文限额仍为 1 MiB；非 UTF-8、含 NUL、PDF/图片、超限正文和未保存草稿不参与正文搜索。搜索结果受异步索引刷新与每类 50 条上限影响，超出会提示缩小查询。未重跑容器、备份、真实手机/读屏器专项验收；本轮测试使用独立临时工作区，不写用户实际文件。

## 2026-10-17 API 驱动索引更新实测

涉及 backend/internal/search/{index,events_test}.go、storage/scan.go、httpapi/{api,entries,attachments,search_events_test}.go，以及 README、SPEC、ARCHITECTURE、API、ROADMAP。取消索引 10 秒轮询与 5 分钟周期重建，改为文件 API 提交受影响路径、每工作区 50ms 合并窗口、串行事务和最新磁盘读取。目录事件覆盖子树，移动核对旧/新路径，256 条独立待处理路径以上合并一次全量核对。启动首次访问工作区、手动重建及不确定结果补偿仍可全量核对；配置变化在启动全量重建时生效。当前任务中常规文件变更竞争最多重读三次，无后台自动重试轮询。

本次实际执行（不以此前统一搜索的记录代替本次验证）：

- cd backend; go test ./... -count=1 全部通过，go vet ./... 通过；新增并发处理中事件测试后，三项增量/队列/并发测试连续运行 5 次通过，最终代码再次执行完整 Go 测试通过。Windows 无符号链接权限的既有样本仍按测试约定跳过，仅代表本机已执行范围。
- 新增真实文件验证：单路径更新不读取无关外部修改、连续通知索引最终正文、中文及含 %/_ 的子树边界、移动/删除后清理、全局文件计数、队列合并与溢出、手动重建不被覆盖、索引处理中新增并发通知不丢失、故障警告不被局部成功掩盖。闲置等待 11 秒跨过原轮询周期，完成时间未变化且外部文件未被索引；手动重建后可搜。关闭并重开同一缓存，验证未发送事件的文件新增/删除及正文上限变化可恢复；这是遗漏事件模拟，不宣称真实断电/进程强杀验收。
- 新增真实 HTTP 链路覆盖正文新建/保存、文件改名、目录移动/回收/恢复、文本上传后正文可搜；失败写入、空目录及账号请求不触发索引；不确定结果通知与未知恢复目标全量补偿有效。既有多账号搜索隔离用例继续通过。
- CHROME_BIN 指定本机 Chrome、PYTHONUTF8=1；cd frontend; npx playwright test tests/browser/search.spec.ts tests/browser/workflow.spec.ts tests/browser/users.spec.ts tests/browser/external.spec.ts：15 项通过（52.4s），覆盖统一搜索、移动工作流、账号隔离与编辑器外部版本保护。后续对索引任务内竞争重读的调整经完整 Go 回归验证。本次未改前端源码，未重跑前端构建、单元或无障碍全套；复用已验证的现有嵌入资源。
- go build -o ../bin/folio-next.exe ./cmd/server 通过；git diff --check 通过。已更新本地 127.0.0.1:8080，健康检查正常，未清理用户文件或账号。

索引仍为最终一致的可重建缓存，任务失败会显示 warning 并保留重建入口，文件保存不因索引失败而回滚。直接宿主目录修改不再自动进入搜索，需手动重建或重启后访问工作区。编辑器版本探测、ETag 条件保存、账号隔离及正文限额不变。首次访问、重建、大目录操作、队列溢出与不确定操作补偿仍有一次性扫描成本；没有持续扫描。未开展新的内存/CPU/磁盘性能压测、Linux/容器/备份或实际崩溃专项验收。

## 2026-10-17 文件大小、正文索引状态与 5 MiB 上限

涉及 backend/internal/config/{config,config_test}.go、search/{index,file_status,file_status_test}.go、storage/scan.go、httpapi/{search,search_events_test}.go；frontend/src/features/search/{FileStatus,SearchDialog}.tsx、app/Workbench.tsx、services/api.ts、styles/app.css 与 tests/browser/search.spec.ts，并同步 README、SPEC、DESIGN、API、ARCHITECTURE、ROADMAP。默认正文索引上限为 5 MiB，环境变量仍可覆盖。底栏显示磁盘文件大小、真实索引状态；仅 pending 临时轮询，保存后的版本改变或手动重建会重新查询。状态接口不重新读取正文/计算摘要，沿用鉴权、工作区隔离和安全路径边界。

本次实际执行：

- cd backend; go test ./... -count=1、go vet ./... 全部通过。新增精确 5 MiB UTF-8 文本可搜“血尸”、5 MiB + 1 字节超限、二进制仅名称、空文本、已保存版本匹配/不匹配、遗漏/排队/故障状态、路径越界、HTTP 实际大小与未登录拒绝等验证。配置测试确认默认值 5 MiB。
- cd frontend; npm run build、npm run lint、npm test（20 项）通过。npx playwright test tests/browser/search.spec.ts tests/browser/mobile.spec.ts 的既有 9 项通过；新增底栏用例最初在 390 宽度遇到既有目录抽屉遮罩，测试补上关闭抽屉的真实操作后单独复跑通过（1 项，9.3s）。覆盖保存前后状态、1440/1024/390 无溢出，以及超限/仅名称/排队/异常/未索引状态和实际上限提示。
- python scripts/copy-dist.py 后运行生产嵌入页面的 npx playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts：4 项通过（15.9s），覆盖 1440×900 / 390×844 明暗、axe、焦点和编辑器语义。Chrome 指定本机可执行文件，PYTHONUTF8=1。
- Go 生产二进制构建和 git diff --check 通过，更新本地 127.0.0.1:8080。仅为验证用户报告的问题，以独立临时登录会话查询现有 TXT 的文件状态及“血尸”搜索，并在完成后退出该临时会话：大小 4,482,566 字节，上限 5,242,880 字节，state=indexed，目标文件命中。未修改用户正文、清理文件或账号，未在日志输出密码、Cookie 或正文片段。

未保存正文不参与索引，底栏大小为已保存磁盘文件大小，不逐键编码正文；直接宿主修改仍需手动重建或重启后访问。超限、非 UTF-8、NUL、PDF/位图仍不索引正文。状态异常可点击打开统一搜索使用既有重建入口；全局索引故障不会因另一路径成功而隐藏。尚未进行新一轮资源占用压测、容器/备份、真实手机或真实读屏器专项验收。

## 2026-10-17 源码拖选与焦点修复

涉及 frontend/src/editors/codemirror/SourceEditor.tsx、editors/theme.ts、styles/app.css、tests/browser/selection.spec.ts 与 DESIGN.md。紫框来自源码编辑容器的 focus-visible 外框，已移除并以光标/行号颜色保持键盘焦点可辨。当前行不透明底色会遮挡 CodeMirror drawSelection 的后方选区层，已移除源码当前行插件，并将共享代码主题当前行底色设透明；深色选区调整为 #465a86。

本次 npm run build、npm run lint 通过；Chrome/PYTHONUTF8 指定本机环境，npx playwright test tests/browser/selection.spec.ts tests/browser/line-endings.spec.ts 的 4 项通过。真实鼠标跨行拖选在明暗主题均可见、无整圈外框，选择和键盘退出不修改正文，CRLF/CR/混合换行与恢复保真回归通过。最后将行号焦点提示从边线改为颜色后，重新构建并单独重跑 selection.spec.ts，2 项通过；截图位于 frontend/test-results/source-selection-{light,dark}.png，人工检查了深色拖选截图。

生产嵌入页面的 4 项 accessibility.spec.ts 通过（明暗、桌面/手机、axe 与键盘焦点），随后最后的行号提示颜色调整由拖选测试再次验证。python scripts/copy-dist.py、Go 构建、git diff --check 通过，已更新本地 127.0.0.1:8080。未修改用户正文或清理工作区；本次只调整编辑器呈现，不新增文件写入、安全权限或索引行为，未重新验收真实手机、其他浏览器或实际读屏器。

## 2026-10-17 Markdown 焦点与段落拖放修复

涉及 frontend/src/editors/milkdown/RichEditor.tsx、styles/app.css、tests/browser/rich-drag.spec.ts 与 DESIGN.md。此前仅移除源码焦点框，富文本仍有 ProseMirror:focus-visible 外框，本次一并移除，工具栏控件焦点与编辑光标保留。真实鼠标测试确认 Crepe 手柄拖到段落下沿原本可用，但拖入末尾空白不会移动：空白位于可编辑元素外，未收到正文 drop。修复为富文本根节点和 Milkdown 容器 flex 延展至可用高度，末尾留白放入 ProseMirror 内部，继续使用库原生拖放/历史事务。

本次实际执行 npm run build、npm run lint、python scripts/copy-dist.py、Go 生产构建和 git diff --check 均通过。Chrome/PYTHONUTF8 指定本机环境，npx playwright test tests/browser/rich-drag.spec.ts tests/browser/workbench.spec.ts tests/browser/mobile.spec.ts：14 项通过（27.6s）。新增测试以真实鼠标从六点手柄拖至段落下沿/末尾空白，核对段落重排、磁盘完整 Markdown 和撤销后的完整原文；先确认末尾空白用例在修复前失败，修复后通过。既有 Crepe 序列化快照、转换保护、快速切换和三视口布局、手机恢复/上传用例通过。

Go 嵌入生产页面的 accessibility.spec.ts 明暗桌面/手机 4 项通过，包含 axe、编辑器语义与 Escape/Tab 焦点路径。已更新本地 127.0.0.1:8080，未清理工作区或改写用户正文；修复不改变 ETag/保存队列或 Markdown 序列化。不宣称已验证所有复杂嵌套块拖放、跨编辑器拖放、真实触屏手势或其他浏览器。

## 2026-10-17 搜索结果正文定位与标签关闭菜单

搜索定位涉及 frontend/src/features/search/{SearchDialog,location}.ts(x)、editors/{registry,codemirror/SourceEditor,milkdown/RichEditor,milkdown/search-location}.ts(x)、app/Workbench.tsx 与 tests/browser/search-location.spec.ts。搜索结果传递关键词，打开后在当前缓冲中定位首次命中并选中；CodeMirror 使用实际 LF 文档坐标，Crepe 就绪后使用 ProseMirror 文本节点位置（包含强调等行内节点）。递增请求身份与路径过滤迟到响应；定位 effect 独立于编辑器创建，不因查询重建实例、更新正文或提交保存。纯名称命中正常打开，正文已变化或关键词只在不可见 Markdown 源码中时明确提示，不加载旧正文覆盖草稿。

标签菜单涉及 features/tabs/TabMenu.tsx、Workbench.tsx、styles/app.css、package.json/package-lock.json 与 tests/browser/tab-menu.spec.ts。使用已安装并查阅类型的 @radix-ui/react-context-menu 2.4.1（MIT），复用 Radix 和现有 context-menu 样式；提供关闭、关闭其他、关闭右侧标签页、关闭已保存、关闭所有，右键目标决定作用范围。批量串行执行既有 flush/remove，检查会话身份并保留失败/冲突/上传/锁定目标，干净目标正常关闭；只关闭会话，不调用删除接口。菜单使用非模态，Escape/操作后焦点返回，边界项禁用。相关设计、产品与架构/路线图已同步。

本次实际验证：

- npm run build、npm run lint、npm test（20 项）、python scripts/copy-dist.py、Go 生产构建与 git diff --check 通过。构建保留既有编辑器大分块提示。
- 新增搜索定位与原有统一搜索组合 10 项通过；另跑 search-location.spec.ts、workbench.spec.ts、line-endings.spec.ts 共 15 项通过（28.9s），覆盖 CRLF 文档 500 行后的中英文/ASCII 大小写定位、重复搜索实例不重建、未保存正文保留、Markdown 强调文字位置、桌面/手机视口可见、仅名称命中、陈旧索引提示，以及转换和换行保护。
- 最终 npx playwright test tests/browser/tab-menu.spec.ts tests/browser/search-location.spec.ts tests/browser/workflow.spec.ts：10 项全部通过（29.6s）。覆盖全部五种关闭动作、非当前标签右键目标、磁盘文件仍存在、关闭已保存跳过草稿、混合批量关闭时失败草稿保留/干净会话关闭、修复保存后重试关闭、Shift+F10、禁用边界、Escape 焦点返回，以及菜单明暗 axe 无违规。测试使用本机 Chrome、PYTHONUTF8=1 和独立临时工作区。
- 验证中发现模态菜单隐藏工作区的语义会触发 aria-hidden-focus，已改为非模态后通过；主题扫描启用减少动态效果并等待主题属性，避免抓取已有 140ms 颜色过渡的中间帧。手机视口测试显式等待并关闭既有目录抽屉，避免快捷键被抽屉占用。没有通过排除规则隐藏 axe 问题。
- 已将生产二进制更新到本地 127.0.0.1:8080，健康检查正常；未清理用户数据，未修改后端正文/索引/鉴权协议。本次未重跑 Go 测试（无 Go 源码变更），未执行新的容器、备份、性能压测或实际读屏器验收。

定位目前选择首次可见正文命中，不提供下一处/上一处或全文命中列表。Markdown 标记、链接地址等不可见源码命中需切换源码后重搜，当前内容已无关键词时会提示。批量关闭非原子操作：部分标签可关闭，失败目标保留并汇总，不静默丢失正文；关闭已保存不会顺带保存新输入。


## 2026-10-17 系统设置与系统状态

涉及 backend/internal/auth/system.go、httpapi/{accounts,api,users,system,system_test,volume_windows,volume_linux,volume_other}.go、search/{index,file_status}.go，frontend/src/features/auth/{SystemSettings,SystemPanel}.tsx、app/Workbench.tsx、services/api.ts、styles/app.css、tests/browser/system.spec.ts，并同步 README、SPEC、DESIGN、ARCHITECTURE、API、ROADMAP。

管理员新增六项现有资源限制的持久化在线设置，以及 Go 运行时/内存/Heap/Stack/内部内存/GC 状态。设置写入 app.db 后应用到现有和后续工作区，索引上限使用原子值并触发串行全量重建；不改变正文、ETag、配额和账号隔离。状态默认 5 秒刷新，可暂停；目录大小/数量为显式扫描，卷空间使用 Windows/Linux 原生接口，无后台目录轮询。

本次实际执行：

- cd backend; go test ./... -count=1、go vet ./... 全部通过。新增真实 HTTP/SQLite/文件测试覆盖匿名和普通用户拒绝、CSRF、合法/非法配置、非法值不改变生效限制、现有与新打开工作区、文本限额拒绝、索引降低后排除/提高后重建、运行状态和磁盘返回，以及关闭并重建 Accounts 后持久配置覆盖启动默认值。Windows 既有链接权限样本仍按测试约定跳过。
- cd frontend; npm run build、npm run lint、npm test（5 文件、20 项）通过，保留既有大分块构建提示。python E:/folio/scripts/copy-dist.py 与 Go Windows 生产构建通过；GOOS=linux GOARCH=amd64 的服务器交叉构建通过，仅证明编译，未执行 Linux 运行验收。
- 最终 npx playwright test tests/browser/system.spec.ts tests/browser/users.spec.ts tests/browser/mobile.spec.ts：7 项通过（28.0s）。新用例验证保存与刷新读回、实际附件超限 413、保存 500 保留表单输入、运行时/卷状态，以及 1440/390 明暗两页 axe 无违规和无外壳溢出；既有用户管理、权限、配额、自助改密、编辑器保留、触屏上传/恢复回归通过。测试使用独立临时工作区，并在用例末尾恢复其原配置。
- 嵌入生产资源的 npx playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts：明暗桌面/手机共 4 项通过（16.4s）。人工查看了系统状态深色桌面与系统设置浅色手机截图，使用紧凑列表且无横向溢出。截图位于 frontend/test-results/system-*.png。
- 验证发现切换到手机断点时，已隐藏的工作区仍可产生文件抽屉 portal 遮住系统设置，已在工作区目录抽屉显示条件中加入路由检查，保留编辑器实例。其后补充路由 hook 曾误用未安装的 react-router-dom，构建明确失败；改用本项目已安装的 react-router 后构建与最终回归通过。一次从仓库根目录误运行 Playwright 未执行用例，已改在 frontend 执行并将该次生成结果移至 artifacts/system-root-playwright-error；最终通过结果以上述命令为准。
- git diff --check 通过；本地生产二进制更新至 127.0.0.1:8080 并健康检查正常。更新使用确定 PID 的既有本地进程，未清理或修改用户工作区文件和账号。

限制：内存为 Go 分配器指标，不等于 RSS/宿主物理内存；逻辑 CPU 数不表示实时 CPU 利用率。索引计数只覆盖已打开工作区。目录统计是并发文件变化期间的近似逻辑大小，不是磁盘占块/配额；包含根目录，跳过链接/特殊文件，扫描失败显式报错。两个目录同卷时显示相同容量，不能相加；其他平台仅卷容量明确不可用。降低文本限制可能使现有超限文件暂不能编辑，文件保留可下载并可恢复上限；在途上传沿用其开始时限额快照。已保存系统设置优先于环境变量，未提供远程重启或复杂监控。没有新的资源压测、容器/备份或真实读屏器验收。


## 2026-10-17 手机行号与底栏裁切

涉及 frontend/src/styles/app.css、tests/browser/mobile-layout.spec.ts 和 DESIGN.md。缩小手机源码行号与左右留白；底栏由可换行 flex 改为明确两行网格，修复宽度计算加 gap 导致第三行裁切，保持文件大小/索引可见与恢复稿独立点击区。不改正文缓冲、编辑器实例或保存协议。

本次 npm run build、npm run lint、python E:/folio/scripts/copy-dist.py、Go 生产构建、git diff --check 通过。既有 mobile.spec.ts（3 项）及 search.spec.ts（7 项）全部通过；新增 mobile-layout.spec.ts 单独通过（1 项，4.6s），使用 12000 行真实文本，在 320/390/430 宽度核对五位行号区域小于 46px、正文左起点小于 58px、底栏恒定 64px、所有状态/入口完整落在栏内且互不遮挡，并实际打开恢复弹窗。人工查看 390 宽度截图，正文宽度增加、底部大小和索引不再被裁切。

新增用例初次未等待登录完成即请求大正文，出现代理 ECONNRESET/502；修正为等待已登录界面后执行 API 请求，并缩短测试文本但保留五位行号覆盖，最终通过。嵌入生产资源的 accessibility.spec.ts 明暗桌面/手机 4 项通过。测试使用临时工作区，未修改用户文件；已更新本地 127.0.0.1:8080 并检查健康。未重跑 Go 单元测试（无 Go 代码变更），未验证真实手机软键盘、系统安全区或其他浏览器。


## 2026-10-17 手机底栏改为单行与行号字号对齐

涉及 frontend/src/styles/app.css、app/Workbench.tsx、tests/browser/mobile-layout.spec.ts 与 DESIGN.md。行号恢复为正文相同字号和行高，同时进一步减小水平留白；底栏从 64px 两行改为 41px 单行，恢复稿文字在手机折叠为具名图标，数量仍可见，缓存失败文字替代普通保存状态。没有更改正文、保存与恢复逻辑。

本次 npm run build、npm run lint、python E:/folio/scripts/copy-dist.py、Go 生产构建与 git diff --check 通过。npx playwright test tests/browser/mobile-layout.spec.ts tests/browser/mobile.spec.ts：4 项通过（15.0s）；更新后的 12000 行样本在 320/390/430 下验证行号与正文字号/行高一致、底栏恒定 41px、所有信息完整包含于栏内、状态与索引位于同一水平中心、无相互遮挡，以及恢复图标可实际打开弹窗；既有触屏编辑/上传/恢复回归通过。人工查看 390 宽度截图确认行号首行对齐和单行底栏。嵌入生产页面的 accessibility.spec.ts 明暗桌面/手机共 4 项通过（16.6s）。已更新本地 127.0.0.1:8080 并健康检查正常。

本次仅前端布局及标签包裹调整，无 Go 源码变化，未重跑 Go 单测或前端纯逻辑单测；没有清理用户文件，未新增网络/磁盘权限。真实手机软键盘、安全区和其他浏览器仍未专项验证。


## 2026-10-17 空白页底栏定位与恢复说明

涉及 frontend/src/styles/app.css、features/recovery/DraftRecovery.tsx、tests/browser/mobile-layout.spec.ts 和 DESIGN.md。手机底栏三个区域显式指定网格列，修复未打开文件时恢复图标自动填入第二列；简化恢复窗口说明和空列表文案，无记录时不显示选择指引，不改变恢复、保存或删除逻辑。

本次 npm run build、npm run lint、python E:/folio/scripts/copy-dist.py、Go 生产构建和 git diff --check 通过。npx playwright test tests/browser/mobile-layout.spec.ts tests/browser/recovery.spec.ts：6 项通过（24.2s），新增空白页按钮右边缘位置断言，既有手机布局、恢复保存、失败另存、双页面隔离、禁止存储提示及重启独立浏览器读取草稿回归通过。已更新本地 127.0.0.1:8080，健康检查正常，未修改用户文件。无后端逻辑变更，未重跑 Go 单测或全套无障碍检查；真实手机与其他浏览器仍未专项验证。

## 2026-10-17 右侧大纲与文本缩略图

涉及 frontend/src/app/Workbench.tsx、editors/registry.tsx、editors/{codemirror/SourceEditor,milkdown/RichEditor}.tsx、editors/navigation/{headings,SourceNavigation,RichNavigation}、styles/app.css，以及 navigation.spec.ts、headings.test.ts；同步 SPEC、DESIGN、ARCHITECTURE 与 ROADMAP。顶栏主题/快捷键旁提供开关，Markdown 按原生标题位置定位，其他文本提供主题化 Canvas 缩略图与可视范围。面板刷新不重建编辑器、不提交正文变更。

本次实际执行（不沿用历史验收）：

- cd frontend; npm run build、npm run lint、npm test 全部通过（6 文件、21 项）。构建保留已有大分块提示，lint 最终无告警。
- npx playwright test tests/browser/navigation.spec.ts tests/browser/workbench.spec.ts tests/browser/line-endings.spec.ts：12 项通过；另跑 navigation.spec.ts、search-location.spec.ts、selection.spec.ts 共 7 项通过。最终增加富文本面板 axe 与滚动区域键盘入口后，navigation.spec.ts + workbench.spec.ts 重新运行 10 项全部通过（15.8s）。覆盖富文本/源码重复标题定位、实时修改与撤销、开关不重建、磁盘正文未被导航改写、源码追加标题、JSON 末行键盘定位、1440/1024/390 无溢出、面板 axe、换行保真与既有搜索/选区保护。
- python scripts/copy-dist.py 与 cd backend; go build -o ../bin/folio.exe ./cmd/server 通过，产物已包含新前端。使用独立临时工作区，没有启动或重启日常工作区服务器，没有修改用户文件或账号。
- 已人工查看浅色桌面大纲、深色桌面与手机缩略图截图，最终截图位于 artifacts/navigation/。最终 npx playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts：生产嵌入页面明暗桌面/手机 4 项全部通过（15.5s）。git diff --check 通过。

验证过程明确修复了源码和富文本在长文跳转后滚动区域缺少键盘入口的问题（axe scrollable-region-focusable），没有排除规则。开发服务在快速切模式/缩放流程中出现一次 CodeMirror “Measure loop restarted more than 5 times” 测量提示，用例与实际定位均通过，尚未开展连续缩放压力验证。早期编辑脚本因 Windows 默认编码或相对目录错误明确失败，已改用 UTF-8 与正确路径后构建复核通过。

限制：超长文本缩略图每像素区域抽样，长行最多绘制前 100 字符；语法强调沿用已加载语法树，仅用于导航，不是全文可读预览。源码大纲标题保留行内 Markdown 标记，富文本显示解析后文字。当前不提供标题折叠树、滚动自动高亮标题或拖拽缩略图；图片/PDF/二进制无大纲或文本缩略图。不改变正文、序列化、ETag、恢复或服务端权限；没有新增外部请求/执行内容入口。未重跑 Go 单测（无 Go 代码变化），未做新增性能压测、真实触屏、其他浏览器或真实读屏器验收。


## 2026-10-17 抽象缩略图与滚动绘制分离

本轮替代上一节的迷你字体实现。涉及 SourceNavigation.tsx、SourceEditor.tsx、app.css、navigation.spec.ts 及 SPEC/DESIGN/ARCHITECTURE/ROADMAP。移除 fillText 与语法树遍历，改用采样行长度/缩进矩形；内容变化、尺寸或主题变化才重画 Canvas。滚动用 requestAnimationFrame 更新独立 DOM 遮罩，选择位置没变化时不重复更新 React 状态；画布 DPR 最大为 2。开关、正文与点击/键盘跳转逻辑保留。

本次实际执行：npm run build、npm run lint、python scripts/copy-dist.py、Go Windows 生产构建及 git diff --check 通过。npx playwright test tests/browser/navigation.spec.ts tests/browser/line-endings.spec.ts 共 4 项通过（17.6s），包括三视口/面板明暗 axe、原生编辑器/换行回归和新增约 2.4 MiB、十万行样本。新增测试拦截实际 Canvas 调用，确认无字体绘制、每次矩形数量不超过 ceil(面板高度 / 3)、滚动并等待超过 120ms 后 Canvas 绘制次数不增加，以及主题切换、编辑追加第 100001 行后重新绘制和行数更新。初版测试把挂载与布局变化的两次绘制累计当成单次预算，断言失败；改为每次 Canvas 重置分别计数，并单独记录绘制总次数，最终通过，未放宽单次绘制预算。

已人工查看 artifacts/navigation/navigation-abstract-large.png，抽象线条与可视范围显示正常。构建保留既有大分块提示，快速模式/布局测试仍可出现已记录的 CodeMirror 测量提示。未改变磁盘正文、恢复、ETag 或接口权限；没有新增外部请求/内容执行入口。样本测试验证处理量与不重绘行为，不等于跨设备 CPU/内存/帧率基准；抽样可能略过部分行，超长行仅前 100 字符参与形状计算，不再显示语法颜色。无 Go 源码变化，未重跑 Go 单元或新增真实手机/其他浏览器测试。本轮未启动/重启日常工作区服务器，产物 bin/folio.exe 已更新。

本轮生产嵌入资源：npx playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts，明暗桌面/手机 4 项通过（15.4s）。


## 2026-10-17 缩略图视窗拖动

本轮涉及 frontend/src/editors/navigation/SourceNavigation.tsx、styles/app.css、tests/browser/navigation.spec.ts，及 SPEC/DESIGN/ARCHITECTURE/ROADMAP。补齐按住视窗拖动、轨道点击后继续拖动、抓取位置不跳动、Pointer Capture 越界拖动与上下限位；滚动范围按 scrollDOM 实际高度映射，12px 最小视窗仍能拖至首尾。鼠标/指针动作和键盘定位均只滚动，不改变编辑光标、正文、历史或保存状态；滑块辅助值跟随滚动位置。手势使用每帧最后位置，不增加 Canvas 重绘；松手、pointercancel、丢失捕获、关闭面板均清理状态和动画帧。CSS 使用 grab/grabbing 与 touch-action:none。

本次实际执行（不引用前轮测试作为本轮结果）：

- cd frontend; npm run build、npm run lint 通过。构建保留既有大分块提示，最终 lint 无告警。中途 lint 指出回调直接赋值 props 所属 DOM 属性，改为原生 scrollTo 后检查通过。
- npx playwright test tests/browser/navigation.spec.ts tests/browser/selection.spec.ts：4 项通过（19.3s），覆盖既有导航/主题/手机布局与源码拖选。随后加入手势中断/卸载覆盖并修正滑块辅助值及键盘滚动后，navigation.spec.ts 单独复跑通过；最终版本结果另记。
- 十万行测试用真实鼠标按住视窗、分步移动至轨道外和上下边界，断言按下不跳动、持续滚动到文件首尾、松手后不再跟随、轨道点击有效、拖动不增加 Canvas 绘制次数，并直接核对磁盘正文。人工 dispatch 的 pointercancel 单独验证中断清理和释放捕获；程序关闭处于拖动中的面板后继续移动/松手，再打开确认光标恢复且无 pageerror。后两项为故障/生命周期注入，不冒充真实触摸或系统取消手势验收。
- python scripts/copy-dist.py 与 cd backend; go build -o ../bin/folio.exe ./cmd/server 通过。使用独立临时测试目录，没有启动/重启日常服务器或修改用户正文和账号。

限制：真实触摸设备、笔、其他浏览器与跨设备帧率尚未验证；很长或换行高度差异大的文本仍受 CodeMirror 原生高度估算/布局影响。十万行大幅滚动时开发日志仍有已记录的 “Measure loop restarted more than 5 times” 提示，测试定位与边界断言通过，不能据此声称所有设备持续 60 FPS。无后端源码变更，未重跑 Go 单元测试；没有新增文件操作、网络请求或鉴权入口，ETag、恢复和未保存正文保护保留。

最终版本实际复跑：npx playwright test tests/browser/navigation.spec.ts：2 项通过（10.7s）；npx playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts：明暗桌面/手机 4 项通过（15.7s）。git diff --check 通过。


## 2026-10-19 个性化

变更涉及 Workbench.tsx、styles/app.css、新增 stores/appearance.ts、features/appearance/AppearanceDialog.tsx 与 tests/browser/appearance.spec.ts，同步 SPEC/DESIGN/ARCHITECTURE/ROADMAP。顶栏新增模态入口，宽度 800/1200/1600px（默认 1200）、字号 14/16/18px（默认 16）、恢复默认、本机持久化及失败重试提示。宽度仅作用于 Markdown 富文本；手机宽度铺满、字号最小 16px。保留原生单选键盘操作、Escape 和焦点返回。

本次实际执行：frontend 下 npm run build、npm run lint、npm test（6 文件 21 项）通过；appearance.spec.ts 最终复跑 1 项通过（7.4s），覆盖三档真实正文宽度、字号即时生效、实例标记保留、正文磁盘字节不变、刷新偏好、恢复默认、源码字号、2200/1440/1024/390/320 视口与明暗 axe。workbench.spec.ts、mobile.spec.ts 12 项在组合执行中通过（该次新增个性化用例失败，修正后单独复跑通过）。人工查看 320px 截图后将选项改为上下排列并再次验证。python scripts/copy-dist.py 通过。

验证早期错误：模态框使背景编辑器在辅助树中隐藏，测试定位需显式 includeHidden；主题过渡中间帧引起对比度失败，启用减少动态效果后完整 axe 通过，未排除规则。两次命令误从根目录运行 npm/Playwright 明确失败，已改为 frontend 执行。构建保留既有大分块提示。未启动或重启日常服务器，测试使用独立临时工作区；无后端逻辑变更，未重跑 Go 单元、容器、真实手机或其他浏览器验收。

偏好在当前浏览器跨账号共用，不提供服务器同步；存储受限时只在当前页面生效并明确提示，可重新选择或恢复默认重试。没有修改正文、序列化、ETag、恢复、文件边界或鉴权，没有新增远程请求/内容执行入口。


2026-10-19 个性化界面简化：AppearanceDialog.tsx 移除简介及宽度/字号说明，app.css 缩小弹窗至 400px、去除分组分隔线并收紧间距。保留设置选项、恢复默认与存储错误提示。本次 npm run build、npm run lint、appearance.spec.ts（1 项，7.3s，含明暗 axe 与移动端）、python scripts/copy-dist.py、git diff --check 通过。无正文或权限逻辑变化，不新增内容丢失或安全入口；本机偏好不跨设备同步的限制保持。
