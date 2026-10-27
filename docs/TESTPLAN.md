# 测试与验证计划

## 优先级与基本原则

P0 为正文保留、鉴权、路径隔离和并发；P1 为编辑、上传、搜索和恢复；P2 为视觉与性能。公开暴露前，P0 场景必须有自动覆盖。只使用测试创建的临时目录、账号、浏览器配置和容器，不操作日常笔记。历史验收结果可在 Git 历史查阅；本次执行结果不能沿用历史计数。

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

make qa 使用实际 Go 嵌入构建而非 Vite 开发服务。axe 扫描不排除编辑器，保留未完成项；另读 Chromium AX 正文/名称，验证键盘退出、焦点循环/返回、抽屉交接及关闭标签不删文件。性能实际遍历 1202 文件、搜索、162508 字节 Markdown 与 1060800 字节文本，核对完整保存内容。预算与原始测量输出 artifacts/qa/；真实读屏器验证不在当前范围。

## 故障与容器证据

Linux 子进程用 RLIMIT_FSIZE 产生 EFBIG 部分写入，inotify 观察临时保存后 SIGKILL；只允许完整旧版或新版，不等价真实磁盘满或所有崩溃阶段。

container-review 使用自身 512 KiB tmpfs 获取真实 ENOSPC，日志确认错误，验证旧原文、草稿下载、刷新后显式恢复、释放空间后条件保存；不填满宿主盘。实际 HTTPS 浏览器探针检查 CSP 阻断、恶意链接/内容、远程图片不请求与匿名拒绝。临时测试域名使用保留 .invalid 并拦截，证书只固定临时 SPKI，宿主另验 CA/主机名。

container-test 使用两 bind mount 和独立持久浏览器配置，真正关闭浏览器、重启容器、重新打开后验证正文、会话、外部冲突和回收恢复；第三阶段停服，仅挂 app-data 离线改密，核对旧凭据失效与工作区身份不变。备份 HTTPS 容器演练可用 python3 scripts/backup-test.py --engine podman --container-image <镜像>。

原始容器、安全与备份报告分别在 artifacts/container/、artifacts/security/、artifacts/backup/，必须绑定时间、架构和镜像摘要。旧构建、Wine、交叉编译、仿真和真机结果分别描述；不能冒称断电保证、完整 WCAG 认证、真实手机或 Docker daemon 验证。

## M4 多账号补充

backend/internal/httpapi/accounts_test.go 覆盖用户管理、同名正文/下载/搜索隔离、越权拒绝、工作区身份、并发配额、回收载荷、改名/改密、禁用会话、超额缩小；storage/quota_test.go 覆盖流式读取边界、超额上传无提交、旧正文保留、统计故障、恢复及永久删除计费。frontend/tests/browser/users.spec.ts 覆盖管理表单与普通用户拒绝、改密/禁用撤销、返回工作区保留真实编辑器、axe 明暗扫描与 1440/1024/390 视口截图。

Windows 无符号链接权限时仅跳过链接样本或子场景，其余断言继续；不能将这些结果描述为链接安全实测。Playwright 在 Windows 使用 python、CHROME_BIN 指定本机 Chrome，测试服务器使用独立临时目录和 .exe 后缀；测试用管理员真实目录为临时 workspace/1/。

## 2026-10-17 工作区 UI 优化实测

涉及 frontend/src/features/auth/AccountControls.tsx、features/explorer/{FileIcon,Explorer}.tsx、features/search/SearchDialog.tsx、app/Workbench.tsx、styles/app.css、package.json/package-lock.json，以及 DESIGN.md。使用 @react-symbols/icons 1.4.1（MIT）自动识别文件名和扩展名；未知文件使用默认图标。配额细条位于数字下方并铺满侧栏内容宽度，底栏固定左右分区。

本次执行（与上一轮历史记录分开）：

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


## 彩色差异视图（2026-10-19）

变更涉及 components/diff/{line-diff,DiffView}、RichEditor.tsx、Workbench.tsx、app.css，新增 line-diff.test.ts 并扩展 files.spec.ts、workbench.spec.ts。本次实际执行：

- frontend：npm run build、npm run lint、npm test 通过（7 文件、24 项）；构建仍有既有大分块提示。
- npx playwright test tests/browser/workbench.spec.ts tests/browser/files.spec.ts：13 项通过（25.6s），覆盖转换确认/取消/下载、陈旧预览拒绝、ETag 冲突与不覆盖副本；冲突测试新增红绿差异内容断言。
- 随后扩展转换预览主题/布局检查，单独运行 npx playwright test tests/browser/workbench.spec.ts -g '有损转换保留原文'：1 项通过（5.8s），覆盖明暗 × 1440/1024/390、增删背景不同、外壳无横向溢出、弹窗 axe 无违规；截图 frontend/test-results/diff-*.png，人工查看深色手机截图。

仅改变差异呈现，不修改正文、ETag、恢复和服务端鉴权。匹配超预算时可能把相同行计入替换，明确提示；超 2000 行只呈现前 2000 行，完整正文保留。没有自动合并、逐字高亮、逐块采纳或折叠区展开；可直接核对上方完整正文。测试用独立临时工作区，未修改日常用户文件，未重启日常服务器。无后端源码变化，未重跑 Go 单测、容器、其他浏览器、真实手机与读屏器验收。


## 图片插入与引用导航（2026-10-19）

涉及 Workbench.tsx、codemirror/{SourceEditor,links,links.test}、milkdown/engine.ts、sessions/uploads.ts，新增 tests/browser/editor-references.spec.ts，并同步 SPEC、DESIGN、ARCHITECTURE、ROADMAP。

本次实际执行（不沿用历史结果）：

- npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test 全部通过（8 文件、26 项）。构建仍有既有大分块提示。
- frontend 下 npx playwright test tests/browser/editor-references.spec.ts tests/browser/attachments.spec.ts：最终 6 项通过（26.7s），覆盖两模式粘贴／拖入上传、相对链接与嵌套目录文件实际存在、Ctrl/Meta 文字引用导航、图片导航、上传失败下载入口与重试、既有异步上传切换文件与三种附件预览。
- 补充源码图片引用跳转、失败下载原件字节比对后，npx playwright test tests/browser/editor-references.spec.ts tests/browser/workbench.spec.ts tests/browser/line-endings.spec.ts：14 项通过（33.0s）。涵盖普通点击不导航、Ctrl 与 Meta 两种修饰键、源码与富文本图片导航、失败后下载原件字节一致／重试插入、混合换行保存／撤销／恢复、转换保护和明暗三视口既有 axe 检查。
- python scripts/copy-dist.py、git diff --check 通过。未构建或重启日常 Go 服务，测试使用独立临时目录，没有修改用户正文和账号。

首轮 6 项中源码上传后的图片点击失败：拖图位置使图片嵌套在文字链接中，原捕获事件优先选择了外层链接。已改为优先打开图片原始引用，最终组合回归通过。一次依赖读取误带重复 frontend 前缀明确失败，已改为正确路径核对本机类型和 Markdown 解析树；未据失败命令宣称验证成功。

范围及限制：图片插入仅适用于 Markdown 富文本／源码，图片类型、像素、配额和鉴权沿用服务端校验；Ctrl/Cmd 导航支持标准 Markdown 链接／图片／引用式链接，代码内伪引用不跳转，不支持段内锚点定位或专有 wiki 链接。失败原件只驻留页面内存，刷新前须重试或下载；重试到当前目录并向原会话末尾追加，不恢复原插入位置。原会话已关闭／锁定时明确报告已上传路径，由用户手动插入引用。拖图和剪贴板测试使用合成 DOM 事件与真实上传接口，Ctrl/Meta 点击为 Playwright 鼠标动作；不冒充操作系统剪贴板、Finder/资源管理器拖放、Mac 实机或真实触屏验收。无后端源码变化，未重跑 Go 单测、容器或其他浏览器。保留 ETag、转换确认、未保存缓冲和恢复保护，不新增内容执行或鉴权绕过入口。


## 侧栏拖入引用（2026-10-19）

本轮在上一节未提交修改之上，涉及 features/explorer/{entry-transfer,EntryDrag}、codemirror/SourceEditor、milkdown/{bridge,engine,drop-indicator}、Workbench.tsx、package.json/lock，新增 sidebar-references.spec.ts。使用既有 prosemirror-drop-indicator 0.1.4 的公开接口增加销毁后回调保护，未升级实际包版本。

本次实际执行：npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test 通过（8 文件、26 项）；构建保留既有大分块提示。sidebar-references.spec.ts 两模式用真实 Playwright dragTo 从侧栏拖到正文，核对带中文/空格/方括号的文件名、跨目录相对路径、图片与文字引用、原文保留、原文件存在、不产生上传/移动请求、拒绝目录与无活动令牌的伪造 drop，以及拖放后立即切换模式无 pageerror。workflow.spec.ts 原有三条目录移动/碰撞/菜单测试在本轮组合中全部通过。

验证过程：初版断言把正文中间合法插入引用误认为原文不连续，已改为剔除插入引用后逐字核对原文，两模式均通过。之后暴露上游拖放指示器的 30ms 隐藏回调在销毁后仍写 Milkdown 上下文，已用实例 disposed 生命周期保护替代默认指示器插件，保留原有拖放指示与行为。新增直接依赖声明时离线 npm 命令因 ENOTCACHED 失败，联网安装同一已安装版本成功，锁文件仅增加根依赖声明。

一轮 11 项组合测试中，10 项通过；attachments.spec.ts 的既有新建图片笔记用例在创建后未出现编辑标签，等待富文本超时（30 秒），尚未复现并确定该偶发失败根因；不能把该轮描述为全部通过。最终复跑结果另记。python scripts/copy-dist.py 与 git diff --check 通过；未启动／重启日常服务或修改用户正文。

限制：侧栏一次拖入一个文件，目录不插入引用；仅 Markdown 编辑器，支持 PNG/JPEG/WebP/GIF 扩展名的图片引用，其他扩展名为文字链接，实际预览继续由服务端校验。无批量拖拽、触屏长按或真实手机拖拽专项验收。拖入只执行原生编辑事务，不改变 ETag、恢复和内容安全边界；移动文件后不自动重写引用。无后端源码变更，未重跑 Go 单测、容器或其他浏览器。

最终版本复跑：frontend 下 npx playwright test tests/browser/attachments.spec.ts tests/browser/sidebar-references.spec.ts tests/browser/workbench.spec.ts，14 项全部通过（31.0s），包含既有图片粘贴切换用例、侧栏原生拖拽及指示器卸载后回调检查；无 Milkdown 上下文异常。上述单次创建后无标签的超时仍作为偶发未定位问题保留记录。


## Mermaid 代码块（2026-10-19）

涉及 package.json/lock（新增固定 mermaid 12.2.0）、milkdown/{engine,mermaid-preview,mermaid-preview.test}、app.css、tests/browser/mermaid.spec.ts 与 tests/qa/mermaid.spec.ts；同步 README、SPEC、DESIGN、ARCHITECTURE、ROADMAP。

本次实际执行：

- npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test 通过，9 文件、28 项；构建保留大分块提示，并新增 Mermaid 按需布局分块（ELK 约 1.46 MB），不是初始加载全部执行。
- 开发环境 npx playwright test tests/browser/mermaid.spec.ts 最终 2 项通过（13.4s，尚未加入语言选择用例时），验证流程图/时序图、修改后刷新、源码切换、渲染不写正文、过期结果过滤、错误修复、活动资源拒绝、明暗 × 1440/1024/390 全页 axe 与无外壳溢出。
- 增加图表自然宽度及语言菜单选择后，python scripts/copy-dist.py 通过；npx playwright test -c playwright.qa.config.ts tests/qa/mermaid.spec.ts：生产嵌入资源与原有 CSP 下 3 项通过（14.3s）。测试 API 启动时实际构建 Go 临时二进制，测试目录独立，不启动／重启日常服务器。
- git diff --check 通过。最终截图保存在 artifacts/mermaid/；初次人工查看浅色桌面发现小图放大，已从 SVG viewBox 设置自然显示宽度并加入小图宽度 <600px 断言，手机按可用宽度缩小。

早期检查发现代码块源码缺少辅助名称、预览区域重复 landmark 名称及预览标签对比度不足，已分别通过 CodeMirror contentAttributes、具名 group、较高选择器优先级的主题颜色修复，未排除 axe 规则。首次安装命令误在仓库根目录执行，已中止并在 frontend 安装，未新增根 package.json 或 package-lock.json；未清理既有根 node_modules。一次截图读取在下一轮测试清空 test-results 后失败，已将截图目录调整为独立 artifacts/mermaid。

范围与限制：富文本显示 Mermaid 图表与源码，源码模式仍为原始 Markdown；支持普通 Mermaid 图表，拒绝配置/frontmatter、HTML、外部图片／图标属性、自定义 style/classDef/linkStyle 和 click；无图内链接、导出、缩放／平移或专用 Mermaid 语法高亮。单图 50000 字符与 Mermaid 500 边配置不是 CPU 时间上限，没有新增跨设备性能压测。SVG 作为图片显示，源码仍可读；axe 检查覆盖 UI 语义／对比度，不证明图中文字的视觉对比度或真实读屏器体验。没有改变正文序列化、ETag、恢复、后端鉴权和 CSP，没有新增远程渲染或内容执行入口。未重跑 Go 单元测试（无后端源码变化）、容器、真实手机或其他浏览器。

