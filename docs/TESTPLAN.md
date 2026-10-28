# 测试与验证计划

本文维护验证策略、入口和长期环境结论，**不是逐次执行日志**。一次任务实际跑了什么、成功或失败、耗时和未覆盖范围写在交付说明；用例数量、构建和镜像证据留在 CI／artifacts／Git，不作为新版本已通过的证明。

## 按风险选范围

| 风险 | 最低关注点 |
| --- | --- |
| P0 | 正文完整、条件写／并发、账号与路径隔离、恢复／未知提交结果 |
| P1 | 编辑输入、模式切换、上传、搜索、分享、令牌与工作流 |
| P2 | 布局、焦点／无障碍、主题、性能与设备体验 |

小修复先复现并执行相关单测／浏览器专项，不默认全量、race 或重复构建。涉及正文、安全、并发或持久化时，相关 P0 自动覆盖不能省略；跨模块、发布或用户要求全面验证时再扩大范围。文档整理只核对内容、命令与链接，不运行无关业务测试。

只使用测试建立的临时目录、账号、浏览器配置及容器，不操作日常笔记或重启日常服务。运行前了解脚本是否启动服务、占用端口或修改嵌入资源；串行协调共享的测试端口，超时后只清理已确认属于本轮的进程。

## 命令入口

以下目录均相对仓库根。Windows 使用 Python／Chrome 的本机路径，中文演练可设置 `PYTHONUTF8=1`，Shell 环境赋值按所在终端调整。

| 目录 | 命令 | 用途 |
| --- | --- | --- |
| `frontend` | `npm run lint` | 前端静态检查 |
| `frontend` | `npx vitest run <相关.test.ts>` | 定向单元测试；全部为 `npm test` |
| `frontend` | `npx playwright test tests/browser/<相关.spec.ts>` | Vite＋隔离真实后端的功能专项 |
| `backend` | `go test ./internal/<相关包> -run '<用例>'` | 后端定向回归 |
| `backend` | `go test ./...`、`go vet ./...` | 全部后端与静态检查 |
| `backend` | `go test -race ./internal/httpapi` | HTTP 并发边界，按风险执行 |
| 根目录 | `make build` | 前端生产构建、嵌入与 Go 程序 |
| 根目录 | `make test` | 广范围前端、Go 与 Linux 主机备份演练 |
| 根目录 | `make qa` | 生产嵌入页面、无障碍／Mermaid／性能 |
| 根目录 | `make backup-test` | Linux 双卷备份恢复演练 |
| 根目录 | `make image`、`make container-test`、`make container-review` | 指定镜像的容器／故障安全验收 |

Go 中依赖 GNU diff 输出的样本需要稳定 locale；必要时显式设置 `LC_ALL=C`，不能把中文输出差异误记为业务通过。Windows 不运行依赖 Linux 原语的备份工具，其他适用用例继续执行并明确跳过原因。

浏览器默认 `/usr/bin/google-chrome`，通过 `CHROME_BIN` 指定其他路径。容器可用 `CONTAINER_ENGINE`、`FOLIO_TEST_IMAGE` 选择引擎／固定镜像；仿真须显式标记，不能当原生硬件结果。

## 应用 API 契约

单元检查嵌入 OpenAPI、权限白名单、索引与单操作文档的一致性；真实请求验证使用项目固定开发依赖，不安装进生产环境：

```sh
uv run --with-requirements scripts/requirements-api-test.txt python scripts/application-api-test.py
```

无 uv 时可在临时 venv 安装同一 requirements 后运行该脚本。它构建临时 Go 服务，建立独立账号／文件，验证全部契约操作、JSON schema、Bearer／Cookie 边界、原字节、条件修改与错误恢复；报告位于 `artifacts/application-api/`，不读取真实 Token。

按场景使用 `playwright.application-api.config.ts` 验证文档页，`playwright.sse.config.ts` 验证外变、通知、列表与保源；它们采用生产嵌入页时，先构建前端并运行 `scripts/copy-dist.py`。不要把 Vite 源码验证描述为生产包验收，改完源码却未同步嵌入产物也不能算新版本已验证。

## 回归主题

