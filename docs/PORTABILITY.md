# 标准库文件层与 Windows

2026-10-16。按用户决定，权限隔离交给运行用户和部署，通用文件操作采用 Go 标准库。此变更不替换 React/编辑器/Go/SQLite 技术栈，不增加业务功能。此前 ACCEPTANCE/M1/M3 中的镜像与安全测试属于对应历史构建。

## 当前实现

- `internal/storage/{storage,attachments,entries,scan}.go`：使用 `os.Root`、`os.File`、`io` 和标准库摘要实现读取、条件保存、上传、移动、回收恢复和索引扫描；不再依赖 `openat2` 或 `/proc/self/fd`。
- `internal/auth/private.go`：普通文件检查与有界密码读取；账号 SQLite 在受信任的 app-data 中按绝对路径打开。不再强制校验 Unix UID、0700/0600 或硬链接数，也不在配置加载时修改已有数据目录权限。新目录/文件仍使用保守的创建权限。
- `internal/fileio/files.go`：共享的根内文件检查、同步和 Windows 盘符兼容 SQLite URI。SQLite、Argon2id、WebP 解码仍使用原有依赖；“标准库优先”针对文件层，不声称整个项目零依赖。
- 只保留三个必要的平台操作：不覆盖的跨父目录移动、退出自动释放的实例锁、稳定目录身份。它们集中在 `internal/fileio/platform_{linux,windows}.go`，使用已有 `x/sys`，不手写动态系统调用。标准库目前没有这些操作的完整跨平台等价 API。
- Linux 继续使用 renameat2(RENAME_NOREPLACE)、flock 和原来的设备号/inode 身份格式，兼容已存浏览器恢复稿命名空间以及 Python 备份锁。Windows 使用不带覆盖标志的 MoveFileEx、LockFileEx 和卷/文件 ID。
- 原文件保存仍先写同目录独占临时文件、同步、复核 ETag，再通过 `os.Root.Rename` 替换；不先删除原件。创建/上传/移动/恢复碰撞仍由系统拒绝覆盖。失败不确认保存成功，客户端保留草稿。

## 部署信任边界

运行用户和目录权限/ACL 由部署者配置：app-data、密码、密钥与备份不能授权给不受信任的本地用户。应用不防御恶意同用户程序，也不支持本机程序并发替换工作区父目录、挂载点、符号链接或特殊文件；这种目录命名空间的变化需停服处理。正常外部正文编辑仍受 ETag、打开文件检查及周期核对保护，但不保证对非协作外部写入者的全局文件系统 CAS。

HTTP 请求仍必须通过登录、CSRF/Origin 与工作区路径校验。`os.Root` 提供防逃逸的根内解析；静态符号链接和特殊文件在实际打开前拒绝。此类型检查不是对恶意本机特殊文件替换竞态的防御；不能将不受信任用户可写的目录用作工作区。

硬链接和工作区内嵌套挂载由部署者管理，不再作为隔离边界拒绝。保存通过替换工作区内的文件名保留其他硬链接的原字节；不能用硬链接绕过宿主机权限安排。独立 Python 备份工具仍会明确拒绝硬链接/嵌套挂载，需先整理或使用适合该数据布局的停服备份方案。

API 文件名统一拒绝盘符、NTFS 数据流冒号、Windows 设备名、尾部点/空格及 Windows 非法字符。原有 Linux 文件若使用这些名称不会被删除，但需先用本机工具重命名后才能通过应用访问。Windows 文件名大小写规则由文件系统决定，不承诺 Linux 大小写同名文件能原样迁移。

Windows 不执行 Unix 目录 fsync；普通文件 Sync 失败仍明确报错。回收前同步普通文件时，Windows 需额外打开可写句柄；权限不足则保留原件并失败。Windows 的标准库重命名没有通用原子性保证，因此尚不承诺 Windows/任意文件系统的断电持久性或与 Linux 相同的全部崩溃保证。Windows MoveFileEx 的父路径属于上述受信任目录边界。