最终回归：frontend 下 npx playwright test tests/browser/workbench.spec.ts tests/browser/files.spec.ts tests/browser/line-endings.spec.ts，15 项全部通过（34.7s），覆盖正文保存、陈旧 ETag、转换确认／取消、异步切换和混合换行恢复。将截图改存 artifacts 后，生产 Mermaid 流程图/时序图专项再次通过（1 项，8.1s），已人工查看最终浅色桌面与深色手机截图，小图自然宽度和移动布局正常。git diff --check 最终通过。


## Mermaid 渲染防抖（2026-10-19）

本轮在上一节修改之上，涉及 mermaid-preview.ts、app.css、tests/browser/mermaid.spec.ts 与 SPEC/DESIGN/ARCHITECTURE/ROADMAP。将原先随 DOM 变化重新创建加载占位的 120ms 刷新，改为每块独立 600ms 输入防抖；按块缓存已加载图片，在 MutationObserver 阶段恢复到 Crepe 克隆的新节点，等待新图 decode 完成才替换。等待、错误与主题更新保留旧图并明确标注；提示行预留高度。版本与块身份过滤过期任务，卸载清理调度和观察器。

本次实际执行（不沿用上一节计数）：

- npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test 全部通过（9 文件、28 项），构建仍有既有大分块提示。
- 开发环境 npx playwright test tests/browser/mermaid.spec.ts：4 项通过（24.8s）。
- 加入提示行高度及预览切换验证后的最终生产嵌入版本：python scripts/copy-dist.py 通过；npx playwright test -c playwright.qa.config.ts tests/qa/mermaid.spec.ts，4 项通过（23.5s）。前三项覆盖明暗三视口全页 axe、原文／保存保护、错误修复、活动资源限制和语言菜单；新增用例真实连续输入四次、每次间隔 180ms，总时长超过 600ms，核对期间 Mermaid 临时渲染容器创建数为 0、两块最终各渲染一次、逐帧图片数始终为 2、等待期间 src 与预览高度不变，以及预览按钮切换、错误保留旧图。渲染计数来自真实 Mermaid 创建的临时 DOM，未用空渲染 mock 替代。
- git diff --check 通过。测试使用独立临时工作区，未修改用户正文、未重启日常服务。

限制：持续输入时图表保持上次成功结果并显示待更新，停顿后才与代码一致；无法中断已经进入 Mermaid 的同步布局计算，但过期任务不会覆盖新图。600ms 防抖不是复杂图表执行时间上限。保存、ETag、恢复及已有安全限制不变；无后端源码变化，未重跑 Go 单元／容器或新增真实设备性能测试。

## 本机标签恢复（2026-10-22）

新增 features/tabs/useTabRestore.ts 并接入 Workbench；新增 tab-restore.spec.ts，调整 recovery、line-endings、mobile 中刷新后的显式恢复流程：自动打开的磁盘标签须先关闭，已有标签拒绝被草稿替换的保护保留并新增断言。同步 README、SPEC、DESIGN、ARCHITECTURE、API、ROADMAP。

本轮覆盖刷新后的标签顺序／当前项、关闭同步、读取服务器最新正文、跨命名空间记录不打开、缺失文件失败保留与重试、损坏／拒绝存储提示及重置、恢复期间主动选择与继续编辑、明暗三视口错误提示及 axe。正文不写入 localStorage；未保存内容仍从现有 IndexedDB 恢复稿显式打开。重置标签记录不删除草稿。恢复读请求单文件共用 10 秒超时，卸载中止请求并拒绝迟到结果。

验证过程：初次构建因本地缺少锁文件已有依赖失败，npm ci 后构建通过，未修改依赖清单或锁文件。一次浏览器测试在依赖重装期间中止；一轮 15 项中 14 项通过，原恢复用例因新增磁盘标签触发既有拒绝覆盖保护而失败，已加入保护断言并先关闭标签；随后两项恢复流程误点仅焦点可见的关闭按钮超时，已分别改用标签 Delete 与手机标签内关闭标记。一次 npx 错从仓库根执行导致测试框架实例错误，改在 frontend 运行。最终结果另列，不把这些失败轮次记为全部通过。

限制：记录仅在当前浏览器同源保存，不同步设备；同账号多个页面以最后成功保存记录为准，无实时合并。失败路径保留于末尾，重试恢复追加到现有标签末尾；原当前项失败则选择首个可用标签。编辑模式、光标、滚动位置不恢复。清除浏览器数据会丢失标签记录；本功能不是正文备份。所有恢复请求仍经既有鉴权、工作区身份及路径验证，未修改 ETag、正文保存、转换确认或草稿保护。测试使用临时工作区，未启动／重启日常服务或修改用户正文；无后端逻辑变化，不重跑 Go 单元／容器／真实手机及其他浏览器验收。

补充：最后一轮组合中，混合换行与手机 5 项全部通过，异步恢复继续编辑通过。标签专项增加全页 axe 后，源码页面触发既有 page-has-heading-one 最佳实践提示；本次沿用生产 accessibility.spec.ts 的 WCAG 2 A/AA 与 2.1 A/AA 规则集合进行验证，未改动源码页面结构，不声称通过全部 axe 最佳实践规则。

最终本次结果：

- npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test：通过（9 文件、28 项单元测试），构建保留既有大分块提示。python3 scripts/copy-dist.py 与 git diff --check 通过。
- frontend 下 ./node_modules/.bin/playwright test tests/browser/tab-restore.spec.ts：最终 3 项全部通过（23.3s），包括失败路径手动打开后关闭不会复活的回归。最终错误提示全页 WCAG 明暗 × 1440/1024/390 检查通过；截图 artifacts/tab-restore-mobile.png，已人工查看正文错误提示可见、手机换行正常。测试显式等待手机抽屉完成布局后关闭，避免截图被抽屉遮挡。
- recovery.spec.ts 调整后本次 5 项通过；line-endings.spec.ts 与 mobile.spec.ts 修正关闭入口后本次 5 项通过；workbench.spec.ts 本次 9 项通过。以上为各专项在本轮不同执行中的结果，不描述为一次完整套件通过。
- ./node_modules/.bin/playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts：生产嵌入界面明暗桌面／手机 4 项通过（27.7s）；该检查在最后补齐待恢复路径清理逻辑前执行，之后 UI 未变，最终清理逻辑由上列 3 项浏览器专项验证。
- 没有执行 make test 全套或更新／重启日常二进制服务。前端生产资源已构建并复制到嵌入目录，运行中的旧二进制需重新构建启动才能应用。

## 浏览器图标（2026-10-22）

新增 frontend/public/favicon.svg，在 frontend/index.html 声明 SVG favicon，并同步 DESIGN.md。沿用深灰底与浅色斜体 f，纯路径、无字体或外部请求依赖。本次 npm --prefix frontend run build、python3 scripts/copy-dist.py、git diff --check 通过；构建保留既有大分块提示。Chromium 实际解码并渲染生产 dist 中的 SVG，确认生产 HTML 图标引用存在，人工查看 256px 渲染图通过。无正文／会话／鉴权逻辑变化，未新增内容丢失或权限入口；不重跑业务测试，未验证其他浏览器。未重启日常二进制服务，重新构建启动后应用。

## M5 受控分享（2026-10-22）

本轮新增 sharing 服务、storage/bundle.go、httpapi/sharing.go 及配额／账号分派接入；前端新增 RootPage、features/sharing、生产分享专项配置，PDF 查看器允许受控资源 URL；修改离线备份及演练，同步 README、SPEC、DESIGN、ARCHITECTURE、API、ROADMAP。新引入固定 Go 依赖 goldmark 1.8.6，查阅已安装解析器／AST／Reader 接口后使用，不替换 Crepe 或 CodeMirror。最终范围遵循用户收紧决定：含附件只能快照，实时只允许主文件；不加入协作功能。

### 本次实际执行

- npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test 通过，单元 9 文件 28 项。最新前端生产构建及 python3 scripts/copy-dist.py 通过，保留既有大分块提示；git diff --check 通过。
- npm --prefix frontend run test:e2e：全量 75 项通过（6.3 分钟），覆盖原编辑／ETag／冲突／草稿／换行／搜索／拖拽／移动／账号／标签恢复与新分享 3 项。全量执行后收敛了列表分页、中文网络错误、阅读标题样式、无效链接错误页及精确链接定位；没有重复跑整轮 75 项，最终源码另由下列后端和生产专项验证。
- ./frontend/node_modules/.bin/playwright test -c frontend/playwright.sharing.config.ts：最终生产嵌入资源、真实 Go API 和原 CSP 下 3 项通过（22.1s）。覆盖六位前导零密码／错误密码／匿名内容拒绝，递归清单和实时禁用，多模式正文与附件原始字节，修改原件不改变快照，刷新／PDF／下载不扣次数，Mermaid 隔离图片，单文件实时重读，独立账号转存和同名拒绝、撤销后旧资格拒绝，PDF 真实画布、二进制原件及 HTML 不执行。包含公开阅读全页和管理模态框的 WCAG 2 A/AA、2.1 A/AA 明暗 × 1440/1024/390 检查，无外壳横向溢出；未排除具体 WCAG 规则。截图 artifacts/sharing/public-mobile.png、manage-mobile.png 已人工查看，修正标题层级排版。分享管理保留工作区挂载，原 users/appearance 回归通过。
- ./frontend/node_modules/.bin/playwright test -c frontend/playwright.qa.config.ts frontend/tests/qa/accessibility.spec.ts：本轮生产工作区明暗桌面／手机 4 项通过（26.6s）。执行后仅增加了无效分享链接错误页，原工作区 UI 不变；最终分享公开页面和模态框已在上列生产专项重新检查。
- go -C backend test ./...、go -C backend vet ./...：最终通过，未变化的部分包命中 Go 缓存；不是声称重新执行每个历史测试。新增 sharing 9 项测试及 HTTP 边界测试，覆盖快照字节／损坏摘要拒绝、递归／循环／代码伪引用／HTML 拒绝、六位密码和限速、跨账号管理拒绝、CSRF／越界转存／不覆盖、配额与版本冲突、最后一次访问 20 并发只成功一次、重启资格／次数、禁用／撤销／过期、访客令牌跨链接复用、来源工作区变化使实时失效、分页和 10000 条授权容量满时事务回滚不扣次数。
- go -C backend test -race ./internal/sharing ./internal/httpapi ./internal/storage：本轮通过（sharing 4.291s、httpapi 10.714s；storage 命中本轮先前 race 缓存）。该轮包含最终精确链接定位与容量回滚测试；随后仅补了删除载荷后的父目录同步，最终 go test ./... 和生产分享专项再次通过。
- python3 scripts/backup-test.py：本轮完整离线双卷恢复演练通过，包含 SIGKILL 后分享库 WAL 合并、快照及次数保留、源数据不变、恢复清空旧访客资格、恢复后原链接仍可读取快照及后续计数，原账号／正文／附件／回收／搜索／后续条件保存继续通过。报告 artifacts/backup/；仅操作隔离测试目录。

### 失败与修正

初版 RootPage 未接入 JSX 导致 TypeScript 未使用符号错误，接入独立组件后构建通过。首次 PDF／二进制／HTML 生产专项中 PDF 通过、二进制失败：新 ReadBundle 读取字节后未将游标复位，后续元数据读取误把空缓冲识别为文本。已在元数据检测前 Seek(0)，新增二进制类型及字节回归，最终三项通过。初版根引用改写采用候选正则，审查发现可能误改转义示例，已改为包装 Goldmark 链接解析器记录精确源区间、委托 CloseBlock 生命周期，并覆盖 CRLF、转义文字、代码及引用定义原字节；无法安全转换会明确失败，不发布副本。一次 Go 测试误从仓库根执行失败，已使用 go -C backend 正确执行。早期从仓库根启动 Playwright 使截图落到相邻目录，已将截图路径改为 import.meta.url 推导的绝对项目路径并整理本轮生成文件，不保留根 test-results 噪声。

### 边界与未验证范围

全部测试使用临时工作区、账号与浏览器配置，没有修改日常用户正文、没有启动／重启日常服务，未更新运行中的二进制。生产资源已复制到嵌入目录，日常进程须重新构建启动才生效。未重新跑 Docker／外部 HTTPS 代理／真实 Windows 或 ARM／真实手机 IME／其他浏览器及读屏器；headless Chromium 的视口与触屏检查不能代替这些环境。未执行新的跨设备容量、CPU 或大包性能基准；包上限与有限并发不是严格 CPU 时间上限。

单包最多 256 文件、128 MiB，快照计入分享者配额，新旧包切换需要额外完整新包空间；每账号最多 1000 记录，列表 20 条分页（上限 50），全站最多 10000 条有效访客资格。过期／撤销保留快照直到显式删除。已有内容和已转存副本无法收回；配置／内容更新保留已用次数但需要重新进入。禁用分享者拒绝后续读取；已经开始的响应可能完成。实时绑定创建时的根身份和原路径，路径复用显示新内容，根身份改变失效；恢复到新根时快照可继续使用，实时链接需重新创建。只做本地引用，目录／HTML 内资源／远程图片不打包；高级 Markdown 语法不承诺与编辑器完全同版，支持源码／下载核对。极复杂根引用无法安全定位时拒绝转存，可先改相对路径后重新创建或下载原件。文件系统持久性失败、旧快照清理失败等明确报告并保留原件或管理记录，空间异常仍需部署者检查 app-data，不提供强制覆盖或静默降级。

## 创建分享入口与弹窗（2026-10-23）

