# Folio · 文件工作区

轻量、自托管、浏览器优先的 Markdown 与开发文件工作区。真实文件是内容的唯一权威来源。

技术栈：React + TypeScript + Vite、Milkdown Crepe、CodeMirror 6、Go；后续使用嵌入式 SQLite 保存索引和应用元数据。UI、必要的代码注释及实现说明默认使用中文。

**当前进度：M0 编辑器验证。** 已有两份内存示例、富文本与源码编辑器、切换保护、明暗主题和 Go 服务骨架。没有真实文件保存，请勿将内存示例用于保存重要资料。刷新前可下载当前草稿。

## 本地运行

需要 Node.js 22.12+（本次使用 24）、npm、Go 1.27+、Python 3。

```sh
make install
make run
```

打开 <http://127.0.0.1:8080>。`make build` 会构建前端并嵌入 Go 二进制，生成 `bin/folio`。`FOLIO_ADDR` 可设置监听地址。

开发时分别运行：

```sh
make api  # Go，127.0.0.1:8080
make dev  # Vite，127.0.0.1:5173；/api 代理至 Go
```

## 验证

```sh
make test
```

浏览器测试默认使用 `/usr/bin/google-chrome`；其他路径用 `CHROME_BIN=/path/to/chromium make test`。验证范围、Markdown 兼容性与已知限制见 [M0 实现记录](docs/M0.md)。

## 项目文档

- [SPEC](docs/SPEC.md)：产品范围与验收。
- [DESIGN](docs/DESIGN.md)：视觉系统与交互。
- [ARCHITECTURE](docs/ARCHITECTURE.md)：模块边界与数据流。
- [API](docs/API.md)：拟定接口与版本协议；除健康检查外尚未实现。
- [ROADMAP](docs/ROADMAP.md)：M0 至 M3 交付顺序。
- [TESTPLAN](docs/TESTPLAN.md)：可靠性、安全与体验验证。
- [AGENTS](AGENTS.md)：编码约束。
