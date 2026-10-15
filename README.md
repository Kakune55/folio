# Folio · 文件工作区

轻量、自托管、浏览器优先的 Markdown 与开发文件工作区。真实文件是内容的唯一权威来源。

技术栈：React + TypeScript + Vite、Milkdown Crepe、CodeMirror 6、Go；后续使用嵌入式 SQLite 保存索引和应用元数据。UI、必要的代码注释及实现说明默认使用中文。

**当前进度：M1 实施中。** 已连接真实文件，支持单用户登录、目录与文本创建、Markdown/源码编辑、条件自动保存和冲突另存副本。上传、回收站、文件预览和容器交付尚未完成。未成功保存的草稿仍只驻留在页面内存中，可下载保留。

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

## 数据目录与部署配置

- `FOLIO_WORKSPACE`：真实文件目录，默认 `./workspace`。
- `FOLIO_APP_DATA`：账号、会话和后续索引，默认 `./app-data`。
- `FOLIO_PASSWORD_FILE`：只用于首次初始化账号，后续启动不会重置既有密码。
- `FOLIO_SECURE_COOKIE`：默认 `true`；`false` 仅允许绑定回环 IP。
- `FOLIO_ORIGIN`：反向代理后的精确外部 origin，例如 `https://notes.example.com`。

两个目录必须独立，不能相互包含。当前需要 Linux 5.6+、`openat2` 和 `/proc/self/fd`。仅支持单实例写工作区；请避免外部工具同时写同一文件。完整边界和剩余工作见 [M1 记录](docs/M1.md)。

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