本次涉及 Workbench.tsx、复用的 features/sharing/ShareDialog.tsx、ShareManager.tsx、app.css、sharing.spec.ts 及 SPEC／DESIGN。当前文件保存／下载旁新增“创建分享”，自动保存并分析主文件，保留编辑器挂载；Markdown 可递归分析后逐项确认附件。弹窗使用文件图标／名称、分享方式、分组限制开关、取消／确定布局；关闭开关提交无该项限制，密码仅支持六位数字并可随机生成。已有保护密码输入留空保留，关闭密码开关移除。成功视图在同一个 Radix 对话框内提供可手动选择的链接和复制失败提示。

本次 npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test 通过（9 文件 28 项）；保留既有大分块构建提示。python3 scripts/copy-dist.py 和 git diff --check 通过。后端未修改，本轮不重复宣称运行 Go 全量、race 或备份演练；前节记录属于历史验证。

首次新增入口测试误用 treeitem 定位实际 button，已修正。截图检查修正了文件身份区与公开阅读页同名样式冲突；成功状态改为原弹窗内切换，避免交替模态框造成焦点／可访问性状态风险。多视口检查后恢复桌面进行管理操作，避免手机文件抽屉遮挡顶栏。未重启日常服务；测试使用隔离账号与目录。仍遵循含附件只能快照、实时单文件及既有公开链接边界，不加入协作功能。

最终生产验证：./frontend/node_modules/.bin/playwright test -c frontend/playwright.sharing.config.ts 中原有 3 项分别通过（9.9s／5.5s／4.4s）；新增入口测试在手机尺寸检查后未恢复桌面，关闭弹窗恢复原文件抽屉，使顶栏无法定位，已修正测试视口顺序。最终 -g 文件工具栏 单独通过（5.5s，合计 7.5s），覆盖自动分析、随机六位密码、到期／次数关闭后的请求值、原正文保留、已有密码保留与显式清除；不是声称早期失败的整轮 4 项已全部通过。模态框明暗 × 1440／1024／390 的 WCAG 2 A/AA、2.1 A/AA 检查零违规。artifacts/sharing/create-desktop.png、create-mobile.png 已人工查看。限制项及当前部署环境边界与前节相同。

### 公开入口文案精简（2026-10-23）

按用户要求移除 SharePage.tsx 入口的访问计数／30 分钟刷新说明，仅调整展示文案，后端计数规则保留。此次 npm --prefix frontend run build、python3 scripts/copy-dist.py、git diff --check 通过；构建保留既有大分块提示，未重复执行浏览器／后端测试。未修改正文与鉴权，未重启日常服务。额外模态框的具体范围待用户确认后再调整。

### Markdown 附件二级模态框（2026-10-23）

按用户确认将完整清单移入“选择附件”第二层 Radix Dialog。涉及 ShareDialog.tsx、新增 ShareAttachmentsDialog.tsx、app.css、sharing.spec.ts、SPEC／DESIGN。主窗口只展示是否包含附件及数量，子窗口负责递归分析、勾选、失败引用提示和确认；取消不应用临时选择，关闭后返回入口焦点。重新打开按原白名单勾选，新增引用不自动选中；含附件仍强制快照，提交前继续携带已确认文件版本。分析错误保留重试入口，主文件不能取消，子窗口不会自行创建链接。

本轮实际执行 npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）及 python3 scripts/copy-dist.py 均通过，保留既有大分块提示。./frontend/node_modules/.bin/playwright test -c frontend/playwright.sharing.config.ts 完整 4 项通过（29.8s），覆盖二级窗口确认／取消／重开／焦点返回、主窗口不含内联清单、实时禁用、快照及公开读取／转存／撤销、入口和访问设置回归。新增子窗口在 1440／1024／390 × 明暗主题下执行 WCAG 2 A/AA、2.1 A/AA 检查零违规；artifacts/sharing/attachments-desktop.png、attachments-mobile.png 已人工查看。git diff --check 通过。

仅调整前端交互，未修改后端、正文或已创建的分享记录；测试使用隔离目录和账号。未重跑后端、备份、其他浏览器或真实读屏器验证，未重启日常服务；日常部署须重新构建启动。

### 分享密码六格输入（2026-10-23）

SharePage.tsx 接入新增 SharePasswordInput.tsx，app.css 添加六格样式，DESIGN 同步说明。用一个原生 password 输入框负责键盘／选区／整段粘贴，六格仅作视觉呈现，保留前导零、数字键盘与显式提交；输入数字显示圆点，错误用关联提示与边框标示，验证中禁用输入并防止重复提交。未新增依赖，未改后端鉴权、计数或工作区正文。

本轮 npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）、python3 scripts/copy-dist.py、git diff --check 通过；构建保留既有大分块提示。./frontend/node_modules/.bin/playwright test -c frontend/playwright.sharing.config.ts 完整 4 项通过（31.5s），新增真实连续输入／方向键退格／剪贴板粘贴及前导零验证，错误密码提示和最终正确密码访问通过。密码入口在 1440／1024／390 × 明暗主题下 WCAG 2 A/AA、2.1 A/AA 零违规；artifacts/sharing/password-desktop.png、password-mobile.png 已人工查看。其余分享附件／转存／撤销及管理入口回归通过。

测试采用隔离账号与目录，未重启日常服务；未重跑后端或真实手机键盘／读屏器／其他浏览器验证，Chromium 数字键盘声明与视口检查不代替真实设备验收。

### 满六位自动验证与明文显示（2026-10-23）

按用户调整 SharePasswordInput.tsx、SharePage.tsx 和 DESIGN：六格明文显示数字，输入或粘贴满六位时直接用本次输入值验证，不等待 React 状态更新；同步请求锁防止自动验证与手动提交重复请求。未满六位不自动发送，验证中禁用输入，错误后恢复输入并聚焦选中，保留按钮用于重试。未修改后端密码策略、限速、访问计数或正文。

本次 npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）、python3 scripts/copy-dist.py 与 git diff --check 通过。生产 ./frontend/node_modules/.bin/playwright test -c frontend/playwright.sharing.config.ts 完整 4 项通过（31.7s）；确认五位及退格不发请求、键入错误六位自动请求一次、明文六格和错误关联、粘贴含前导零的正确密码自动进入且总请求数恰为两次，已登录访问同样无需点击。原多视口明暗无障碍及其他分享回归通过；password-mobile.png 已人工查看。构建保留既有大分块提示，未验证真实手机键盘／其他浏览器，未重启日常服务。

### 分享暂停／继续（2026-10-23）

ShareManager.tsx 将单向“撤销”改为按 disabled 状态显示“暂停／继续”，请求期间禁用状态按钮，成功后刷新列表，状态显示“已暂停”；ShareDialog／SharePage 和服务端失效文案同步。沿用 disabled 协议与 version 条件更新，不更换链接、不重置密码、快照、期限或次数。service.go 修正更新校验：允许原样保留已过期的 expiresAt，仍拒绝新建或改设过去时间；不再像旧撤销操作那样清空到期时间。SPEC／DESIGN／API／ARCHITECTURE／ROADMAP 同步当前语义，历史验收中的“撤销”保留作为历史记录。

本轮 npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）、python3 scripts/copy-dist.py 与 git diff --check 通过，保留既有大分块提示。go -C backend test ./internal/sharing ./internal/httpapi 通过（1.137s／4.139s），新增暂停后拒绝旧资格、继续后能重新进入、ID／载荷／有效期／次数保留、已过期暂停与继续均不重开、新建／改设过去时间拒绝的服务测试。./frontend/node_modules/.bin/playwright test -c frontend/playwright.sharing.config.ts 完整 4 项通过（33.2s），新增暂停／继续按钮切换、同链接保留密码和已用次数、次数已用完时继续仍无法进入的真实接口验证。

暂停不收回已下载或已转存副本，继续后旧访问资格不恢复，访客需重新进入；过期或次数用完需另行在管理中调整限制。未修改工作区正文、未清理快照、未重启日常服务；本次未重复后端全量／race／备份或真实移动设备验证。

### 到期自动删除（2026-10-23）

用户明确授权将到期分享视为可丢弃记录：新增 sharing/expiration.go，service.go 复用删除流程，启动及每 30 秒后台回收，到期记录／访客资格／快照一起删除并释放配额；列表读取立即清理当前账号到期记录，前端 ShareManager 每 30 秒刷新。每轮最多 1000 条，积压随后续轮次处理；失败明确记录日志，列表清理失败返回可重试错误，记录保留供下轮重试，不先丢失载荷定位。关闭先等待后台退出。Save 拒绝旧窗口恢复已到期分享，并尝试回收，原工作区文件不动。暂停／次数用完本身不回收。SPEC／DESIGN／API／ARCHITECTURE／ROADMAP 同步，覆盖前节“过期可再调整限制”的历史规则。

本轮 go -C backend test ./internal/sharing ./internal/httpapi 最终通过（1.174s／4.571s）；go -C backend test -race ./internal/sharing 通过（4.439s），go -C backend vet ./internal/sharing ./internal/httpapi 通过。新增 expiration_test.go 覆盖到期暂停记录删除、载荷／授权／配额释放、原文件保留、永久暂停及次数用完不误删、列表清理、重启回收、失败保留记录后重试；更新暂停测试覆盖旧页面不能续期恢复到期记录。测试直接设置记录到期，不依赖 30 秒睡眠。npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）、python3 scripts/copy-dist.py 和 git diff --check 通过，保留既有大分块提示。生产分享专项 4 项通过（31.7s）；该轮之后仅收紧了过期记录 Save 分支并更新对应 Go 测试，最终后端专项及 race 已重新通过。

仅删除用户授权的到期分享快照与元数据，已有转存副本和工作区正文保留。未重新运行全量后端／备份演练／其他浏览器；未重启日常服务。停服期间到期的记录下次启动清理，已开始传输的响应可能完成；磁盘或数据库故障时回收延迟并报告，不承诺纳秒级准时删除。

### 分享管理文案与对齐（2026-10-23）

按用户反馈修改 ShareManager.tsx、app.css、sharing.spec.ts 和 DESIGN：移除暂停／继续操作的成功提示段落，只通过行内状态反馈；失败使用独立 alert 显示，不静默隐藏错误。状态改为“有效／暂停／到期／用尽”两字文案并保留两字宽度，按钮请求中保留原两字文字，禁用并标记 aria-busy，避免“正在更新…”拉宽布局；次数与日期使用 tabular-nums。未改验证、正文、分享期限或删除策略。

本轮 npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）、python3 scripts/copy-dist.py、git diff --check 通过，保留既有大分块提示。生产分享专项完整 4 项通过，新增确认暂停／继续后无额外成功提示及两字状态文案；既有分享、密码、附件、转存、明暗三视口无障碍检查通过。未重启日常服务，未重复后端或真实设备测试。

### 分享方式按钮单选（2026-10-23）

按用户要求移除 ShareDialog.tsx 的实时模式长说明，下拉框改为“快照／实时”两个等宽按钮式原生 radio，app.css 添加滑动选中背景、键盘焦点和 reduced-motion 适配；已有分享模式锁定和含附件禁用实时规则保留。更新 DESIGN 与 sharing.spec.ts 的单选定位和说明移除断言。不改协议、正文、快照和实时读取行为。

本次 npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）、python3 scripts/copy-dist.py、git diff --check 通过，保留既有大分块提示。./frontend/node_modules/.bin/playwright test -c frontend/playwright.sharing.config.ts 完整 4 项通过（32.7s），验证实时 radio 选择与后端实时读取、附件下实时禁用、长说明不存在，既有明暗三视口无障碍和分享流程回归通过。create-mobile.png 已人工查看。未重跑后端／真实手机／其他浏览器，未重启日常服务。

### 紧凑分享方式控件（2026-10-23）

用户否定铺满表单的分段样式后，实际查阅 Radix Themes 官方 Segmented Control 文档与源 CSS（https://www.radix-ui.com/themes/docs/components/segmented-control、https://github.com/radix-ui/themes/blob/main/packages/radix-ui-themes/src/components/segmented-control.css），参考 inline-grid、等宽项目、独立滑块、短过渡实现，未引入整套主题依赖。ShareDialog.tsx 将标签与控件分置左右；app.css 控件宽 150px、桌面高 36px／手机高 40px，深色选中层改为较亮表面色，120ms 滑动。截图检查发现全局表单 label 的 margin 与 display 干扰内部布局，已通过控件作用域覆盖修复。原生 radio、禁用规则、键盘焦点和减少动画适配保留。

本轮 build／lint、单测 9 文件 28 项、copy-dist.py、git diff --check 通过，保留既有大分块提示。生产分享完整 4 项通过（32.3s），新增实测控件不超过 160px×40px 和方向键切换断言；修正 label 样式后重新构建并执行“单文件实时／文件工具栏”2 项通过（12.7s），包含明暗三视口 axe 和手机截图。最终 create-mobile.png 已人工查看。未修改正文、后端或访问策略，未重启日常服务；真实移动设备及其他浏览器未本次复测。

### 16 字符分享链接（2026-10-23）

按用户确认将新分享 ID 改为 12 字节 crypto/rand、无填充 Base64URL 编码的 16 字符（96 位）；修改 sharing/service.go、RootPage.tsx，新增 ids_test.go，更新 sharing.spec.ts 与 SPEC／ARCHITECTURE／API。新建使用独立 INSERT ... ON CONFLICT(id) DO NOTHING，冲突重新生成，最多 8 次；不使用已有记录 UPSERT，避免极低概率冲突覆盖正文或访问设置。重试仅改变公开 ID，已准备载荷的位置由记录显式保存，不猜测迁移。访客令牌、附件 ID、版本及私有暂存随机数仍为原 192 位。保留所有旧 48 字符十六进制链接，未迁移或重命名已有记录／载荷。

