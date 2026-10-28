# Folio

[![Release](https://img.shields.io/github/v/release/Kakune55/folio?style=flat-square)](https://github.com/Kakune55/folio/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/kakune55/folio?style=flat-square&logo=docker)](https://hub.docker.com/r/kakune55/folio)
[![Stars](https://img.shields.io/github/stars/Kakune55/folio?style=flat-square&logo=github)](https://github.com/Kakune55/folio)
[![License](https://img.shields.io/github/license/Kakune55/folio?style=flat-square)](LICENSE)

Folio 是一个自托管的轻量 Markdown 和开发文件工作区，可在浏览器使用，旨在提供一个简洁的文档编辑体验，并且可以灵活地管理你的文件。

在 Folio 中，所有文件都是普通文件，没有专有的块数据库，也没有自定义 Markdown 语法。如果你不喜欢 Folio，可以随时停止使用，文件仍然可以用任何文本编辑器打开，也可以用常规方式备份。不造成任何负担。

如果你想要尝试 Folio，请查看下面的 [快速开始](#快速开始) 了解如何安装和配置。  
也可以使用 [demo 站点](https://demo.folio.128bit.cc) 体验 Folio 的功能。每UTC时间0点清理数据，账号密码`folio` `foliodemo`
## 功能

- **文件管理**：文件树和标签页，支持新建、重命名、移动、上传、下载和回收恢复。Markdown 图片使用相对路径，不要求放进固定目录。
- **编辑**：Markdown 有富文本和源码两种模式，支持所见即所得编辑。其他 UTF-8 文本也可以用源码模式编辑。
- **搜索与预览**：支持文件名和正文的全文搜索，统一入口，一次输入，即可快速找到所需内容。
- **分享**：支持方便易用的分享功能，生成只读链接，支持密码、到期时间和访问次数。如果你的朋友同样使用了来自同一 Folio 实例的链接，他们可以直接访问你分享的内容，并保存在自己的工作区中。
- **API**：为了提供程序化访问，Folio 提供了一套完整的 API，支持文件管理、搜索、分享和回收站操作，确保外部客户端可以安全地操作你的文件。
- **Agent**：得益于 API 功能，Folio 同时也提供了 Agent.md 便于外部Agent使用API来为你执行各种操作。

## 快速开始

Folio 是单个可执行文件，内置前端资源。选择下面任意一种方式运行；首次启动会自动生成管理员密码。

无论哪种方式，都建议放在 HTTPS 之后：可以直接提供证书，或使用反向代理（例如 Caddy、Nginx），并把 `FOLIO_ORIGIN` 设为实际访问地址。

### 二进制

从 [GitHub Releases](https://github.com/Kakune55/folio/releases) 下载对应平台的压缩包（Linux amd64／arm64／armv7，Windows amd64／arm64），解压得到 `folio`（Windows 为 `folio.exe`），并用同名的 `.sha256` 文件校验。

```sh
tar -xzf folio_1.3.1_linux-amd64.tar.gz
./folio
```

默认监听 `127.0.0.1:8080`，数据和正文分别写入当前目录的 `app-data/` 与 `workspace/`。首次生成的管理员密码在 `app-data/initial-password`，账号为 `admin`。

直接提供 HTTPS：

```sh
FOLIO_ORIGIN=https://notes.example.com \
FOLIO_TLS_CERT=/路径/fullchain.pem \
FOLIO_TLS_KEY=/路径/privkey.pem \
./folio
```

### Docker

镜像发布在 Docker Hub 的 `kakune55/folio`。仓库中的 [docker-compose.yml](docker-compose.yml) 可直接使用：

```yaml
services:
  folio:
    image: kakune55/folio:latest
    ports:
      - "16111:8080"
    volumes:
      - ./workspace:/workspace
      - ./app-data:/app-data
    environment:
      FOLIO_ORIGIN: https://folio.example.com
    restart: unless-stopped
```

```sh
docker compose up -d
```

容器内已监听 `0.0.0.0:8080` 并使用 Secure Cookie，请通过 HTTPS 反向代理访问，不要把端口直接暴露到公网。若确实要在本机用 HTTP 直连，需在回环地址下设置 `FOLIO_SECURE_COOKIE=false`。

需要本地构建镜像时，可用 [compose.yaml](compose.yaml) 配合 `make image`；配置见 [Dockerfile](Dockerfile)。

### 从源码运行

需要 Node.js 22.12+、npm、Go 1.27+ 和 Python 3；Linux 备份工具另需 Python 3.11+。

```sh
make install
make run
```

访问 <http://127.0.0.1:8080>。开发时可在两个终端分别运行 `make api` 和 `make dev`，访问 <http://127.0.0.1:5173>，`/api` 代理到 8080。`make build` 会把前端嵌入并输出 `bin/folio`。

### 配置

| 变量 | 默认值／用途 |
| --- | --- |
| `FOLIO_WORKSPACE` | `./workspace`，正文与附件位于 `<用户ID>/` |
| `FOLIO_APP_DATA` | `./app-data`，账号库、各用户索引、回收站和分享快照 |
| `FOLIO_ADDR` | `127.0.0.1:8080` |
| `FOLIO_PASSWORD_FILE` | 仅首次初始化使用的私有普通密码文件 |
| `FOLIO_SECURE_COOKIE` | `true`；`false` 只允许回环 IP |
| `FOLIO_TLS_CERT`／`FOLIO_TLS_KEY` | 直接 HTTPS 证书与私钥，须同时设置 |
| `FOLIO_ORIGIN` | 精确外部来源，例如 `https://notes.example.com` |
| `FOLIO_MAX_TEXT_BYTES` | `5 MiB`，文本编辑上限 |
| `FOLIO_MAX_IMAGE_BYTES` | `20 MiB`，图片上限 |
| `FOLIO_MAX_PDF_BYTES` | `50 MiB`，PDF 上限 |
| `FOLIO_MAX_ATTACHMENT_BYTES` | `100 MiB`，其他附件上限 |
| `FOLIO_MAX_IMAGE_PIXELS` | `3200 万`，图片像素上限 |
| `FOLIO_MAX_INDEX_BYTES` | `5 MiB`，正文索引上限 |

环境变量提供启动初值；管理员在线保存的文件／索引限制以 `app.db` 持久值为准，重启保留，索引上限变化自动重建。降低限额不会删除文件，但已有超限文本可能需恢复上限后才能编辑，仍可下载原件。

`workspace` 与 `app-data` 必须独立、不能相互包含，且只允许一个实例写同一工作区。运行用户、权限和 ACL 是本地信任边界，外部工具不要与 Folio 同时修改同一文件。使用代理时需允许 SSE 流式响应。

### 升级与备份

升级前保存或下载未保存草稿和待上传原件，停服并成对备份 `workspace` 与 `app-data`，再替换二进制／镜像并重启。只构建不会更新运行中的旧进程。`app-data` 不只是缓存：账号、会话、回收站和分享快照不能删除，只有搜索索引可重建；本机草稿和标签缓存不属于服务器备份。

离线重置管理员密码须停服并先备份，使用同一二进制与现有 `app-data`，密码通过私有普通文件提供，不用明文命令行参数：

```sh
./bin/folio -reset-password -app-data ./app-data -password-file /私有路径/new-password
```

Linux 双卷备份工具支持 amd64／arm64，需 Python 3.11+、`openat2`／`renameat2` 和 `/proc`，不适用于 Windows：

```sh
python3 scripts/backup.py backup  --workspace ./workspace --app-data ./app-data --output /备份位置/新目录
python3 scripts/backup.py verify  --backup /备份位置/新目录
python3 scripts/backup.py restore --backup /备份位置/新目录 --output /恢复位置/新目录
```

备份与恢复均须停写。恢复只发布到不存在的新目录，不覆盖原数据；保留账号密码与分享数据，清除旧登录、Access Token 及访客资格，搜索索引随后重建。核验后再切换数据目录，保留原件作为回退。

宿主直接修改文件不会触发搜索更新或 SSE，需要时在搜索窗口重建索引，或重启服务后访问工作区；打开文档仍有版本核对与冲突保护。

## 参与项目

欢迎贡献代码、报告问题或提出功能建议。本项目基于 MIT 许可证开源。
如果 Folio 对你有帮助，欢迎点亮一个 Star。