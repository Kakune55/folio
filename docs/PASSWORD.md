# 离线重置管理员密码

当前文件层已简化：权限由运行用户和部署者配置（Unix 建议 0700/0600，Windows 使用 ACL），应用不再逐项强制校验 UID/mode 或硬链接数。仍拒绝静态符号链接/特殊文件，保留有界密码读取、在线实例锁、离线事务改密与撤销会话。下文权限命令是 Linux 部署建议，旧拒绝测试记录为历史证据；当前范围见 [PORTABILITY.md](PORTABILITY.md)。


账号初始化后，更换 `FOLIO_PASSWORD_FILE` 或 `initial-password` **不会**更改数据库中的密码。忘记密码或需要撤销全部登录时，使用同一个 Folio 二进制的离线命令；不删除 app-data，不提供匿名 HTTP 重置入口。

该操作需要部署用户对现有 app-data 的访问权，相当于本机管理员权限。先停止 Folio、外部同步及其他可能改写 app-data 的程序，按 [双卷备份说明](BACKUP.md) 保留一份可校验备份。实例锁拒绝在线重置；不要删除锁文件绕过它。

## 准备新密码文件

使用私有普通文件，属主必须与运行命令的用户相同，权限 0600；不接受符号链接、硬链接、FIFO 或组/其他用户可读文件。密码为 12–1024 字节 UTF-8，不含 NUL 或内部换行，允许文件末尾一组 LF/CRLF。不对密码做空白裁剪，首尾空格是密码的一部分。

下面用宿主 Python 的隐藏输入生成文件，密码不会出现在命令行参数、历史或终端回显中：

```sh
umask 077
reset_secret_dir="$(mktemp -d)"
python3 - "$reset_secret_dir/new-password" <<'PY'
import getpass, os, sys
password = getpass.getpass('新密码：')
confirmation = getpass.getpass('再次输入：')
if password != confirmation:
    raise SystemExit('两次输入不一致，未写入文件')
data = password.encode('utf-8')
if not 12 <= len(data) <= 1024 or any(c in password for c in '\0\r\n'):
    raise SystemExit('密码须为 12–1024 字节，不能含 NUL 或换行')
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'wb') as file:
    file.write(data + b'\n')
    file.flush()
    os.fsync(file.fileno())
PY
```

文件生成失败时不要继续重置。也可以从密码管理器安全生成同样满足要求的私有文件；不要将密码直接写进命令参数或 Compose 环境变量。工具不会自动删除用户指定的密码文件。

## 主机进程

使用与部署匹配的新版本二进制；此命令不读取服务器环境配置、不监听网络、不创建工作区，且必须显式给出已有 app-data 和密码文件：

```sh
./bin/folio -reset-password \
  -app-data "$(realpath "${FOLIO_APP_DATA_DIR:-./app-data}")" \
  -password-file "$reset_secret_dir/new-password"
```

app-data 目录必须属于运行用户、权限 0700；账号库、锁及已有 SQLite sidecar 必须是该用户私有的普通文件。目录及密码文件的路径祖先不能含符号链接，必要时先选择 `realpath` 指向的实际目录。工具不会创建不存在的账号库或使用初始化密码来掩盖错误路径。

## Compose / Rootless Podman

正常停止原容器后，使用相同版本镜像、相同用户及同一套挂载。Compose 示例（使用代理覆盖时仍需加上原来的 `-f` 参数）：

```sh
docker compose stop -t 15
# 此时完成双卷备份及新密码文件准备，然后运行：
docker compose run --rm --no-deps -T \
  -v "$reset_secret_dir/new-password:/reset-password:ro" \
  folio -reset-password -app-data /app-data -password-file /reset-password
# 仅在确认重置成功后：
docker compose start
```

Compose 的 `FOLIO_UID/FOLIO_GID` 和 `FOLIO_APP_DATA_DIR` 应与原部署一致。不要在原容器内重置，运行中的实例会持有锁。离线命令不需要端口、TLS 或引导密码配置。

Rootless Podman 可以只挂载 app-data 和临时密码文件，不挂载正文卷：

```sh
podman stop -t 15 folio
podman run --rm --userns=keep-id --user "$(id -u):$(id -g)" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  -v "$(realpath "${FOLIO_APP_DATA_DIR:-./app-data}"):/app-data" \
  -v "$reset_secret_dir/new-password:/reset-password:ro" \
  folio:local -reset-password -app-data /app-data -password-file /reset-password
# 仅在确认成功后：
podman start folio
```

## 结果与失败处理

在 SQLite FULL 同步事务中更新现有账号 Argon2id 哈希并清空全部会话。成功后旧密码及所有旧 Cookie 失效，用新密码重新登录。保留账号初始化盐及根目录，因此同一两卷的浏览器草稿命名空间不变；不会修改正文、回收站、搜索缓存或 TLS 配置。

密码更新和会话撤销在同一个事务中；任一步失败不会有意提交部分更新。账号库损坏、未知触发器/账号结构、文件类型或权限异常明确失败，不自动重建账号库。提交或关闭失败可能无法凭退出码判定是否完成，保留数据并先核验新密码，不删除文件或盲目初始化。实例锁只能约束遵守本项目协议的进程，不能抵御恶意同 UID 程序或私有目录的持续外部改写。

核验新密码登录成功后，删除或安全保管本次临时密码文件，并移除空的临时目录。旧 `initial-password` 或初始化用的 `FOLIO_PASSWORD_FILE` 不会更新，可以按既有秘密管理方式移除；若启动配置仍引用初始化文件，先撤下该引用再删除文件。重置前备份仍含旧凭据及会话；从该备份恢复会恢复旧密码（恢复工具会清除会话），须按需要再次重置并保管新备份。

已有页面可能还有未保存正文：会话撤销后先保留/下载该页面草稿，再用新密码登录。重置不会清除浏览器 IndexedDB，也不能恢复被清空的浏览器数据。