本轮 go -C backend test ./internal/sharing ./internal/httpapi 通过（1.255s／4.812s），go -C backend test -race ./internal/sharing 通过（4.780s），go -C backend vet ./internal/sharing ./internal/httpapi 通过。新增真实短 ID 格式、内部令牌长度保留、旧 ID 进入并读取原快照、非法字符拒绝、注入 ID 碰撞后重试且原记录未改写、持续冲突有界失败测试。npm --prefix frontend run build、npm --prefix frontend run lint、npm --prefix frontend test（9 文件 28 项）、python3 scripts/copy-dist.py 和 git diff --check 通过，保留既有大分块提示。生产分享专项完整 5 项通过（35.1s），新建短链接完成原密码／附件／预览／转存／暂停继续闭环；新增旧格式进入公开路由及非法长度拒绝验证。旧 ID 实际快照读取由上述 Go 测试验证，浏览器旧格式用不存在 ID 验证路由兼容。

未修改原文件、既有链接或鉴权与到期策略，未重启日常服务。新 ID 随机强度降为用户确认的 96 位；碰撞通过唯一约束处理，无密码分享仍须保密其链接。未重复全量后端／备份演练或其他浏览器验证。

### M6 用户设置、存储构成与 Access Token（2026-10-26）

用户授权的当前范围已实现：/user-setting 的账号、存储、应用三栏，左下角入口迁移，管理员系统设置移至设置页顶栏；原系统路由保留。涉及 UserSettings／AccountControls／Login／App／SystemSettings／api.ts／app.css，后端 auth/tokens、httpapi/tokens、storage/breakdown 与认证分派、账号撤销、SPA 路由，以及 backup.py／backup-test.py。SPEC／DESIGN／ARCHITECTURE／API／ROADMAP／README 同步。

本次实际验证（历史 M0–M5 结果不作为本轮证据）：

- `go -C backend test ./...` 全部通过。新增令牌摘要保存、仅一次返回、列表不泄露、重启保留、有效期、100 条上限、改密／禁用／重新启用／重置撤销；离线改密验证旧令牌不可用。HTTP 覆盖无效令牌不回退 Cookie、只读拒绝写入、跨账号资源隔离、敏感接口与永久删除拒绝、CSRF 管理边界、工作区身份、路径越界、If-Match 缺失／陈旧、同名创建与配额保护。存储覆盖六类之和与配额一致、临时文件排除、故障隔离原件计费、回收载荷、分享额外用量、取消及不安全条目拒绝。
- `go -C backend test -race ./internal/auth ./internal/httpapi ./internal/storage` 通过；`go -C backend vet ./...` 通过。最后仅补充旧工作区绑定令牌的 HTTP 测试，相关包普通测试与 httpapi race 再次执行通过。
- `npm --prefix frontend run build`、`npm --prefix frontend run lint`、`npm --prefix frontend test` 均通过，单测仍为 9 文件 28 项；生产构建保留既有 500 kB 大分块提示。`python3 scripts/copy-dist.py` 已复制最新生产资源。
- `./frontend/node_modules/.bin/playwright test -c frontend/playwright.user-settings.config.ts` 最终完整 5 项通过（33.7s），使用真实 Go 嵌入资源及生产 CSP。覆盖新令牌生成、只读真实 HTTP 请求、禁止写入／自我管理、重新加载后无法取回完整令牌、确认删除后 401、真实文件／附件／回收／分享样本的存储统计、统计失败重试、管理员新入口、设置往返保持同一编辑器 DOM、配额失败后原文保留、自助改密后重新登录保留正文及标签；中文六字符密码按 UTF-8 字节校验通过。
- 新三栏在 1440／1024／390 三视口 × 明暗主题执行 WCAG 2 A/AA、2.1 A/AA 检查，零违规，页面无横向溢出。`artifacts/user-settings/` 保存明暗桌面／手机截图，已人工查看应用页桌面深色、手机浅色与存储页桌面深色、手机浅色；不是每张截图均经人工查看。旧系统管理浏览器测试也通过。
- `python3 scripts/backup-test.py` 主机进程演练通过：新增备份中存在令牌、恢复库令牌表为空的断言，并保留原 WAL／双卷／分享／回收站／条件写入演练。不是容器验收。
- `git diff --check` 通过。

过程失败及修复：首轮新增存储测试误用不存在的 Revision 方法，已改为 EntryRevision。最初改密后仍等待成功面板，后台请求可先触发会话失效，改为成功后主动进入重新登录并展示原因。中途 JSX 编辑缺少条件表达式右括号造成构建失败，后续命令曾误用旧 dist；这轮结果不算修复验收。已修复括号并改为构建失败即中止的验证顺序，最后新生产构建上的完整 5 项才作为最终浏览器证据。令牌过期展示最初在 render 调用 Date.now 产生 lint 警告，改用查询更新时间，最终 lint 无告警。

内容与安全边界：本次不改写已有正文，不引入 MCP／OAuth／Skill。令牌仅授予本人整个工作区，未实现目录授权；默认只读，不能管理账号、系统、令牌、私有分享或永久清理回收站。完整令牌只保存在生成响应和页面内存，丢失或请求中断后可删除重建；不自动覆盖文件。改密、禁用和重置撤销对应令牌，离线改密及恢复清除全部，已开始请求可能完成。分类按扩展名，不代表内容识别；大目录统计持有用户存储锁，可能延迟同用户写入，异常条目整次失败。外部宿主写入不保证快照一致性。

本轮只操作隔离测试目录与账号，未重启日常服务。尚未本轮验证真实 Windows／NTFS、ARM、容器、外部 HTTPS 代理、其他浏览器、真实手机软键盘／读屏器；沿用路线图已有环境限制。分享专项浏览器整套未重复执行，分享相关后端包含在全量 Go 测试内。

### 设置顶栏一致性修复（2026-10-26）

按用户反馈新增 SettingsHeader，由 UserSettings 与 SystemSettings 共用。两页右侧均为独立的设置跳转链接与纯文本用户名，修复系统页把“用户设置 · admin”拼成单一链接的不一致；更新 DESIGN 和浏览器对应定位。

本次 `npm --prefix frontend run build`、`npm --prefix frontend run lint`、`python3 scripts/copy-dist.py`、`git diff --check` 通过。`./frontend/node_modules/.bin/playwright test -c frontend/playwright.user-settings.config.ts -g '用户设置、令牌'` 1 项通过（12.2s），包含两页顶栏内容／链接数断言、新三栏三视口明暗 axe 回归；系统页顶栏截图已人工查看。仅修改前端展示，未更改正文、鉴权或令牌能力，未重跑后端及全套浏览器测试，未重启日常服务。

### M7 应用 API 接入完善（2026-10-26）

用户确认先完善已有文件、搜索、上传下载和回收恢复能力。新增 application.go／application_test.go／openapi.json，扩展 auth/tokens 的当前令牌元数据读取；httpapi/tokens 的显式权限表增加身份查询与 GET/HEAD 一致性，api.go 提供 Bearer 401 认证提示，router.go 保留最终 no-store。前端新增 ApiReference 与按需路由，应用页增加入口并沿用 SettingsHeader。新增 APPLICATION_API.md、隔离 application-api-test.py 和仅供开发验证的 requirements-api-test.txt；产品／设计／架构／接口／路线图／README 同步。

本次实际验证：

- `go -C backend test ./...` 全部通过；`go -C backend test -race ./internal/auth ./internal/httpapi ./internal/storage` 通过（auth 7.279s、httpapi 11.122s，storage 使用本次缓存）；`go -C backend vet ./...` 通过。新增契约与令牌白名单双向核对（含权限）、operationId 唯一性、公开静态定义不需认证、HEAD 不绕过权限测试。
- 在 /tmp/folio-api-validation 隔离 Python 环境安装 scripts/requirements-api-test.txt（openapi-spec-validator 0.9.0、jsonschema 4.26.0），不改变生产依赖。`/tmp/folio-api-validation/bin/python -m openapi_spec_validator backend/internal/httpapi/openapi.json` 通过；完整演练也会先验证契约。
- `/tmp/folio-api-validation/bin/python scripts/application-api-test.py` 最终通过：24 个操作、55 个已记录请求，全部契约操作均有真实 HTTP 覆盖，JSON 响应校验 Schema，响应媒体类型与契约核对。使用临时账号、目录和服务；应用请求为纯 Bearer，账号／令牌准备使用隔离 Cookie。验证身份不含完整凭据／CSRF／管理员字段、Cookie 不能代替身份查询、无效令牌不能回退 Cookie、只读与跨账号隔离、配额拒绝、原始 BOM／混合换行保留、陈旧版本拒绝、移动／回收恢复、附件原始字节／范围下载／HEAD／预览隔离、同名与多 part 上传失败不提交、搜索与重建状态及撤销。证据为 artifacts/application-api/contract-report.json，不含完整令牌。
- `npm --prefix frontend run build`、`npm --prefix frontend run lint`、`npm --prefix frontend test` 通过（9 文件 28 项），保留既有构建大分块提示。`python3 scripts/copy-dist.py` 已复制最终生产资源。
- `./frontend/node_modules/.bin/playwright test -c frontend/playwright.application-api.config.ts` 最终 1 项通过（11.9s）：生产 Go 嵌入资源及 CSP 下，应用页进入文档、筛选／空结果、参数／响应展示、加载失败重试、OpenAPI 下载入口、文档浏览不发送文件修改；模拟保存失败后，原未保存草稿及同一编辑器 DOM 往返保留，随后可显式重试保存。1440／1024／390 × 明暗主题的 WCAG 2 A/AA、2.1 A/AA 零违规，无外壳横向溢出。artifacts/application-api/reference-* 截图已保存；人工查看桌面浅色完整布局、手机深色完整布局和桌面深色展开响应区域，未声称逐张人工查看。
- `./frontend/node_modules/.bin/playwright test -c frontend/playwright.user-settings.config.ts` 完整 5 项通过（34.4s），回归令牌／存储／账号改密、系统设置和编辑器保留，覆盖应用页新增入口及共用顶栏。
- `git diff --check` 通过。

过程发现与修复：真实无效 Range 请求返回 416 时，Go ServeContent 默认会删除 Cache-Control，首轮隔离演练因此失败；按本机 Go 标准库文档确认根因，在最终 ResponseWriter 写出时保留 no-store，并委托 ReadFrom／Unwrap，不改全局 GODEBUG。修复后全部 55 请求通过。浏览器首两轮分别发现正文链接仅以颜色区分、手机横向代码区不可键盘聚焦；已增加正文链接下划线及代码／参数滚动区键盘访问，最终新构建零违规。

边界：不迁移或重写已有正文，不新增分享管理、目录级授权、幂等键、批量事务、自动合并、OAuth、MCP 或 Skill。客户端应保留候选正文，超时／durability_uncertain 先核对结果。公开 JSON 只有固定协议与示例，不含真实资源；网页说明需登录。已开始请求仍可能在撤销后完成，宿主外部写入的原有竞争窗口不变。验证未访问日常数据、未重启 8080 服务；未本轮重做备份／容器、真实 Windows／NTFS、外部 HTTPS 代理、其他浏览器、真实读屏器或移动设备验证。原有平台限制沿用路线图。

### Agent Markdown 入口（2026-10-26）

按用户要求新增 backend/internal/httpapi/AGENT.md，Go embed 后由 GET /api/v1/agent.md 提供，支持 HEAD。Accounts 将其作为公开静态说明分派，不初始化工作区；OpenAPI 声明该入口，隔离演练同步验证响应。指南说明凭据、同源接入、任务授权与正文数据边界、条件写入、分页／截断、原始内容与失败核验，不改项目根 AGENTS.md、不安装 Skill。API／SPEC／ARCHITECTURE／ROADMAP／APPLICATION_API／README 同步。

本次 `go -C backend test ./...`、`go -C backend vet ./internal/httpapi`、`git diff --check` 通过。新增真实 httptest HTTP 验证匿名／无效令牌／合法格式但无效的令牌均可读取固定 Markdown，GET 与源文件字节一致、HEAD 无正文，text/markdown UTF-8、no-store、nosniff、不设置 Cookie；无认证服务的 Accounts 可直接响应，证明不触发工作区认证。`/tmp/folio-api-validation/bin/python scripts/application-api-test.py` 通过，覆盖 25 个操作、57 个请求，包含 OpenAPI 标准校验和新指南媒体类型／原始字节核对。

`./frontend/node_modules/.bin/playwright test -c frontend/playwright.application-api.config.ts` 1 项通过（11.2s），动态文档包含第 25 个操作，既有筛选、失败重试、明暗三视口无障碍与草稿保留回归通过。前端生产代码无变更，未重新运行 frontend build／lint／单测；使用上一轮已构建资源。未修改正文或增加权限，指南不包含真实资源或凭据。未重启 8080 日常服务，未重跑 race／其他浏览器／容器及真实设备验证。

Agent 指南应用定位补充（2026-10-26）：在 AGENT.md 开头新增“Folio 是什么”，简述自托管 Markdown／开发文件工作区、Agent 可用能力、真实文件权威、账号隔离、仅已保存内容及无终端执行接口。本次仅修改静态指南；`go -C backend test ./internal/httpapi -run 'TestAgentGuideIsPublicWithoutOpeningWorkspace|TestApplicationContractMatchesAuthorization' -count=1` 与 `git diff --check` 通过。未重跑全量／浏览器测试，未重启日常服务。

### M8 单文件条件 diff 修改（2026-10-26）

