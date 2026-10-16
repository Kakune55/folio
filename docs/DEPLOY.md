# 单容器部署

Folio 将 Vite 构建结果嵌入 Go 静态二进制，运行镜像基于 scratch，只包含程序和初始空目录。默认 UID/GID 为 1000:1000，无 shell、无外部数据库或云服务。

两个持久目录：

| 挂载点 | 内容 |
| --- | --- |
| `/workspace` | Markdown、源码与附件，正文唯一权威 |
| `/app-data` | SQLite 账号/会话与可重建索引、回收站、TLS 证书及引导密码 |

构建上下文使用白名单，默认 workspace/app-data、本地 `.env`、浏览器配置与构建产物不会进入镜像。不要把私密工作区或密钥放入应用源码目录。

## 本地 HTTPS 试用

需要 Linux、Docker + Compose、OpenSSL 以及 Python 3（证书脚本清理临时目录使用）。此方式仅发布回环端口，不是公网部署。

```sh
make tls
export FOLIO_UID="$(id -u)" FOLIO_GID="$(id -g)"
docker compose up --build -d
```

打开 **https://localhost:8443**。脚本生成 30 天有效的本地自签名证书，浏览器需要信任它。已有 TLS 目录不覆盖；存在不完整证书对时明确失败。可将受信任的证书链和私钥放入 `app-data/tls/server.crt`、`app-data/tls/server.key`，密钥应只允许运行用户读取。

账号 `admin`，首次启动生成的密码在 `app-data/initial-password`。不要把密码文件或 app-data 加入版本库。账号初始化之后，此引导文件可删除；数据库中的密码哈希保持有效。忘记密码时使用 [离线密码重置](PASSWORD.md)，不能删除整个 app-data 或仅改引导文件。`FOLIO_PASSWORD_FILE` 与离线密码文件均要求当前运行用户私有的普通文件（0600），拒绝链接与特殊文件；密码读取有界。

```sh
docker compose logs --tail 30
docker compose ps
docker compose restart
docker compose down
```

停止/重建容器不会删除两个 bind mount 的文件。不要在同一工作区同时运行本机 `make run` 与容器；app-data 独占锁只能阻止共享同一 app-data 的实例，不能代替部署保证单实例。

更改端口用 `FOLIO_PORT`，默认 origin 同步为 `https://localhost:<端口>`。若使用其他域名或访问地址，必须显式设置精确的 `FOLIO_ORIGIN`，不能包含路径或末尾 `/`。访问地址与 origin 不一致会被 CSRF 来源校验拒绝。

## 已有 HTTPS 反向代理

代理属于现有部署环境，不随 Folio 增加常驻服务。让已有代理终止受信任的 TLS，并转发到仅发布在回环地址的容器 HTTP 端口：

```sh
mkdir -p workspace app-data
chmod 0700 app-data
export FOLIO_UID="$(id -u)" FOLIO_GID="$(id -g)"
export FOLIO_ORIGIN=https://notes.example.com
docker compose -f compose.yaml -f deploy/compose.proxy.yaml up --build -d
```

此覆盖文件关闭容器内 TLS；安全 Cookie 仍开启。代理 upstream 默认是 `http://127.0.0.1:8443`，应正确转发 Host、Cookie、请求体和错误状态。上传限制需要与代理的请求体限制协调，不能把 412/413/428 转换成成功页面。登录限速按服务看到的连接源 IP，尚不信任任意转发头。

公网暴露前仍需完成 M3 安全与恢复审查，当前默认只发布回环端口。

## 镜像与架构

```sh
make image
# Buildx 在具备相应构建器的环境中构建两种 Linux 架构：
mkdir -p artifacts/container
docker buildx build --platform linux/amd64,linux/arm64 \
  -t your-registry/folio:version --output type=oci,dest=artifacts/container/folio.oci.tar .
```

上例只生成本地 OCI 归档，没有推送镜像；发布需要由操作者显式选择。本次 Podman 默认 OCI 转换会移除 Docker 专有 HEALTHCHECK 元数据，交付归档已改用 v2s2 清单保留。其他工具导出后应核对配置；`/folio -healthcheck` 功能始终保留在程序中。Node/Go 基础镜像锁定多架构 index digest；前端在构建机架构运行，Go 以 CGO_ENABLED=0 交叉编译，运行层不执行外架构构建命令。二进制最低依赖 Linux 5.6+ 的 openat2 与可用的 `/proc/self/fd`，不做有竞态的降级。