## Windows 本地运行

使用 PowerShell，需要 Node.js 22.12+、Go 1.27+；前端嵌入脚本需要 Python 3。无需 WSL、Make 或额外数据库服务。在项目根目录执行：

```powershell
cd frontend
npm ci
npm run build
cd ..
python scripts/copy-dist.py
cd backend
go build -o ../bin/folio.exe ./cmd/server
cd ..
$env:FOLIO_SECURE_COOKIE = "false"
.\bin\folio.exe
```

打开 http://127.0.0.1:8080 。账号为 admin；仅首次自动初始化时生成的密码可用 `Get-Content .\app-data\initial-password` 查看。app-data 已存在时不重置原密码。HTTP 模式仅允许回环监听；公网部署仍应配置 HTTPS。目录使用本机普通磁盘；网络盘、UNC、大小写敏感目录、杀毒软件文件占用等尚未做真机验收。

开发前端时可启动两个 PowerShell 终端，根目录分别执行：

```powershell
# 终端一
$env:FOLIO_SECURE_COOKIE = "false"
$env:FOLIO_WORKSPACE = "$PWD\workspace"
$env:FOLIO_APP_DATA = "$PWD\app-data"
cd backend
go run ./cmd/server
```

```powershell
# 终端二
cd frontend
npm run dev
```

打开 http://127.0.0.1:5173 。前端热更新，API 转发 8080；Go 修改后重启终端一。不可与另一个使用相同数据的实例同时启动。

## 验证范围

本次实测：

- `make test` 通过：lint、20 个前端单元、35 个浏览器测试、全部 Go 包及主机双卷备份恢复。计数针对当前工作树，包含本轮之前已有的前端修改；本轮未改动前端实现。
- `make qa` 通过：5 个生产构建无障碍/性能流程，包含 1202 文件、中文搜索与较大正文编辑保存。
- `cd backend && go test ./... && go vet ./...` 通过；包含 Linux 跨设备回收、部分写入、进程终止、权限失败、条件保存、路径竞态及原文保护。
- Linux 程序与 `GOOS=windows GOARCH=amd64 go build` 成功。Windows 测试代码也通过全包交叉编译（使用 `go test -exec /bin/true`，只验证编译，不冒称执行）。
- Wine 11.0、独立临时前缀执行 Windows PE 测试，11 项通过：不覆盖移动/锁释放、根隔离与身份、条件并发保存、文件/目录移动碰撞、回收恢复与隔离原件恢复、Windows 文件名、硬链接原文保护、离线改密/撤销/事务回滚及认证 HTTP 文件流程。首次执行发现只读句柄同步失败，修正后上述测试全部通过。
- 日志位于本机 `/tmp/folio-stdlib-{test,qa,windows}.log`，Windows 检查仅创建自己的临时 Wine 前缀，结束后停止其服务并清理；没有访问用户 Wine 配置和真实笔记。

Windows 交叉编译、Wine 执行和真实 Windows/NTFS 是不同层次，不能相互替代；尚无真实 Windows 机器和 NTFS 故障/占用/持久性验收，也没有为本轮重新验收容器镜像。独立 Python 备份/容器驱动仍是 Linux 工具；Windows 原生离线备份暂不提供，停服后需要成对保护 workspace 与 app-data，不能复制运行中的 app.db 主文件冒充完整备份。

## 多账号本轮 Windows 验证

2026-10-16 后续增加简单多账号；当前真实 Windows x64 的构建、Go 回归、浏览器与生产页面 QA 结果、符号链接权限跳过及未验证环境统一见 [MULTIUSER.md](MULTIUSER.md)。本文此前“尚无真实 Windows”仅描述文件层改造当时的记录；本轮 Windows 日常流程实测不能替代 NTFS 故障/占用/断电保证。