用户授权增加局部 diff 修改以减少 Agent 重发正文。新增 storage/patch.go、httpapi/patch.go 及各自专项测试；PATCH /files/content 接收 {diff,dryRun?}，沿用 files=write、Cookie CSRF 和完整 If-Match。解析有界严格单文件 unified diff，不做偏移／模糊匹配，全部块验证后复用原 Store.Write。新增 OpenAPI PatchResult、权限白名单、Agent 局部修改流程及 APPLICATION_API 示例，SPEC／API／ARCHITECTURE／ROADMAP／README 同步。前端生产代码无变更，仅动态文档测试的总数与同路径方法数更新。

本次实际验证：

- `go -C backend test ./...` 通过，包含现有文件层、鉴权、搜索及分享回归。新测试覆盖上下文／重复片段／原坐标、新旧行数、有序多块、空文件插入、删除全部内容但保留文件、LF／CRLF／CR／混合换行、BOM、末尾无换行标记、可选单文件头与 CRLF framing；拒绝计数错误、上下文不匹配、越界／重叠、其他文件头、Git 前导行、NUL／整数溢出及资源超限。Store 测试验证 dryRun 不写入、配额失败／后块失败不部分保存、同版本两个并发补丁只有一个成功和一个版本冲突。HTTP Cookie 测试验证来源／CSRF、强 ETag、JSON／未知字段及 1 MiB 限制。初次运行契约测试因尚未添加 PATCH 定义而失败，补齐 OpenAPI 后通过。
- 标准 GNU diff 在本机为 7 组不同内容生成 42 个非相同组合（含空文件、重复行、中文／emoji 和无末尾换行），独立验证应用结果与目标完全相同；生产不调用 diff 或其他命令。
- `go -C backend test -race ./internal/storage ./internal/httpapi` 通过（2.256s／11.325s），`go -C backend vet ./...` 通过。
- `go -C backend test ./internal/storage -run '^$' -fuzz '^FuzzUnifiedPatchNoPanic$' -fuzztime=10s -parallel=2` 通过（实际约 11s），执行 27361 次，未发现崩溃；不据此宣称穷尽全部补丁输入。
- `/tmp/folio-api-validation/bin/python scripts/application-api-test.py` 最终通过：26 个契约操作、68 个真实请求，含 OpenAPI 标准校验和 JSON 响应结构核对。新增纯 Bearer 补丁预检／正式写入、只读拒绝、428／412、400／409、预检 ETag 不推进与不出现 savedAt、混合换行／BOM 保留、写后索引可搜到新内容。报告 artifacts/application-api/contract-report.json 已更新。
- `./frontend/node_modules/.bin/playwright test -c frontend/playwright.application-api.config.ts` 1 项通过（12.5s），动态接口总数 26，/files/content 筛选为 GET／PUT／PATCH 三项；保留既有生产 CSP、筛选、错误重试、三视口明暗无障碍和未保存草稿往返回归。无前端生产代码修改，未重新构建前端／重复 lint 或单测，使用已有生产资源；未重复其他浏览器专项。
- `git diff --check` 通过。

明确边界：1 MiB 补丁、20000 操作行、256 块、源／结果各最多 200000 行；结果仍受文本限额及配额限制。BOM 自动保留、补丁正文首行不含 BOM；替换块按位置继承被删行的非空换行，额外新增行用源首个换行，无则 LF。未修改行原始字节不变；末尾无换行必须显式标记。此接口不做统一换行／移除 BOM，不支持 Git 前导头、跨文件、二进制、通过补丁创建／删除／改名、自动合并或模糊修复。无变化不落盘。

预检不预留版本或配额，不承诺后续保存必然成功；实际写入再次核对版本和现时配额。正文在内存中形成完整候选后由既有安全整文件替换提交，绝非逐块原位写盘；外部宿主写入竞争窗口与 durability_uncertain 的原有边界不变，失败或超时须读回核对。验证仅使用隔离目录／账号，未改日常正文、未重启 8080；未重新验证备份／容器、真实 Windows／NTFS、ARM、HTTPS 代理、其他浏览器或真实移动设备／读屏器。

### M9 文本按逻辑行读取（2026-10-26）

用户授权在既有文本 API 增加范围读取，配合 diff 减少正文传输。新增 storage/lines.go（无逐行分配的窗口扫描）与 httpapi/content.go（参数／可选 If-Match／全文兼容分派），增加各自专项测试；api.go 复用统一错误映射。OpenAPI 的 ContentResponse 同时描述原全文及 LineContent，API／APPLICATION_API／SPEC／ARCHITECTURE／ROADMAP／README 与 agent.md 同步。Agent 明确局部任务无需先读全文，但片段禁止直接 PUT 覆盖整篇。

本次实际验证：

- `go -C backend test ./...` 全部通过，包含原文件、编辑相关接口、搜索和分享测试。新纯函数测试覆盖 LF／CRLF／CR／混合换行、中文 emoji、BOM 首段、空文件／仅 BOM、末行无换行、末尾分隔符不额外计行、超 EOF／最大整数起点、范围拼接、元数据不变及超补丁行数上限文本的低分配窗口读取。HTTP 测试覆盖全文不增加字段、缺省范围、起始／计数限制、空值／重复／非数字／溢出、强 ETag、全文与跨段 412。最后仅补充“设置文本限额更小后，读一行仍 413”断言，`go -C backend test ./internal/httpapi -run TestLineReadParametersCompatibilityAndVersion -count=1` 再次通过。
- `go -C backend test -race ./internal/storage ./internal/httpapi` 通过（2.256s／11.948s），`go -C backend vet ./...` 通过。
- `/tmp/folio-api-validation/bin/python scripts/application-api-test.py` 最终通过：26 个契约操作、82 个真实请求，含 OpenAPI 标准校验、全文／片段 oneOf JSON Schema 核对。新增前 100 行、第 50 行起 30 行、尾段实际 31 行、EOF 空片段、可选完整版本、BOM／原换行／片段字节数、只读与无文件权限、HEAD、非法／重复参数，以及写入后按旧版本续读返回 412；原 diff、索引与回收恢复闭环继续通过。报告 artifacts/application-api/contract-report.json 更新。
- `./frontend/node_modules/.bin/playwright test -c frontend/playwright.application-api.config.ts` 1 项通过（13.0s），既有生产文档筛选、错误重试、明暗三视口无障碍与草稿往返保留通过。操作数仍 26，只扩展原 GET 参数及响应；无前端生产代码或样式变更，未重新运行前端 build／lint／单测，使用已有生产资源。
- `git diff --check` 通过。

行为与限制：startLine 从 1 开始，lineCount 为 1–1000；传任一参数时缺省分别为 1／100，不传时原全文响应完全保留。选中字符和换行原样返回；size、revision／ETag 始终指完整文件，returnedSize 指片段，lineCount 是实际行数。尾段 hasMore=false 仍可能 isPartial=true；无实际返回行时 endLine=0，无后续时 nextLine=0。空文件／仅 BOM 为 0 行，BOM 仅 startLine=1 保留。

没有改写正文或索引、没有新增权限。单次读取仍用原安全 Store.Read 校验完整文本，并读取全文以确认版本和总行数；不绕过文本上限、不承诺任意大文件流式读取，也没有按字节限制每行长度。跨请求不持有快照锁，调用方用可选 If-Match 固定完整版本，412 时保留候选并重新核对，不能混合拼接。原有外部宿主写入竞争边界不变。仅使用隔离测试账号／目录，未重启 8080；未本轮重新验证备份／容器、真实 Windows／NTFS、其他浏览器或真实设备。


### M10 SSE 与外部更新标记（2026-10-26）

新增按账号隔离的有界 SSE Hub、Cookie 专用 GET /api/v1/workspace/events，以及浏览器串行核对／自动接收干净正文。源码按行、富文本按语义块显示黄色修改、绿色新增和指向删除位置的红色小三角，末尾删除标在末行下方；8 秒后或本地编辑时清除，不显示图例。有草稿时不覆盖或自动打开对话框，工具栏保存及 Ctrl/Cmd+S 才进入既有差异确认／保留副本流程。实现涉及 httpapi/events.go、accounts.go、api.go、server/main.go、useExternalChanges、sessions、SourceEditor／RichEditor、editors/changes 和样式；协议、产品、设计、架构、路线图及 Agent 指南同步。

本次实际验证：

- `go -C backend test ./...`、`go -C backend test -race ./internal/httpapi`、`go -C backend vet ./...` 通过。专项覆盖有界合并、账号 Hub 隔离、连接数上限、关闭与退订、真实 HTTP 流、超过全局写超时仍可推送、未认证／跨来源／错误工作区／Bearer 拒绝、dryRun 无通知、目录通知与会话撤销。
- `npm --prefix frontend run build` 通过，保留既有大包提示；`python3 scripts/copy-dist.py` 更新嵌入资源。`npm --prefix frontend run lint` 通过，`npm --prefix frontend test` 为 10 个文件、33 项通过，含变更定位、限额、8 秒清除和读取期间输入保护。
- `./frontend/node_modules/.bin/playwright test -c frontend/playwright.sse.config.ts` 最终 7 项通过（32.2s），使用隔离生产服务。覆盖独立 Bearer 客户端修改后自动更新、三色与删除三角、8 秒清除、无回写、离线上线重连核对、未保存草稿与手动保存／快捷键冲突比较、保留副本、富文本语义标记、不安全富文本回退源码，以及读取过程中输入不被覆盖。源码 1440／1024／390 像素明暗主题截图及无障碍检查通过；人工检查最终手机源码与富文本截图，确认没有图例。
- 初轮浏览器测试发现旧专项截图路径依赖工作目录、手机抽屉遮挡、Crepe 初始化清除装饰；修正后又发现离线事件未主动断开旧流、派生标题 ID 误报修改，已分别补充离线暂停与语义比较，再次完整运行上述 7 项通过。
- `./frontend/node_modules/.bin/playwright test -c frontend/playwright.application-api.config.ts` 1 项通过（12.1s），文档筛选、失败重试、明暗三视口无障碍和草稿往返保留回归通过。
- `git diff --check` 通过。
- `/tmp/folio-api-validation/bin/python scripts/application-api-test.py` 通过：26 个应用契约操作、82 个真实请求。SSE 为 Cookie 专用，不扩展应用令牌白名单。

边界：仅应用提交即时通知，宿主直接写入仍依赖 10 秒兜底与焦点检查；通知不含正文、不代替 If-Match，也不保留重放日志。每账号最多 4 个连接，慢消费者合并为全量核对；15 秒心跳复核身份，退出或撤销空闲会话至多一个心跳周期后关闭。前端批量、串行核对，忙碌编辑延迟重试；失败明确显示并保留正文。

超过比较预算时明确提示仅部分／未显示标记；字符总数 100 万、单侧 20000 换行、2000 标记及原有 LCS 预算限制沿用实现。源码按行，富文本按顶层语义块，不提供块内逐行标记。远程接收会重建当前编辑器并重置其撤销栈；尽量恢复源码选区／滚动与富文本滚动，不承诺编辑位置逐字符映射。未引入自动合并或强制覆盖。仅使用隔离测试目录和账号，未重启日常 8080 服务；HTTPS 代理缓冲、真实设备／读屏器、其他浏览器、Windows／NTFS 与容器部署未本次重验。

### M10 通知操作与就地差异展开（2026-10-26，后续本轮）

保持干净正文即时加载，在右下角增加按文件通知：增删行统计、认证 Access Token 名称、接受（10 秒自动确认）／等待／回滚。同文件连续变化合并并重计时，等待后跨后续变化保持暂停；统计、编辑器标记及展开详情对照本轮初始正文。接受不写盘，回滚通过最新通知版本的 If-Match 恢复初始正文；有草稿不覆盖，回滚保留草稿且继续暂停自动保存。

黄条、红三角和绿条可就地展开修改前／后；源码使用 CM6 block widget，富文本使用 ProseMirror widget 展示顶层块 Markdown，均为只读装饰，不写正文或撤销历史。支持再次点击、收起、Escape、Enter／Space 和展开状态。展开期间保留详情，超过原 8 秒后收起即清除；输入仍立即清理。共享输入预算为前后 100 万字符、任一侧 20000 换行，展开前后合计最多 200 行／20000 字符并明确提示截断。

涉及新增 `sessions/remote-notices.ts`、`RemoteChangeNotices.tsx`、`editors/changes/details.ts` 及测试；调整会话协调、源码／富文本标记插件、Workbench 和样式。后端 SSE 增加可选 `source:{name}`，仅取自通过鉴权的令牌；Cookie、reset、背压及结果不确定时不传名称。名称只说明事件来源，不承诺随后读取版本的精确作者，不包含其他令牌属性。原 SSE／ETag 和账号隔离边界不变。

本轮实际执行，独立于上节历史记录：