| 领域 | 必查场景／主要位置 |
| --- | --- |
| 文件安全 | 越根、链接／硬链接／特殊文件、Unicode／Windows 名称、目录竞争；`storage`／`fileio` |
| 条件提交 | 旧／并发 ETag、无条件拒绝、短写／权限／同步故障、只保留完整旧版或新版；`storage`、HTTP 与 Linux 故障样本 |
| 认证／授权 | Cookie／Token／HEAD、来源／CSRF、禁用／撤销／密码边界、账号工作区、配额与空权限；`auth`／`httpapi` |
| 编辑与保存 | 切文件／模式／设置、异步初始化、保存中输入、迟到响应、拒绝后可见状态、关闭保护；`sessions`、workbench／files／editor 专项 |
| Markdown | 常见语法、危险输入、粘贴、列表创建与退出、围栏、空段／虚拟尾段、hardbreak、缓存滚动、逐步／分组 undo／redo、转换确认与取消 |
| 原始字节 | BOM、LF／CRLF／CR／混合分隔、无末尾换行、按行片段与 diff、API／磁盘直接比对；line-endings 与契约演练 |
| 上传与引用 | 类型／像素／大小、配额、重复及不完整 multipart、流中失败、成功上传但插入拒绝、原件下载／重试；attachments／editor-upload-guard |
| 外变与搜索 | 宿主写入、同大小／mtime、移动／删除、重连、草稿保护、通知接受／等待／回滚、索引损坏与定位；external／sse／search |
| 恢复与标签 | IndexedDB 失败／未知格式、多页面同路径、刷新／重启、身份变化、不覆盖副本、上传跨认证、标签恢复不误写；recovery／tabs |
| 分享 | 快照／实时、白名单、版本陈旧、资格／限速／计次、暂停／到期、quota、转存隔离、不覆盖及失败保留；sharing／share 专项 |
| 实际操作 | 鼠标拖拽、键盘／触屏替代、碰撞和批量关闭失败保留；workflow／rich-drag／mobile |

正文保留必须核对实际磁盘／响应字节和版本，不以 DOM 看起来相同代替；只拒绝请求还应确认未创建、未覆盖或可恢复。源码、浏览器缓冲和磁盘三者不一致必须明确报告。

## 视觉、无障碍与性能

按改动覆盖桌面／平板／手机、明暗主题、长名／宽代码、空／加载／错误、软键盘和减少动态效果。axe 不排除编辑器以隐藏问题，另检查 Chromium AX、键盘退出、焦点循环／返回及抽屉与弹窗交接。

性能用例检查大量文件、搜索、较大正文输入和完整保存字节，原始报告位于 `artifacts/qa/`。不要调高门槛、删样本或把三次测量称为 p95。当前搜索门槛偏差及待复核范围统一见 [产品规范](SPEC.md#已知限制与待办)，存在未通过项时不得称完整 QA 全绿。

注入 DOM／剪贴板／拒绝事务的探针用于对应故障路径，不冒称真实 OS 剪贴板、相机、原生手势或普通允许路径。浏览器视口仿真不是实际手机，axe 通过不是完整 WCAG 或读屏认证。

## 持久化故障与平台

Linux 子进程的 `RLIMIT_FSIZE`／SIGKILL 只覆盖指定故障点，不等价真实磁盘满或全部断电阶段。容器安全演练使用独立小 tmpfs 制造 ENOSPC，核对旧正文、草稿下载／恢复、释放空间后的条件保存；不得填满宿主盘。

容器验收使用独立两卷、HTTPS 和持久浏览器，覆盖关闭浏览器、重启、正文／会话／冲突／回收、停服离线改密。备份演练核对 WAL 合并只发生在复制件、校验失败拒绝、新目录不覆盖、旧会话／Token 失效、分享快照与后续保存。部署／恢复步骤由 [README 升级与备份](../README.md#升级与备份) 维护。

证据保存到 `artifacts/container/`、`artifacts/security/`、`artifacts/backup/`，绑定命令、时间、平台与镜像摘要。交叉编译、Wine、QEMU、原生设备和真实 Docker／Podman 分开描述；Windows 无链接权限时只跳过对应样本，不得称链接安全已实测。备份工具仍为 Linux 专用。

真实 HTTPS 代理缓冲、其他浏览器、真实移动设备／IME／读屏器、Windows／NTFS 不同权限和持久性等不能由一次本机通过推断。已有历史实测与当前未验证环境分开，待验证事项统一见 [产品规范](SPEC.md#已知限制与待办)。

## 维护与历史

新增长期测试入口、策略或环境结论才修改本文。日常命令和结果写交付说明，失败如实报告，不能用旧通过数代替本次执行；不要在本文继续追加“本轮最终结果”。

重编前的完整过程记录已存在 Git，未另建重复归档：

```sh
git show 31e505a:docs/TESTPLAN.md
git log -- docs/TESTPLAN.md
```