Compose 配置只读根文件系统、临时 `/tmp`、drop-all capabilities、no-new-privileges、非 root 用户和两个可写数据挂载。`/folio -healthcheck` 检查进程 liveness，不初始化目录、不拿实例锁；直接 TLS 模式信任配置的公开证书并校验主机名，不跳过证书验证。

证书续期后需重启 Folio；没有内置 ACME/自动续期服务。`FOLIO_TLS_CERT` 与 `FOLIO_TLS_KEY` 必须成对设置。安全 Cookie 默认开启；关闭它仍只允许绑定回环 IP，不为容器添加任意明文公网监听例外。

## Rootless Podman

同一 Dockerfile 可用 Podman 构建。rootless bind mount 需要 `--userns=keep-id`，例如：

```sh
make CONTAINER_ENGINE=podman image
podman run --name folio -d --userns=keep-id \
  --user "$(id -u):$(id -g)" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=128 --memory=512m \
  --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m \
  -p 127.0.0.1:8443:8080 \
  -v "$PWD/workspace:/workspace" -v "$PWD/app-data:/app-data" \
  -e FOLIO_ORIGIN=https://localhost:8443 \
  -e FOLIO_TLS_CERT=/app-data/tls/server.crt \
  -e FOLIO_TLS_KEY=/app-data/tls/server.key \
  folio:local
```

不要求修改 Docker socket 权限、加入特权组或以 privileged 模式运行。

## 复现容器验收

需要已构建的镜像、本机 Node.js/Playwright/Chromium、Python 3 和 OpenSSL。测试自行创建临时工作区、app-data、自签名证书和独立浏览器配置；不访问使用者的两个数据目录。

```sh
make install
make image
make container-test
# 本机 Docker daemon 无权限时：
make CONTAINER_ENGINE=podman image
CONTAINER_ENGINE=podman make container-test
```

用 `FOLIO_TEST_IMAGE` 指定镜像，用 `CHROME_BIN` 指定浏览器。`FOLIO_TEST_QEMU=/absolute/path/qemu-aarch64` 可显式运行 arm64 仿真测试，不修改宿主 binfmt；此模式以 QEMU 执行 `/folio` 及健康命令，不能冒充原生硬件验证。

测试包括创建目录、Markdown/JSON 编辑、粘贴图片、切换、自动保存、下载、关闭浏览器、重启容器、重新启动浏览器、实际外部文件修改后的陈旧写入冲突、副本保留，以及容器内目录回收/恢复。证据位于 `artifacts/container/`，失败时保留控制台诊断，测试容器与临时数据在 finally 中清理。

M1 的实际运行环境、镜像摘要及限制见 [M1 记录](M1.md)。跨架构仿真、Compose 配置检查和 Docker daemon 上执行 `compose up` 是不同证据，不混称。

## 本次本地镜像归档

`artifacts/container/folio-m1.oci.tar` 包含 amd64 与 arm64 清单，旁边有 `.sha256` 校验文件。已用 Podman 检查和导入本机平台；Docker daemon 导入未在此环境验证。导入后可将显示的镜像 ID 标记为 `folio:local` 再用 Compose 运行：

```sh
podman load -i artifacts/container/folio-m1.oci.tar
podman tag <导入时显示的镜像ID> folio:local
```

镜像归档、截图和 JSON 验收记录属于本机构建产物，不进入 Git。源码和 Dockerfile 可重建它们。

## 备份与切换恢复副本

一致性备份、SHA-256 校验、新目录恢复和实际演练见 [双卷备份恢复](BACKUP.md)。必须先停止 Folio 与外部写入者，备份工具通过实例锁拒绝运行中的服务。不要只复制 app.db 主文件或把浏览器草稿当作服务器备份。

Compose 的宿主路径可由 `FOLIO_WORKSPACE_DIR` 与 `FOLIO_APP_DATA_DIR` 配置，默认仍为 `./workspace`、`./app-data`。恢复时两项必须一起切换，旧卷保持不动。恢复保留密码并清除旧登录会话；新位置启动后需重新登录、等待搜索重建并核对回收站/附件。备份工具运行在宿主机，需要 Python 3.11+，不向 scratch 镜像加入解释器。

`make CONTAINER_ENGINE=podman image` 现在显式使用 Docker 镜像格式，以保留 HEALTHCHECK 元数据。M3 原生 amd64 HTTPS 容器恢复演练不等同于 arm64 或 Docker daemon 的重新验收，具体证据见 M3 记录。
