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
