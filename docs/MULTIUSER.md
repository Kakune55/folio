# 简单多账号系统

2026-10-16，本次开发基于现有 M0–M3 文件工作区，不提供旧单账号迁移。React / TypeScript / Vite、Milkdown Crepe、CodeMirror 6、Go 单进程与嵌入式 SQLite 保持不变。

## 已实现

- 首次初始化 admin 为唯一管理员，默认配额 5 GB；不开放注册、账号删除或角色变更。
- /system-setting 用户管理：搜索、20 条分页、创建、修改用户名、启用/禁用、调整配额、独立重置密码。普通用户页面拒绝访问，API 返回 403。
- 每个账号的正文位于 workspace/<用户ID>/，搜索与回收站位于 app-data/<用户ID>/；app-data/app.db 保存账号和会话。管理员管理元数据，不提供查看其他用户正文的入口。
- 登录可填写用户名；禁用账号和改密事务撤销指定账号的所有会话。个人账号设置验证原密码，离线改密恢复 ID 1 管理员并撤销全部会话。
- 左下角显示用户名及已用/配额，各自自适应 B / KB / MB / GB / TB，采用 1024 换算；读取失败提供重试。
- 正文、附件和回收载荷计费；降低配额不删除文件，超额允许读取、下载、缩小和恢复，拒绝增长。完整回收记录可确认永久删除来释放额度，损坏/未完成记录保留。
- 正文更新保留 ETag 条件写；上传同时流式限制、提交前在存储锁内复核额度，失败不发布目标。额度故障不静默放行增长。
- 系统设置与工作区切换保留编辑器实例及标签；移动端先关闭目录抽屉。退出登录先处理正文和待上传原件，再整页重载；其他账号在旧页面登录会触发身份冲突和下载入口。
- 移除侧栏和登录页的宣传说明文案，保留错误、恢复和危险操作提示。

## 主要涉及文件

| 文件 | 变更 |
| --- | --- |
| backend/internal/auth/{auth,users,reset}.go | 多用户账号、用户会话、账号管理、自助/管理员改密 |
| backend/internal/httpapi/{accounts,users,api,entries,router}.go | 按登录账号分派独立资源、管理员 API、配额与永久删除接口、页面直达 |
| backend/internal/storage/{storage,attachments,quota}.go | 正文与流式上传额度检查、用量、永久删除 |
| backend/internal/fileio/usage.go、internal/trash/repository.go | 安全遍历统计、回收载荷计费和根类型校验 |
| backend/cmd/server/main.go | 多账号资源生命周期 |
| frontend/src/features/auth/{Login,AccountControls,SystemSettings}.tsx | 登录、个人设置、配额与用户管理 |
| frontend/src/app/{App,Workbench,Spike}.tsx、services/{api,format}.ts、styles/app.css | 路由切换保留编辑器、接口与主题布局、移除文案 |
| frontend/src/features/explorer/TrashDialog.tsx | 永久删除确认 |
| backend/internal/httpapi/accounts_test.go、storage/quota_test.go | 跨账号、安全和配额回归 |
| frontend/tests/browser/users.spec.ts | 管理、权限、配额失败恢复、个人改密、编辑器保留及三视口 |
| Playwright 配置、测试夹具和 scripts/test-api.py | Windows Python/可执行文件、用户目录、共享 LF 快照及平台快捷键 |
| scripts/backup.py、backup-test.py | 多账号数据库校验、用户缓存排除和目录夹具；未执行 Linux 演练 |
| README.md、docs/{SPEC,DESIGN,ARCHITECTURE,API,ROADMAP,TESTPLAN,PASSWORD,BACKUP,PORTABILITY}.md | 同步范围、协议、设计与验证边界 |

## 本次实际验证

环境为 Windows x64、PowerShell、本机 Chrome 155；测试创建独立临时账号和目录，没有向日常工作区写入测试正文。