- 后端目录执行 `LC_ALL=C go test ./...`、`go test -race ./internal/httpapi`、`go vet ./...`：通过，部分包命中 Go 缓存。普通 locale 的首轮全量测试曾因 GNU diff 输出中文末行标记失败，固定 `LC_ALL=C` 后通过；未把该环境失败隐藏为业务通过。
- 前端目录执行 `npm run build -- --logLevel warn`、`npm run lint`、`npm test`：最终通过；单元为 12 个文件、42 项，覆盖连续合并／暂停、条件回滚与失败、草稿保护、接受与下一轮读取竞争、父信号取消，以及差异分组、EOF 与比较预算。生产构建仍有既有大分块警告。`python3 scripts/copy-dist.py` 已同步最终嵌入资源。
- 前端目录执行 `npx playwright test -c playwright.sse.config.ts`：最终完整 18 项通过（54.4s），运行临时生产服务 `127.0.0.1:18081`。覆盖即时显示、来源及统计、10 秒倒计时／连续合并／等待、接受无回写、真实回滚与后续并发 412、草稿及读取期间输入保护、原宿主写入／断线补偿，以及两种编辑器普通／末尾删除点击展开、关闭／键盘、展开超期驻留、源码行号对齐、正文与磁盘版本不变。包括 1440／390 像素明暗截图与无横向溢出检查；现有源码页 WCAG 检查随专项通过，不将其扩大为所有新详情的完整无障碍认证。
- 人工查看 `artifacts/sse/peek-source-390-dark.png`、`peek-rich-390-light.png`、`peek-rich-1440-dark.png`，确认详情就地显示、红绿前后文本可读、通知位于右下、无图例及独立弹窗，源码行号随展开内容正确对齐。
- 首轮手机用例因未打开文件抽屉失败，时钟暂停取到过去时间导致偶发失败，分别修正测试准备及未来暂停点。额外行号断言发现 CM6 块装饰的垂直外边距未计入高度，去除源码详情外边距后完整专项通过。修复接受上一轮期间读取下一轮时复活旧回滚基准的竞态，并补充单测；错误路径核对会话身份／版本，非文本重载继承父取消信号。最初 TypeScript 参数属性不符合 `erasableSyntaxOnly`，已改为显式字段并构建通过。

边界：通知与初始正文仅存在本页内存，不是持久历史或备份；只对已打开可读取文本提供完整统计／回滚，删除或非文本沿用原提示。富文本详情是顶层块序列化 Markdown，不保证保留旧文所有空白字节，需精确核对可用源码。大差异可能仅部分标记／统计近似，展开明确截断，不改变真实正文。自动接收依旧重置编辑器撤销栈。未重跑全量业务浏览器、应用 API 26 操作契约、备份／容器或新增详情的完整读屏验收；上节对应结果是历史记录。真实 HTTPS 代理、其他浏览器、真实手机／IME／读屏器、Windows／NTFS 仍未验证。未重启日常 8080 服务，未创建 Git 提交。

### 列表原风格与通知统一生命周期（2026-10-26，继续本轮）

用户补充列表符号格式变化可能导致无意义版本变化与 Agent 412，且 diff 显示必须与询问通知一致。调整 `editors/milkdown/engine.ts`：在已安装 Milkdown 7.22.3 的 `remarkCtx` 解析真实 AST，按 `listItem.position.start.offset` 检测原始统一 `-`／`*`／`+` 风格，设置公开 `remarkStringifyOptionsCtx.bullet`，保留其他序列化配置；无列表默认 `-`。不使用全文替换或将代码块里的符号计入风格，不放松 `equivalentSource`；混合及其他不可安全往返内容仍确认转换或外部回退源码。

通知路径使用 `highlight: 'notice'`，`ExternalUpdate.expiresAt: null` 代表不独立过期。提前接受或 10 秒自动接受时通知、标记、已展开 peek 一同消失；等待后一直保留直到决策，连续更新继续暂停。本地输入仍清除失效装饰；回滚成功清理旧标记且不生成新的 8 秒提示，失败保留通知。源码 `StateEffect` 与富文本 ProseMirror meta 清理装饰，不重建编辑器；不触发保存，不改变正文／选区／撤销历史。非通知重载的旧 8 秒规则保留。涉及会话、两种标记插件、SourceEditor／RichEditor 桥接及相应测试，规范同步。

本轮实际验证，与上节 18 项历史结果区分：

- 在更新生产资源前执行前端目录 `npx playwright test -c playwright.sse.config.ts sse-lists.spec.ts -g '列表 短横线'`：按预期失败。错误快照明确显示“富文本转换预览”中原文 `- 第一项`／`- 第二项` 变成 `*`，证明旧 serializer 风格变化；没有据此声称仅打开就静默保存。
- `npm run build -- --logLevel warn`、`python3 scripts/copy-dist.py`：通过，保留既有大分块提示；构建后才运行修复验收。`npm run lint` 通过。`npm test` 最终 12 文件／46 项通过，新增持久标记、接受／等待／本地输入清理与源码装饰清理不改变正文、选区和撤销历史测试。
- 前端目录 `npx playwright test -c playwright.sse.config.ts sse-lists.spec.ts`：列表专项 8 项通过（37.9s）。覆盖三种统一列表符号、嵌套、任务、引用、代码块假列表；只读／选区及 Agent 更新无浏览器回写，原文与版本不变；真实富文本编辑仅保存一次且保留列表风格，Agent 用最新版本继续写入成功、陈旧版本仍拒绝 412。混合风格取消转换后无回写、原始正文和版本不变。
- 前端目录 `npx playwright test -c playwright.sse.config.ts`：最终完整 **30 项通过（1.5m）**。新增源码／富文本各两项，验证等待 20 秒标记及展开详情仍保留，接受后立即全部清除；第 9 秒仍存在，第 10 秒自动接受后全部清除，正文和磁盘 revision 不变。连续更新暂停、本地输入清理、回滚失败及旧安全回归继续通过；1440／390 像素明暗截图及源码行号对齐断言保留。不是把此前只读文档研究或 18 项结果冒充本轮通过。
- 追加执行 `npx playwright test tests/browser/workbench.spec.ts`：最终不带快照更新选项的完整 **9 项通过（21.4s）**，覆盖真实 Crepe 往返、有损转换取消／确认、陈旧预览拒绝、快速切换及三视口。首轮快照按预期只在“嵌套任务列表”出现差异；审核后仅更新该语料的 `serialized`（保留短横线）和 `safe: true`，保留其他语料全部预期，并补充嵌套任务列表安全断言。使用生成器恢复 JSON 快照原本无末尾换行格式后，以非更新模式重新验证通过。人工查看本轮 `peek-rich-390-light.png`，确认等待状态只有接受／回滚，详情仍在原位，无图例或额外弹窗。

边界：本次仅修改前端及文档，未改 ETag／If-Match、服务端保存或强制重试策略；因此没有再次运行 Go 测试、全量应用契约或所有业务浏览器，前节对应结果属于历史。统一 bullet 的保留不是任意 Markdown 的无损格式编辑器，混合标记、特殊分隔线及其他序列化差异仍可能要求确认／源码；真实并发编辑依旧可能正确返回 412。通知与回滚基准仍仅存页面内存；等待不构成持久备份。真实 HTTPS 代理、其他浏览器、真实手机／IME／读屏器及 Windows／NTFS 等限制不变。未创建 Git 提交，未重启日常 8080 服务。

### 紧凑内联差异（2026-10-26）

按用户要求移除详情的“替换内容”等标题及可见“修改前／修改后”文字，红色旧内容、绿色新内容上下无缝拼接，“收起”浮于右上角，不另占标题行；保留内容区 aria-label、键盘操作、预算／截断与通知生命周期。涉及 `editors/changes/details.ts`、`app.css`、`sse.spec.ts` 和 DESIGN。

仅执行定向验证：前端 `npm run build -- --logLevel warn`、`npx oxlint src/editors/changes/details.ts tests/browser/sse.spec.ts` 通过；`npx vitest run src/editors/changes/details.test.ts` 3 项通过；同步嵌入资源后 `npx playwright test -c playwright.sse.config.ts -g '内联详情支持'` 4 项通过（12.6s），覆盖源码／富文本 × 桌面／手机、标题移除及红绿区域几何间距为零，原展开／收起／键盘及正文无回写断言继续通过。人工查看手机富文本浅色截图确认紧凑效果。未重复完整浏览器套件或后端测试；无正文、安全协议及数据生命周期变化，未重启日常服务，未提交。

### M11 常见输入与保源编辑（2026-10-26，本阶段实际记录）

用户授权自主实现、测试后提交并推送，之后明确允许细致回归。以下均为本阶段实际执行，不把 M10 历史记录当作通过证据。

**实现与范围**

- 新增 `editors/milkdown/preserve-source.ts`：从实际 remark AST 的 UTF-16 offset 建立顶层 raw／gaps 与 PM 语义映射，`prepare` 纯预检、`commit` 推进快照；允许多空行、表格对齐、Setext、转义、混合顶层列表、既有 tilde／长 fence 等排版差异直接进入 rich。只读、刷新、选区及模式切换不写入，不改变 ETag。实际编辑只生成改变的顶层块，复用未改 raw 与原 gap，候选重新解析严格匹配后才放行，无全文 serialize fallback。
- `semanticDoc` 只排除 heading 派生 `id` 与 serializer 不持久化的 list_item `label/listType`；后者避免 splitListItem 复制旧编号而在 append 更新前被误拒绝。父列表类型、起始序号、`checked`、语言、hardbreak、`spread`、marks 及其他属性仍比较。可验证的唯一或同 raw 块移动复用原片段；同语义不同 raw 的身份歧义拒绝。仅投影一个与源码解析严格对应的默认尾部空段，不吞显式空段；在虚拟尾段输入会补足必要分隔后成为真实块。
- 新增 `markdown-input.ts`：半角同类三个以上反引号／波浪号围栏、`c++`／`c#`／`shell-session`／`json` 等语言及空格／Enter，通过同一 Crepe code_block 创建。DOM 阶段优先于默认分段快捷键；全角、混合围栏、非空选区、组合输入、修饰键和正文后缀不误触发。已有正常反引号能力保留。
- `engine.ts`／`RichEditor.tsx` 接入原文适配器，安全打开不再以 serializer 输出替换原文；事务事前过滤，拒绝明确提示。已上传图片的插入用占位标记是否真正移除判断是否被接纳，拒绝后进入已有追加恢复。内嵌 CM 被 PM 拒绝时恢复可见原代码；恢复期间临时失焦，阻止库把 B→A 恢复差量再次转发给仍为 A 的 PM，保留焦点和历史。
- `SourceEditor.tsx` 修复完整回归发现的搜索定位竞争：显式搜索导航取消尚未执行的旧滚动恢复帧，卸载也取消帧；不靠测试手工滚动绕过。新增及调整浏览器用例、往返快照和规范；显式声明测试使用的已有 unified／remark 开发依赖，未升级运行时依赖，未修改后端或 API。

**最终通过结果**

| 实际命令／运行范围 | 本阶段结果 |
| --- | --- |
| `npm run build -- --logLevel warn`、`npm run lint` | 最终通过；保留既有大分块提示 |
| `npm test` | 最终 14 文件／148 项通过；含真实 PM split、150 次连续提交、历史滚动、8／16 MiB 缓存、BOM／CRLF、预算、语义变化、空段、移动与 undo |
| `python3 scripts/copy-dist.py` 后 `npx playwright test -c playwright.sse.config.ts` | 最终生产实服务 **46 项通过（2.4m）**；包含 15 项保源与围栏、9 项列表及原 SSE／外部写入专项 |
| 默认 `npx playwright test` 全量范围及补跑 | 当前 **125 项功能浏览器分批覆盖并最终通过**，不是一次命令 125 项全绿，具体批次与初轮失败见下文 |
| `npx playwright test tests/browser/files.spec.ts tests/browser/line-endings.spec.ts tests/browser/search-location.spec.ts tests/browser/rich-drag.spec.ts tests/browser/editor-preservation.spec.ts tests/browser/editor-upload-guard.spec.ts` | 最终相关 **30 项全过（2.1m）**，包含真实 412、字节保真、搜索可见、拖拽、短／长拒绝 CM 恢复 |
| `npx playwright test tests/browser/workbench.spec.ts -g 'Markdown 真实 Crepe 往返快照'` | 非更新模式通过；只审核更新表格、转义、空白准入及未承诺脚注拒绝的四个 `safe` 值，serialized 未改 |
| `LC_ALL=C go test ./...`、`go vet ./...` | 通过，部分包命中缓存；未宣称执行新的 race 检查 |

默认全量初始收集 122 项，单次执行因工具 600 秒上限在第 100 项后停止，前 100 项 94 过、6 失败；确认并停止本轮遗留的临时 `18081`／Vite `5173`，未触碰日常 `8080`。剩余 22 项单独运行，21 过、1 项预期快照差异，更新审核后用非更新模式通过。六个初轮失败包含两项冲突时序、换行测试旧准入预期、两项拖拽旧全文规范化预期及一个真实搜索滚动竞争；修复后对应 30 项重验全过。随后追加两项列表回车及一项长短拒绝代码分组，总收集 125 项；不是用缩小范围或忽略失败得到总通过数。

功能验证覆盖：只读／焦点／刷新／模式往返无 PUT/PATCH、整份源码与 ETag 不变；编辑别段按完整字符串检查未改格式；undo 精确恢复初始源码、redo 条件保存；SSE 接纳格式差异不退回源码、不回写，接续新 ETag 可写而旧 ETag 仍 412；四种围栏输入生成真实代码块、录入并重开无误报；全角与混合符号不误触发；frontmatter／未使用引用定义／code meta 不静默准入；段落 split、无序／有序列表回车、真实鼠标拖拽和撤销；恢复、附件、分享、管理员／用户设置、手机、搜索、Mermaid、标签与工作流原回归继续覆盖。

注入拒绝测试明确使用 dev 页面真实 Crepe，加额外 PM filter 拒绝指定事务，不伪造服务成功响应。图片成功上传但插入拒绝后 fallback 一次、pending 归零、原文不变。代码分别输入极短与 20000 字符长值，确认每次只有一个被拒 PM 正文事务，恢复无反向正文转发、无 pageerror／越界错误、尾段及 source 不变，焦点恢复，undoDepth／redoDepth 不增。这是异常路径测试，不冒称生产原生剪贴板验收。

**未通过的性能门槛**

