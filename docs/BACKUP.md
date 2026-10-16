# 双卷备份与恢复

备份对象是一起使用的 **workspace 与 app-data**。前者是正文与附件的唯一权威；后者包含账号、会话、回收站与可能的证书/引导密码。浏览器 IndexedDB 草稿和待上传原件不在这两卷内，备份前先在浏览器保存、上传或下载保留。

提供宿主机工具 `scripts/backup.py`，依赖 **Python 3.11+、Linux amd64/arm64、openat2/renameat2、/proc**。不需要在 scratch 容器中安装 Python，也没有新增服务。使用能读取两卷的账号运行；根路径及祖先不能是符号链接，必要时先明确选用 `realpath` 指向的实际目录。

## 创建一致性备份

先停止 Folio 和所有外部编辑器/同步任务。工具会获取 app-data 的 `instance.lock`，运行中的 Folio 会被拒绝；锁不能约束 VS Code、Syncthing 或使用另一份 app-data 的错误部署。不要删除锁文件绕过检查。

```sh
# 在项目目录操作；下面变量不能位于任一数据卷内部。
workspace_dir="$(realpath "${FOLIO_WORKSPACE_DIR:-./workspace}")"
appdata_dir="$(realpath "${FOLIO_APP_DATA_DIR:-./app-data}")"
mkdir -p ../folio-backups
chmod 0700 ../folio-backups
backup_parent="$(realpath ../folio-backups)"
snapshot_dir="$backup_parent/folio-$(date -u +%Y%m%dT%H%M%SZ)"

docker compose stop -t 15
python3 scripts/backup.py backup \
  --workspace "$workspace_dir" --app-data "$appdata_dir" \
  --output "$snapshot_dir"
python3 scripts/backup.py verify --backup "$snapshot_dir"
docker compose start
```

如果使用代理覆盖文件，stop/start 使用与平时完全相同的 `-f` 参数。Rootless Podman 部署先停止相应容器，执行宿主机备份，再启动；主机进程部署则先正常结束该进程。本工具不会擅自停止或启动实例。若命令失败，先查看错误及现有目标，再决定重试或启动服务。

输出是普通私有目录，不是压缩归档：

```text
folio-<时间>/
  manifest.json
  workspace/             # 原始文件字节
  app-data/              # 账号库、回收站及其他持久文件
```

过程在新建私有暂存目录中完成：安全复制两卷、再次核对源内容、在**复制件**上合并 app.db 已提交 WAL、SQLite integrity_check、生成 SHA-256/权限/mtime 清单，最后不覆盖地原子发布。源数据库从不被 SQLite 连接打开或修改。恢复需要的 `.folio-tmp-*` 普通文件/目录也保留，不按普通文件列表的隐藏规则丢弃。

明确省略：`instance.lock`、搜索缓存 `search.db` 及其 WAL/SHM/journal、`search-recovery-*` 缓存隔离目录。实际省略项记入清单；搜索从真实文件重建。app.db 的 WAL/SHM/journal 先随复制件参与恢复，合并完成后不再作为独立文件交付。

每个输出目录必须不存在；不会覆盖旧快照。复制完成前不会出现可用目标，失败会清理本次暂存目录。若底层文件系统/权限阻止清理，可能留下私有 `.folio-backup-*`，须人工核查，不能当作完整备份。发布后父目录 fsync 失败会明确说明“已发布但同步失败”，不要覆盖重试。

## 校验与保管

```sh
python3 scripts/backup.py verify --backup "$snapshot_dir"
```

校验只读检查所有路径、类型、内容摘要、长度、权限和修改时间，拒绝多余/缺失文件、重复/越界清单、符号链接、硬链接、特殊文件及嵌套挂载。清单最大 64 MiB。不要编辑清单，也不要直接将备份目录挂载给 Folio。普通 SQLite 连接可能创建 sidecar 或修改数据库，人工检查应针对另一个副本；工具校验不需要打开备份库。

