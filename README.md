# Folio · 文件工作区

轻量、自托管、浏览器优先的 Markdown 与开发文件工作区。真实文件是内容的唯一权威来源。

技术栈：React + TypeScript + Vite、Milkdown Crepe、CodeMirror 6、Go；嵌入式 SQLite 保存账号/会话与可重建搜索索引。UI、必要的代码注释及实现说明默认使用中文。

**当前进度：M0–M2 已通过节点验收，继续 M3。** 已支持真实文件、单用户登录、Markdown/源码编辑、条件自动保存、冲突另存、附件预览与下载、目录整理与回收恢复、中英文搜索和快开。桌面拖拽及键盘操作已接入，外部变更不会自动覆盖本地草稿。单容器 M1 验收已完成（amd64 原生、arm64 QEMU）；M2 验证与边界见 [实施记录](docs/M2.md)。

M3 已接入浏览器本机草稿缓存与显式恢复，入口在底栏“恢复稿”；它不代替磁盘保存和备份。存储权限/配额、数据清除和设备迁移仍有边界，见 [M3 记录](docs/M3.md)。移动端抽屉、文件选择/拍照入口与未确认附件原件保留已接入；双卷备份/新目录恢复工具及隔离演练见 [备份说明](docs/BACKUP.md)。真机相机/软键盘与完整安全和性能验证尚未完成。

## 本地运行

需要 Node.js 22.12+（本次使用 24）、npm、Go 1.27+、Python 3。

```sh
make install
make run
```

打开 <http://127.0.0.1:8080>。账号为 `admin`，首次启动生成的密码位于 `app-data/initial-password`；生产环境建议用 `FOLIO_PASSWORD_FILE` 指定私密密码文件。`make build` 会构建前端并嵌入 Go 二进制，生成 `bin/folio`。`FOLIO_ADDR` 可设置监听地址。本地 `make run` / `make api` 使用回环 HTTP 与非 Secure Cookie；直接运行二进制默认要求 Secure Cookie，部署时需 HTTPS。

开发时分别运行：

```sh
make api  # Go，127.0.0.1:8080
make dev  # Vite，127.0.0.1:5173；/api 代理至 Go
```

## 容器部署

已提供 Dockerfile、Compose、直接 HTTPS/已有代理配置与两种 Linux 架构构建。部署命令、证书、挂载和实际验收边界见 [部署说明](docs/DEPLOY.md)。本地预览仍可使用 `make run`。

## 数据目录与部署配置

- `FOLIO_WORKSPACE`：真实文件目录，默认 `./workspace`。
- `FOLIO_APP_DATA`：账号、会话和可重建搜索索引，默认 `./app-data`。
- `FOLIO_PASSWORD_FILE`：当前用户私有的普通文件（0600），只用于首次初始化账号，后续启动不会重置既有密码。忘记密码见[离线重置说明](docs/PASSWORD.md)。
- `FOLIO_SECURE_COOKIE`：默认 `true`；`false` 仅允许绑定回环 IP。
- `FOLIO_TLS_CERT` / `FOLIO_TLS_KEY`：可选的直接 HTTPS 证书链和私钥，必须同时设置。
- `FOLIO_ORIGIN`：反向代理后的精确外部 origin，例如 `https://notes.example.com`。

两个目录必须独立，不能相互包含。当前需要 Linux 5.6+、`openat2` 和 `/proc/self/fd`。仅支持单实例写工作区；请避免外部工具同时写同一文件。完整边界和剩余工作见 [M1 记录](docs/M1.md)。

上传默认上限为文本编辑 5 MiB、图片 20 MiB、PDF 50 MiB、其他附件 100 MiB，图片预览上限 3200 万像素。可分别用 `FOLIO_MAX_TEXT_BYTES`、`FOLIO_MAX_IMAGE_BYTES`、`FOLIO_MAX_PDF_BYTES`、`FOLIO_MAX_ATTACHMENT_BYTES`、`FOLIO_MAX_IMAGE_PIXELS` 配置，上传总上限最大 1 GiB。设置仅在启动时读取；`GET /api/v1/settings` 返回当前限制。

使用 `Ctrl/Cmd+P` 按文件名/路径快开，`Ctrl/Cmd+Shift+F` 搜索已保存的文本。正文索引默认限制 1 MiB，可用 `FOLIO_MAX_INDEX_BYTES` 调整（1 字节至 100 MiB）；超限与二进制文件仅索引名称。外部文件变化每 10 秒扫描、每 5 分钟完整核对正文，详情见 [M2 实施记录](docs/M2.md)。

PDF 采用浏览器 canvas 预览；加密文档和部分复杂字体/大图应下载原文件核对。SVG/HTML 不作为活动页面打开，未知二进制只提供下载。

## 验证

```sh
make test
```

浏览器测试默认使用 `/usr/bin/google-chrome`；其他路径用 `CHROME_BIN=/path/to/chromium make test`。验证范围与限制见 [M1 实施记录](docs/M1.md)，Markdown 兼容性见 [M0 实现记录](docs/M0.md)。

## 项目文档

- [SPEC](docs/SPEC.md)：产品范围与验收。
- [DESIGN](docs/DESIGN.md)：视觉系统与交互。
- [ARCHITECTURE](docs/ARCHITECTURE.md)：模块边界与数据流。
- [API](docs/API.md)：拟定接口与版本协议；已实现状态见文末。
- [ROADMAP](docs/ROADMAP.md)：M0 至 M3 交付顺序。
- [TESTPLAN](docs/TESTPLAN.md)：可靠性、安全与体验验证。
- [AGENTS](AGENTS.md)：编码约束。