执行 `npx playwright test -c playwright.qa.config.ts`：8 项通过、1 项性能失败；浅／深 × 手机／桌面真实 Chromium AX／axe／键盘焦点及四项 Mermaid 生产流程通过。独立重跑 `npx playwright test -c playwright.qa.config.ts tests/qa/performance.spec.ts` 仍失败，未提高既有门槛或删断言。1202 文件样本中全文搜索 API 三次约 315–322ms，超过 100ms 预算；发生在打开编辑器前，本阶段未改后端搜索，不能据此声称编辑器导致或已经修复。162508 字节 rich、1060800 字节源码的实际保存精确性通过，编辑器输入样本仍低于 300ms 预算；三样本不是统计 p95。实际报告在 `artifacts/qa/performance.json`，此项保留为既有性能目标待处理，**不声明完整 QA 全绿**。

**已发现并修复的失败与边界**

初轮用例揭示 Crepe 尾部派生空段造成代码重开误报、虚拟尾段输入缺分隔、有序列表派生 label 在 append 前误拒绝，以及正常块移动被保守规则拦截；均补对应单元／真实浏览器验证。完整回归中冲突测试改为请求已发出后真实远端条件提交，再放行旧请求，保留旧 If-Match／真实 412／磁盘正文不覆盖断言；没有把 SSE 已提前接纳的新版本伪装成陈旧版本。换行测试改为新保源准入后显式切源码，全部原字节断言保留。拖拽测试按实际 AST 检查 raw 仅重排且原空白不丢，再精确核对 undo 原文，不要求整篇被规范化。搜索滚动失败修改应用而非用例绕过。

保源限制：输入单份最多 100 万 UTF-16 字符、少于 20000 换行，生成前后合计最多 100 万字符；AST 10 万节点、LCS 25 万单元。历史最多 50 快照、16 MiB 总记账、8 MiB 单快照，固定保留初始及当前，提交时滚动淘汰其他记录；不因缓存累计满阻止正常输入。已淘汰历史不保证所有原格式字节。修改的列表／表格／引用／代码等顶层容器可能规范化；不是节点内部的最小字节补丁器。额外连续空段、来源歧义及不能表达的结构可能明确拒绝，源码入口保留。围栏输入不承诺所有缩进／info string 变体；已有合法源码能解析也不等于每种输入快捷形式已覆盖。

尚未验证：其他浏览器、真实手机／IME／读屏器、Windows／NTFS、真实 HTTPS 代理缓冲；未重跑应用 API 26 操作真实契约、备份／容器部署或源码外的所有方言语法。文件仍唯一权威，SQLite 及 ETag／If-Match、未保存草稿与恢复保护不变。本轮均使用隔离账号／目录／临时服务，未重启日常 8080 服务。提交及推送状态以最终 Git 交付说明为准。


### API 问题清单修复：输入与错误分类（2026-10-26）

本次定向执行 `go test ./internal/httpapi ./internal/storage -run 'TestAuthenticatedFileFlow|TestTrashRestoreAndCollision'` 通过。覆盖 POST／PUT 缺失或 null content 拒绝且不改变正文／ETag、显式空文件创建、tree 文件／不存在路径、未知及重复恢复记录。无凭据明确提示令牌／会话并提供 Bearer challenge，失效 Cookie 提示保留。P3-3 末尾换行不匹配的 409 语义不变。完整回归另记。

### API 问题清单修复：补丁无变化语义（2026-10-26）

定向命令 `go test ./internal/storage ./internal/httpapi -run 'TestUnifiedPatch|TestPatch'`，本次通过。新增纯上下文、相同替换的预检／保存回归，验证计数归零、版本／mtime／文件身份不变及错误上下文拒绝。P3-3 保持 409。

### API 问题清单修复：元数据与文件流（2026-10-26）

`go test ./internal/httpapi -run TestAttachmentBoundary` 验证 Markdown 两种扩展名的 mediaType／viewer；下载和预览均验证 Last-Modified 非空、日期 If-Range 匹配返回 206 且字节正确、不匹配返回 200 全文。SVG／HTML 保留安全文本分类和预览隔离，不新增活动 MIME 预览。

### API 问题清单修复：接入文档与契约（2026-10-26）

补充 revision 与带引号 ETag 的区别、严格路径、422 损坏处理、Markdown／活动源码的安全类型及日期 If-Range。OpenAPI 错误响应按操作收窄，保留认证／工作区变化／底层失败边界。`PYTHONUTF8=1 <临时虚拟环境 Python> scripts/application-api-test.py` 最后一次 26 操作／102 请求通过（此前一次为 103 请求，差异来自异步索引状态轮询），含真实 Bearer、JSON Schema、匿名提示、缺失／null 正文不落盘、tree 类型错误、严格路径、no-op、重复恢复及下载／预览的匹配／不匹配 If-Range。依赖安装于系统临时目录的独立虚拟环境，未增加生产依赖。恢复分类另加遗留 restored 记录的 409 及已存在目录缺清单仍报损坏的存储回归。

Linux 专用备份工具在 Windows 执行 `python scripts/backup.py --help` 因 `ModuleNotFoundError: fcntl` 失败，未执行备份恢复实测，WSL 未安装发行版。未重启日常 8080 服务，所有写入验证均使用隔离临时目录。


### API 问题清单修复：本轮最终完整回归（2026-10-26）

以下为本轮实际执行，不能与前面的 M10／M11 历史记录混用。

| 命令（按所在目录执行） | 本次结果 |
| --- | --- |
| backend：`go test ./...`、`go vet ./...` | 最终均通过，部分未变包命中缓存 |
| frontend：`npm run lint`、`npm test` | 通过；14 个文件、148 项单元测试通过 |
| frontend：`npm run build -- --logLevel warn` | 通过，保留既有大分块提示 |
| 根目录：`python scripts/copy-dist.py` | 通过，供独立生产 QA 使用；未重启日常服务 |
| frontend：`npx playwright test --reporter=line` | **125 项全部通过（7.3m）**，本次单次完整运行，没有忽略或跳过失败 |
| 根目录：`PYTHONUTF8=1 <临时虚拟环境 Python> scripts/application-api-test.py` | 最后一次 26 操作、102 请求通过；OpenAPI 与响应 JSON Schema、纯 Bearer 及新增问题回归 |
| frontend：`npx playwright test -c playwright.qa.config.ts --reporter=line` | **8 项通过，1 项搜索性能失败（53.1s）** |
| 根目录：`python scripts/backup.py --help` | Windows 无 fcntl，导入失败；未执行 Linux 双卷备份恢复验收 |

浏览器两轮均设置 `CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe`、`PYTHONUTF8=1`，使用脚本创建的隔离临时目录与 18081 测试服务，结束后监听已释放；未触碰日常 8080 服务。原始日志为 `artifacts/api-fixes-browser.log`、`artifacts/api-fixes-qa.log`，契约记录为 `artifacts/application-api/contract-report.json`。

生产 QA 的明暗主题 × 手机／桌面无障碍及四项 Mermaid 流程通过。性能样本 1202 文件，全文搜索三次约 171.13／167.65／167.60ms，超过既有 100ms 门槛；名称搜索约 2.72–3.42ms。与此前 M11 已记录的同类门槛失败分别记录，不宣称修复或完整 QA 全绿，未调整门槛或搜索实现。编辑器较大正文保存字节精确检查通过；三次输入样本不是统计 p95。原始数据为 `artifacts/qa/performance.json`。

P3-3 按用户决定不修改，末尾换行与原文不匹配继续返回 409 patch_mismatch。If-Range 无运行时缺陷，本次补充 Cookie 与真实 Bearer 的日期条件验证和文档，不新增文件流 ETag；秒级修改日期不提供强内容一致性，条件写仍必须使用原强 ETag。SVG／HTML 不放开活动预览。未验证 Linux／容器备份、真实 HTTPS 代理、其他浏览器或真实移动设备；没有将这些环境限制改为通过。modelrouter 不属于本轮范围。

### M12 Agent 文档渐进式发现（2026-10-27，本次实际执行）

精简 `backend/internal/httpapi/AGENT.md`，新 `application_docs.go` 从唯一嵌入 OpenAPI 在启动时生成不可变操作索引和单操作契约；`application.go`／`accounts.go` 提供匿名 GET／HEAD，不初始化用户工作区。索引仅含摘要、权限／公开标识及详情地址，单操作保留 servers／security 继承和路径级字段，递归携带所需本地组件及认证方式，循环引用去重；缺失或外部引用明确报错，不执行外部 schema 请求。两项公开只读入口使契约从 26 操作增加到 28，原 24 项业务操作与权限不变。

同步完整契约、真实演练脚本和 API 页面回归，保留全部旧写入、片段、If-Match／412 断言。原完整 OpenAPI、人工说明与 `/api-docs` 继续保留；不新增 MCP、客户端执行器、令牌权限或正文数据存储。

本次实际结果：

| 命令／范围 | 结果 |
| --- | --- |
| backend：`go test ./internal/httpapi -run 'TestOperationDocument\|TestApplicationContract\|TestAgentGuide' -v` | 通过；全部索引与原契约精确核对、独立子文档继承、递归闭包及体量约束 |
| backend：`LC_ALL=C go test ./...` | 通过，部分包命中缓存 |
| backend：`go test -race ./internal/httpapi`、`go vet ./...` | 通过 |
| 根目录：`/tmp/kilo/folio-api-validator/bin/python scripts/application-api-test.py` | **28 个操作／151 个真实请求通过**；全部详情通过 OpenAPI 校验，索引／操作／最小引用闭包与完整源一致，JSON 响应 schema、条件写入、原始字节、Range／HEAD、回收恢复、搜索与授权隔离继续验证 |
| frontend：`npm run build -- --logLevel warn` | 通过，保留既有大分块提示 |
| frontend：`npx oxlint tests/browser/application-api.spec.ts` | 通过 |
| 同步嵌入资源后：`npx playwright test -c playwright.application-api.config.ts` | **1 项通过（10.8s）**；28 操作、按路径筛选、新公开操作、错误重试与往返保留草稿／编辑实例／磁盘原文 |

测量采用实际 UTF-8 响应字节，不换算或宣称固定 Token 数：指南由 15205 降为 **3828 字节（减少约 75%）**，摘要索引 **5645 字节**；完整契约扩充后为 **90736 字节**。`readContent`／`patchContent` 自包含详情分别 **7894／7108 字节**，已知读取与局部修改任务只需指南加这两份约 18.8KB，而非先读旧指南加旧完整契约约 101.5KB；未包含真实文件正文或实际任务读取量，不把体量减少冒充 AI 准确率提升。

公开边界测试在无 Auth／workspace 的 Accounts 上，通过真实 httptest 服务遍历全部文档 GET／HEAD 与匿名／无效 Bearer／无效 Cookie，核对固定字节、HEAD 无正文、no-store／nosniff、不设置 Cookie。未知 ID 返回 `404 operation_not_found`，额外子路径不能访问业务资源；业务文档发现不代表令牌获权，空权限且非公开的身份查询仍需有效 Token。首轮 Go 测试将源中省略的权限字段与索引空对象直接比较导致断言失败，已按契约缺省空权限规范化，未改动业务授权。

限制与未验：仅支持本地组件引用的静态契约派生，不是任意外部 OpenAPI 的通用解析器；不新增公共文档限流机制，仍使用现有 HTTP 服务边界。未重跑前端完整 125 项业务浏览器或全量前端单测，前节结果是历史；没有声称真实 HTTPS 代理、其他浏览器／真实设备、Windows／NTFS、容器／备份及现有搜索性能门槛在本次通过。验证使用隔离服务与目录，未重启日常 8080 服务，未创建 Git 提交。

### 令牌有效期档位与自定义天数（2026-10-27）

`UserSettings.tsx` 在已有 30／90／365 天和永久基础上增加 1／7／14／180 天及自定义，默认仍为 30 天。自定义选中才显示有标签、范围说明的原生 number 输入，接受 1–366 整数天；原生校验外，提交逻辑独立检查整数与范围，不能把自定义 0 误当永久。到期时间仍按生成时起每 86400 秒计算，沿用现有 expiresAt 协议和服务端未来 366 天上限，权限与令牌一次性显示规则不变。同步 SPEC／DESIGN，不修改后端。

本次实际执行：前端 `npm run build -- --logLevel warn`、`npx oxlint src/features/auth/UserSettings.tsx tests/browser/user-settings.spec.ts` 通过；构建保留原有大分块提示。`npx playwright test tests/browser/user-settings.spec.ts` 最终 **2 项通过（19.6s）**，新增用例通过真实服务器生成全部七种有限预设、45／366 天自定义及永久共 10 个令牌，核对到期时间与权限，并清理测试凭据。空值、0、负数、小数及 367 天不发 POST；额外放宽测试 DOM 的 min 后，提交校验仍阻止自定义 0，未创建永久令牌。自定义表单明暗 × 1440／390 无横向溢出、全页 WCAG 检查通过；原令牌实际访问／撤销、存储与设置切换回归继续通过。

首轮新增用例切换主题时在按钮颜色过渡中采样，出现临时对比度失败；与原用户设置用例一致启用 reducedMotion 后完整复测通过，未排除 axe 规则或修改对比度门槛。`python3 scripts/copy-dist.py` 已同步生产嵌入资源。未重复执行全量前端、Go 或生产 QA，本次浏览器使用 Vite 与隔离真实后端，未将其描述为生产包浏览器验收；其他浏览器、真实设备及客户端时钟偏差未专项验证。未重启日常服务，未创建提交。

### 末尾连续回车误拦截修复（2026-10-27）