搬运时保留权限和时间，例如在受控私有位置使用 `cp -a`。SHA-256 清单用于发现意外损坏，**不是签名或真实性证明**；恶意修改者也可能改写清单。备份可能包含正文、私钥、账号哈希和引导密码，目录权限应保持 0700，离机副本使用已有的加密存储，并定期验证另一份副本。

另行保管镜像/版本、Compose/.env 覆写、反向代理配置以及不在两卷中的证书。不要向已经发布的快照内添加这些文件，可放在同一私有备份父目录的其他位置。工具不执行保留期轮转、不自动删除旧备份，也不上传到外部存储。

## 恢复到新位置

恢复不会覆盖、合并或清空现有工作区。先校验备份，再选择一个**不存在**的新目标父目录；其父目录必须已经存在且可写。

```sh
mkdir -p ../folio-recovery
restore_parent="$(realpath ../folio-recovery)"
restored_dir="$restore_parent/folio-restored-$(date -u +%Y%m%dT%H%M%SZ)"

python3 scripts/backup.py restore \
  --backup "$snapshot_dir" --output "$restored_dir"
```

恢复结果包含 `workspace/`、`app-data/` 与 `restore.json` 收据。恢复前和复制后均核对清单；只在两卷都完成后发布。账号密码/初始化盐保留，但**旧登录会话主动清除**，避免从旧快照复活已撤销的会话；恢复后重新登录。搜索缓存启动后重建。

确认文件属主与容器运行 UID/GID 匹配。工具保留普通权限和 mtime，不保留原 UID/GID、ACL、xattr、稀疏布局或特殊权限；新文件由执行工具的用户拥有。如由管理员代为恢复，应先调整为部署用户，再启动。工具不会自动修改原卷属主。

Compose 可以切换整套挂载：

```sh
docker compose stop -t 15
export FOLIO_WORKSPACE_DIR="$restored_dir/workspace"
export FOLIO_APP_DATA_DIR="$restored_dir/app-data"
export FOLIO_UID="$(id -u)" FOLIO_GID="$(id -g)"
docker compose up -d
```

继续使用原来正确的 origin、TLS/代理配置与匹配版本的镜像。恢复的容器只挂载新两卷，旧两卷和备份保持不动；回滚时停止容器，再把两个宿主目录变量**一起**改回旧值。不要混用不同时间点的 workspace/app-data，也不要同时运行两个写同一卷的实例。

新目录设备/inode 或 app-data 改变后，浏览器工作区身份可能不同。旧页面先下载未保存稿，再重新加载；浏览器恢复记录不会被偷偷绑定到另一份目录。未确认的拍照/附件原件只在旧页面内存中，不能靠服务器备份找回。

## 恢复后核对

登录原账号，逐项检查代表性 Markdown/JSON 原文、附件原始下载、回收站列表及恢复、搜索重建和一次后续保存。确认 TLS 与备份以外的部署配置正确；旧 Cookie 应失效。`restore.json` 是新部署收据，不是可再次输入 verify 的备份清单；恢复后的运行目录会正常变化。

不要在持续写入时依赖复制得到跨文件系统瞬时快照。二次摘要检查会捕捉常见外部修改，但无法提供对不协作写入者的全局事务保证。磁盘空间不足、不可读文件、超长路径/层级、链接、特殊文件或未知账号库结构都会明确失败，不截断、跳过正文或降级恢复。需要保留这些特殊文件元数据时，使用经过验证的系统级备份方案并继续遵守停写与双卷成对原则。

## 复现本项目演练

```sh
make backup-test
# 已构建镜像后，独立 HTTPS 容器演练：
python3 scripts/backup-test.py --engine podman --container-image localhost/folio:m3
```

脚本自行编译测试 Go 服务（主机模式）或使用指定镜像；只使用临时数据、固定测试账号和自签名测试证书。它验证运行锁、SIGKILL 后已提交 WAL、CRLF/frontmatter/HTML 注释原文、附件字节、损坏/越界/链接/管道拒绝、目标不覆盖、新位置登录、旧会话失效、回收站、搜索与条件保存。测试容器和数据在结束后清理。证据在 `artifacts/backup/`；不访问本地日常工作区或密码文件。