| 命令 | 实际结果 |
| --- | --- |
| cd backend; go test ./... | 全部 Go 包通过；当前 Windows 无符号链接权限，链接子场景跳过或明确记录，其余断言继续 |
| cd backend; go vet ./... | 通过 |
| cd frontend; npm run build | 通过；仍有现有编辑器大分块提示 |
| cd frontend; npm run lint | 通过，无告警 |
| cd frontend; npm test | 5 个文件、20 项通过 |
| CHROME_BIN 指定本机 Chrome；npx playwright test | 38 项中 37 项通过；剩余快照项仅为基准文件 CRLF/LF 差异，固定跨平台 LF 后单项复测通过。此前 Windows 重做快捷键差异已修复并在这轮全量通过 |
| npx playwright test tests/browser/workbench.spec.ts --grep 'Markdown 真实 Crepe 往返快照' | 修复基准 LF 后，1 项通过；序列化结果与旧 Linux JSON 内容相同，未放宽正文断言 |
| npx playwright test tests/browser/users.spec.ts | 最新无障碍名称修复后 3 项复测通过，包含明暗 axe 扫描、1440/1024/390 截图、配额不足保留正文和扩容重试、个人改密重新登录 |
| npx playwright test -c playwright.qa.config.ts | 性能及手机明暗 3 项通过，桌面 2 项发现新增用户名按钮辅助名称缺少可见用户名；已修复根因 |
| npx playwright test -c playwright.qa.config.ts tests/qa/accessibility.spec.ts | 修复后 4 项桌面/手机明暗无障碍流程全部通过；不是完整 WCAG 或真实读屏器认证 |
| python -m py_compile scripts/backup.py scripts/backup-test.py scripts/test-api.py | 通过，仅语法验证 |
| python scripts/copy-dist.py；cd backend; go build -o ../bin/folio.exe ./cmd/server | 通过，实际前端已嵌入本地程序 |
| 嵌入页面实际浏览器登录与 /system-setting 直达 | 通过：ID 1 管理员、用量 0 B、默认 5 GB；产物 artifacts/multiuser-production.json 与截图 |

生产性能流程真实创建 1202 文件，验证 162508 字节 Markdown 和 1060800 字节文本编辑后的完整保存内容；报告在 artifacts/qa/performance.json。其后仅修改账号按钮辅助名称和用量语义角色，没有改变文件或编辑器实现。

M0–M3 与 PORTABILITY 原有 Linux/Wine/容器结果属于历史构建，未用于宣称本次多账号完成对应环境验收。测试首轮失败、修复与分项复测按上述实际情况列出，不宣称一次全量全绿。

## 本地开发数据与运行

直接递归删除旧数据被执行策略拒绝，改为安全移至 artifacts/dev-reset-20261016-multiuser/{workspace,app-data}/；当前根目录的 workspace 与 app-data 已全新初始化，没有数据迁移。归档包含旧账号和文件，应按私有数据保管，未提交版本库。

本地已启动 bin/folio.exe，地址 http://127.0.0.1:8080；账号 admin，新初始密码位于 app-data/initial-password。未将密码写入交付日志或源码。若旧浏览器页面仍打开，应重新加载；旧工作区恢复稿不会自动应用到新账号空间。

## 限制与风险

- 配额为应用管理文件的逻辑字节用量，不是宿主磁盘硬配额；临时写入、回收跨盘复制和索引需要额外磁盘空间。本机外部工具可使用户超额，下次统计会显示并阻止应用内增长。
- HTTP 隔离不代替宿主账号/ACL；同一系统用户或持有 app-data/备份的人可访问所有账号数据。浏览器草稿按命名空间做界面隔离，不防御同一浏览器配置下的恶意脚本、扩展或开发者工具。
- 禁用和改密拒绝后续会话请求，已经开始的请求可能完成；并非即时中止正在传输的响应。
- 用户资源惰性打开后缓存到进程退出，适用于小规模账号；未做大量账号/高并发压力测试或空闲资源驱逐。
- 当前 Windows 链接场景没有权限实测，未执行多账号 Linux 双卷备份恢复、容器镜像、真实外部 HTTPS 代理或故障注入验收；Windows 持久性边界仍按 PORTABILITY。
- 永久删除是用户明确确认后的不可逆操作；失败时需刷新回收站核对结果。未完成/损坏记录不自动清理。
- 暂不支持旧结构迁移、公开注册、账号删除、角色调整、共享工作区与跨账号文件管理。