用户反馈富文本末尾回车提示“未映射的额外空段落”。旧保源实现只允许前一个节点非空的单个尾占位，连续 Enter 的真实空段被统一拒绝；错误并不表示原 Markdown 非法。生产旧资源定向复现：`npx playwright test -c playwright.sse.config.ts editor-preservation.spec.ts -g '末尾连续回车 LF'` 在第二次 Enter 后仍只有两个段落，按预期失败。

修复 `preserve-source.ts`：区分源码 `semantic` 和完整视图 `viewSemantic`，历史按实际视图匹配，避免真实空段与尾占位互相误命中；按已映射与目标尾空段数量投影一个多余默认占位，其他空段使用库原生标准 `<br />` 严格序列化并回验。原始显式 BR、未编辑 raw／gaps、BOM／换行不丢，非默认属性、marks、hardbreak 不降级为普通空段。无法独立输出唯一空段时使用带非空探测段的序列化结果，确认首块与探测块后只保留空段，探测文本不得泄漏。新字段计入原有缓存预算，预检／提交和滚动淘汰规则不变。

本次实际验证，区分此前历史：

- `npm test`：**14 文件／164 项通过**，保源专项为 82 项，新增连续 Enter、空文档／中间空段、代码／列表／表格尾、精确逐步和分组 undo／redo、显式 BR、探测回退、预算与原保护回归。
- `npm run build -- --logLevel warn` 通过，保留既有大分块提示；`python3 scripts/copy-dist.py` 已同步修复后的生产资源。
- `npx playwright test -c playwright.sse.config.ts editor-preservation.spec.ts`：最终生产真实服务 **21 项全部通过（1.5m）**。新增 6 项覆盖 LF／BOM CRLF 尾部连续回车，第一次占位不发请求且原文／ETag 不变，真实空段条件保存、再输入、逐步撤销重做精确源字节；代码／列表／表格后与段落间空段保存并重开，无转换提示，原文不丢。原 15 项语法／SSE／只读／语义保护继续通过。
- `npx playwright test tests/browser/rich-drag.spec.ts tests/browser/editor-upload-guard.spec.ts`：**5 项通过（15.6s）**，真实拖拽撤销、图片拒绝及极短／极长代码拒绝恢复继续通过。
- `npx oxlint src/editors/milkdown/preserve-source.ts src/editors/milkdown/preserve-source.test.ts tests/browser/editor-preservation.spec.ts` 通过。

首轮新专项中 LF／CRLF 两项通过，但测试在代码块初始尚无 trailing 占位时等待空段超时；列表空尾段点击也落回列表内部，误插入空 list item。已改为先真实操作原块产生 trailing 事务，再明确设置空尾段光标后发送真实 Enter；没有通过伪造正文、服务器响应或删除保存断言绕过。超时轮次只完成部分用例并留下临时 18081 服务，确认其路径为本轮 `/tmp/folio-e2e-.../folio-test-server` 后清理，未触碰日常服务；最终完整 21 项重新执行通过。

边界：多个真实空段使用库已有 HTML `<br />`，不是把所有额外空段从语义中移除，且不会格式化无关原文。既有 `<br>` 与 `<br />` 同语义不同 raw 时，涉及其身份歧义仍可能拒绝，优先保留正文；这类组合未追加真实浏览器专项。未重跑完整业务套件、生产无障碍／性能、后端或真实设备／IME／读屏器，旧记录不作为本次通过。原令牌有效期工作区改动保留，未提交，未重启日常 8080 服务。

### 编辑器行为审查（2026-10-27，仅检查，尚未修复）

用户要求检查更多异常。本轮不修改业务代码，临时探针位于 `/tmp/kilo/folio-editor-audit.spec.ts` 和同目录专用 config，不加入正式测试套件。通过 Vite、隔离真实后端和 Chromium 执行 `npx playwright test --config /tmp/kilo/folio-editor-audit.config.ts --reporter=line`，最终 14 个审查探针完成（50.6s）；其中缺陷用例的断言是确认异常存在，**不是应用功能全部通过**。原工作区未提交的回车修复保留，未重启日常服务。

| 严重程度 | 实际确认行为 | 证据与根因入口 |
| --- | --- | --- |
| P1 | 富文本段落纯文本粘贴静默丢失引用定义／代码 meta 并保存 | 粘贴 `粘贴正文。` 加 `[keep]: /important "必须保留的定义"`，磁盘只剩正文；代码 `filename="important.js"` 消失但代码内容留下。均实际发出一次保存、无警告。engine.ts 的 paste 只处理附件，默认 clipboard 先解析丢失信息，保源检查只看后续 PM，未检查原剪贴板 AST |
| P2 | 正常新建列表被误拦截 | 空段逐键输入 `-`＋空格、`1.`＋空格，以及正文 `Mod-Alt-8` 均不创建 li 并显示语义不一致。实际 list_item 新建默认 spread=true，而单段列表解析 spread=false；已有列表 split 与从段落新建是不同路径，不能靠删除 spread 检查掩盖 |
| P2 | 末尾 Shift+Enter 被拒绝 | `A` 末尾 Shift+Enter 出现语义警告，正文不变；相同操作在 `AB` 中间正常保存为反斜杠硬换行。段末 hardbreak 暂时不能被当前单块序列化／解析表达，缺少与输入态一致的处理 |
| P2 | 尾部占位会变成额外真实空段 | `A` 连续 Enter 两次后，一个真实空段加尾占位；在前一个空段填写 `B`，磁盘得到 `A\n\nB\n\n<br />`，无警告。另用真实 Crepe／PM `splitBlock` 和 `closeHistory` 分组构造 55 个尾部 Enter，撤销 49 次，原第 6 步有 5 个 BR，重建后为 6 个。mappedEmpty 数量推断与缓存淘汰都不能稳定保留占位身份 |
| P2 | 大段落可进入富文本却不能正常改字 | 500001 个普通 `a` 的文件可正常准入，实际插入一个 `b` 被“生成块合计超过保源输入预算”阻止，磁盘与界面仍为原文、未发写请求。准入单份 100 万与编辑前后合计 100 万预算不一致，缺少提前告知或源码分流 |

正常对照：已有列表退出可在外部输入且不弹拒绝；显式空段退格后撤销恢复精确源；段中 Shift+Enter、Mod-Enter 退出代码块输入、普通 Markdown 列表粘贴均可用。因此不能笼统说整个列表、换行或粘贴都失效。列表退出用例同时出现末尾 BR，与上面的占位身份问题一致，不将“未弹拒绝”扩大为完整字节无副作用。

证据区分：粘贴使用浏览器 DataTransfer／ClipboardEvent 注入仅 text/plain，经过实际 clipboard handler 后由真实服务保存，不声称测试了操作系统剪贴板。历史压力使用真实浏览器 Crepe、公开 PM splitBlock／undo／closeHistory 命令，不声称按了 55 次实际键盘。其他常用输入使用实际键盘；临时配置的首轮未等待登录就绪导致全部准备请求 401，一次大请求为代理 502，修正就绪条件后重跑，不算产品缺陷。历史探针初轮光标在段首，得到的是格式重建差异；改为明确段尾后才确认 5→6 个 BR 的内容差异。

边界：本轮针对当前工作区源码的 dev 浏览器交互，不是日常 8080 运行版本或生产包验收；不修改当前业务实现，不宣称上述缺陷已经修复。没有覆盖真实 IME／读屏器／移动设备、所有表格操作与富 HTML 粘贴，未复跑完整回归、性能或后端测试。后续应先修原始粘贴防丢失，再统一创建列表、段内换行和占位状态／资源准入，不应逐项关闭保源检查。

### 编辑器行为修复（2026-10-27，本次实际执行）

在前节 14 项隔离审查证据基础上实施，未修改服务端写入、ETag、草稿或令牌逻辑：

- `engine.ts` 的纯文本 paste／drop 在 Milkdown 剪贴板解析前复用 `preserve-source.ts` 的不支持语法检查；包含引用定义、frontmatter 或 code meta 的文本明确取消插入并提示源码，正文与磁盘保持原样。普通列表文本粘贴、文件上传与原图片拒绝恢复继续执行。
- 通过已安装 GFM list_item schema factory 把**新建**项目的 `spread` 默认调整为 false；解析原有宽松列表的显式 true、任务 checked、父列表序号仍严格保留。实际逐键 `- `、`1. ` 及列表快捷键创建后条件保存与重开验证通过。
- 保源快照记录是否含一个可证明的虚拟尾段，编辑已有空段和淘汰历史后的撤销继续投影该尾段，不能写出多余 `<br />`；原有显式空段、BOM／CRLF 与真实空段的严格回验保留。移除误用“旧稿＋新稿”或“旧稿＋生成块”作为单份 100 万 UTF-16 字符预算的双份门槛，单份候选和 8 MiB 快照限制不变。
- 段末 Shift+Enter 并未通过忽略 hardbreak 修成可持久化：已安装 Milkdown serializer 会删除此处的 hardbreak，纯粹写 `A\\` 加行尾换行会被重新解析为字面反斜杠，`A  ` 加行尾换行也不保留节点；将其在普通段落末尾提前阻止并明确提示“操作未生效”，段中真实硬换行仍正常保存。**这是明确保留的输入能力限制，不将其计作支持段末硬换行。**

本次验证：

| 命令／场景 | 实际结果 |
| --- | --- |
| `npm test` | **14 文件／168 项通过**，含解析前粘贴语法检查、>50 历史快照尾段身份、500001／790000 字符候选与超限保留 |
| `npm run build -- --logLevel warn`、`python3 scripts/copy-dist.py` | 构建及隔离生产资源同步通过；保留既有分块大小提示 |
| `npm run lint` | 通过 |
| `npx playwright test -c playwright.sse.config.ts editor-preservation.spec.ts` | **28 项通过（1.9m）**；原 21 项保源／连续回车回归加 7 项不安全纯文本粘贴、列表创建、尾段填入及段末清晰提示；验证真实磁盘无写、条件写、重开与语义 |
| `npx playwright test tests/browser/rich-drag.spec.ts tests/browser/editor-upload-guard.spec.ts` | **5 项通过（16.2s）**，真实拖拽撤销、图片拒绝及极长／极短代码缓冲拒绝恢复不回归 |
| `/tmp/kilo/folio-editor-audit.config.ts` 的历史／大文件定向复核 | 真实 Crepe 55 次 `splitBlock`、撤销 49 次后 5 个 BR 精确恢复；`A` 的虚拟尾段前填 `B` 后保存 `A\n\nB`、无额外 BR；500001 字符真实服务增加一字保存为 500002，界面与磁盘一致，无警告。临时探针不计入正式套件通过数 |

初轮本阶段新浏览器用例在未同步新版构建时显示旧误拦截，更新生产资源后安全粘贴及列表四项通过；快捷键转换用例初次重开过早，磁盘轮询只检查已有“原文。”而非新列表语法，改为确认服务端 `- 原文。` 保存后重开。最终上述正式 28 项重新执行全过；未删减 P0 保留正文与 ETag 的断言。

边界：粘贴用 DataTransfer 注入真实 `text/plain` 经浏览器剪贴板处理链验证，尚未覆盖操作系统原生剪贴板、仅 HTML 剪贴板与所有 Markdown 方言；拦截危险文本避免丢失，但暂不提供一键自动跳转源码。段末硬换行仍明确不支持，绝不把不可表达的中间态当成已保存。历史压力通过真实浏览器的 Crepe／PM 命令，不声称是逐次实体键盘。未重跑全部业务浏览器或后端 Go、真实手机／IME／读屏器／HTTPS 代理；旧记录不能充作本轮证据。尚未重启日常 8080 服务，本次未创建提交。

### 账号密码最短 8 字节（2026-10-27）

按用户要求将账号密码下限从 12 UTF-8 字节统一降为 8，最大值 1024 不变。修改初始化 admin、创建用户、管理员重置、自助改密和离线密码文件的服务端校验与错误提示；登录继续验证原有密码哈希，既有更长密码不迁移也不失效。前端 `UserSettings`／`SystemSettings` 同样按 `TextEncoder` 字节数在提交前检查，管理员表单不再使用与服务端字节规则不一致的 HTML 字符 `minLength`。分享访问密码是独立协议，本轮未改；Argon2id、登录限速与会话撤销逻辑未放宽。

本次实际验证：

- `go test ./internal/auth -run TestPasswordEightByteMinimumAcrossEntryPoints -v`：通过；7 字节拒绝，8 字节初始化／创建／自助改密／管理员重置并能用新密码登录，离线密码文件按 UTF-8 字节检查（含多字节边界）。
- `LC_ALL=C go test ./...`、`go vet ./...`：通过；部分包命中 Go 缓存。未执行新的 race 检查。
- 前端 `npm run build -- --logLevel warn`、`npm run lint` 与定向 oxlint：通过；生产构建仍有既有大分块警告。
- `npx playwright test tests/browser/user-settings.spec.ts`：最终 **3 项通过（25.3s）**，包含真实服务创建用户、7 字节前端拦截、8 字节自助改密与再登录、管理员重置、既有令牌有效期和实际访问／撤销、明暗及手机布局回归。首轮新测试在登录后直接找系统设置导航失败，先转用户设置后进入系统页；再次登录仍留在用户设置页导致旧断言找不到工作区顶栏，改查真实用户设置标题，随后完整复测通过。没有减少权限或会话断言。

边界：规则单位为 **UTF-8 字节**而非可见字符或口令强度评分，8 字节不保证密码强度；对可联网的实例仍建议使用更长且唯一的随机密码并保留现有限速／TLS。当前浏览器运行使用隔离 Vite 与服务端，未重启日常 8080，未重跑生产包浏览器、真实代理／其他浏览器或全部前端单元测试。本轮未创建提交。
