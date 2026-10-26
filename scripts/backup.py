#!/usr/bin/env python3
"""Linux 离线双卷备份：普通目录、SHA-256 清单与不覆盖恢复，不解压任意归档。"""
from contextlib import closing
import argparse
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import stat
import sys
import uuid


class BackupError(Exception):
    pass


LIBC = ctypes.CDLL(None, use_errno=True)
CHUNK = 1024 * 1024
CACHE_NAMES = {'search.db', 'search.db-wal', 'search.db-shm', 'search.db-journal'}


class OpenHow(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]


def safe_open(root, name, flags):
    how = OpenHow(flags | os.O_CLOEXEC | os.O_NOFOLLOW, 0, 0x01 | 0x02 | 0x04 | 0x08)
    result = LIBC.syscall(ctypes.c_long(437), ctypes.c_int(root), ctypes.c_char_p(os.fsencode(name)), ctypes.byref(how), ctypes.sizeof(how))
    if result < 0:
        raise OSError(ctypes.get_errno(), f'无法安全打开条目：{name}')
    return result


def open_directory(path):
    """从 / 逐级打开，根路径本身及祖先也不跟随符号链接。"""
    absolute = os.path.abspath(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in Path(absolute).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(info):
    return info.st_dev, info.st_ino


def stamp(info):
    return identity(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_nlink


def valid_path(name):
    if not isinstance(name, str) or not name or len(name.encode('utf-8')) > 4096:
        return False
    return not name.startswith('/') and not any(part in ('', '.', '..') for part in name.split('/')) and not any(ord(char) < 32 or ord(char) == 127 or char == '\\' for char in name)


def file_info(info, name):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o7000:
        raise BackupError(f'拒绝特殊文件、硬链接或特殊权限：{name}')


def ignored(relative):
    parts = relative.split('/')
    return parts[0] == 'app-data' and len(parts) >= 2 and (parts[-1] in CACHE_NAMES or parts[-1].startswith('search-recovery-') or parts[1] == 'instance.lock')


def inventory(root, prefix, destination=None, exclusions=None):
    entries = []

    def walk(relative):
        full = prefix + ('/' + relative if relative else '')
        directory = safe_open(root, relative or '.', os.O_RDONLY | os.O_DIRECTORY)
        try:
            before = os.fstat(directory)
            if before.st_mode & 0o7000:
                raise BackupError(f'拒绝特殊目录权限：{full}')
            entries.append({'path': full, 'kind': 'directory', 'mode': stat.S_IMODE(before.st_mode), 'mtimeNs': before.st_mtime_ns})
            if destination:
                (destination / full).mkdir(mode=0o700)
            for name in sorted(os.listdir(directory)):
                child = relative + '/' + name if relative else name
                if not valid_path(child):
                    raise BackupError('条目路径不受支持')
                target = prefix + '/' + child
                if exclusions is not None and ignored(target):
                    exclusions.append(target)
                    continue
                reference = safe_open(root, child, os.O_PATH)
                try:
                    info = os.fstat(reference)
                    if stat.S_ISDIR(info.st_mode):
                        walk(child)
                        continue
                    file_info(info, target)
                    # 确认普通文件后才真正打开，避免设备/FIFO 副作用。
                    fd = os.open(f'/proc/self/fd/{reference}', os.O_RDONLY | os.O_CLOEXEC)
                    try:
                        digest = hashlib.sha256()
                        output = None
                        try:
                            if destination:
                                output = open(destination / target, 'xb')
                            while data := os.read(fd, CHUNK):
                                digest.update(data)
                                if output:
                                    output.write(data)
                            if output:
                                output.flush(); os.fsync(output.fileno())
                            if stamp(info) != stamp(os.fstat(fd)):
                                raise BackupError(f'读取期间文件变化：{target}')
                        finally:
                            if output:
                                output.close()
                        entries.append({'path': target, 'kind': 'file', 'mode': stat.S_IMODE(info.st_mode), 'mtimeNs': info.st_mtime_ns, 'size': info.st_size, 'sha256': digest.hexdigest()})
                    finally:
                        os.close(fd)
                finally:
                    os.close(reference)
            after = os.fstat(directory)
            if stamp(before) != stamp(after):
                raise BackupError(f'读取期间目录变化：{full}')
        finally:
            os.close(directory)

    walk('')
    return sorted(entries, key=lambda entry: entry['path'])


def apply_metadata(destination, entries):
    for entry in sorted(entries, key=lambda entry: entry['path'].count('/'), reverse=True):
        target = destination / entry['path']
        os.chmod(target, entry['mode'], follow_symlinks=False)
        os.utime(target, ns=(entry['mtimeNs'], entry['mtimeNs']), follow_symlinks=False)
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if entry['kind'] == 'directory' else 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)



def consolidate_shares(directory, clear_grants=False):
    """分享库与账号库一样，只在私有复制件上合并 WAL、校验并清理授权。"""
    folder = directory / 'shares'
    database = folder / 'shares.db'
    if not database.exists():
        return
    (folder / 'shares.db-shm').unlink(missing_ok=True)
    temporary = folder / ('.backup-db-' + uuid.uuid4().hex)
    with open(temporary, 'xb'):
        pass
    os.chmod(temporary, 0o600)
    try:
        with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(temporary)) as target:
            source.execute('PRAGMA trusted_schema=OFF')
            if source.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise BackupError('分享数据库完整性检查失败')
            if source.execute("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").fetchone():
                raise BackupError('分享数据库含未知触发器')
            source.execute('SELECT id,owner,record,payload,salt,hash FROM shares LIMIT 0')
            source.execute('SELECT token,share_id,version,expires FROM grants LIMIT 0')
            source.backup(target)
            if clear_grants:
                target.execute('DELETE FROM grants')
                target.commit()
            if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise BackupError('分享数据库备份完整性检查失败')
        with open(temporary, 'rb') as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, database)
        os.chmod(database, 0o600)
        for suffix in ('-wal', '-shm', '-journal'):
            (folder / ('shares.db' + suffix)).unlink(missing_ok=True)
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)

def consolidate_database(directory, clear_sessions=False):
    database = directory / 'app.db'
    if not database.is_file():
        raise BackupError('备份必须包含已有账号数据库 app.db')
    # 仅操作已安全复制到私有目录的数据库；源卷不被 SQLite 打开或修复。
    (directory / 'app.db-shm').unlink(missing_ok=True)
    temporary = directory / ('.backup-db-' + uuid.uuid4().hex)
    with open(temporary, 'xb'):
        pass
    os.chmod(temporary, 0o600)
    try:
        source = sqlite3.connect(database)
        target = sqlite3.connect(temporary)
        try:
            source.execute('PRAGMA trusted_schema=OFF')
            if source.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise BackupError('账号数据库完整性检查失败')
            if source.execute("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").fetchone():
                raise BackupError('账号数据库含未知触发器，拒绝自动处理')
            source.execute('SELECT token_hash,csrf,expires FROM sessions LIMIT 0')
            source.backup(target)
            if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise BackupError('账号数据库备份完整性检查失败')
            rows = target.execute('SELECT id,length(salt),length(hash) FROM account').fetchall()
            if not rows or not any(row[0] == 1 for row in rows) or any(row[1:] != (16, 32) for row in rows):
                raise BackupError('账号数据库结构或账号数据不受支持')
            if clear_sessions:
                account = target.execute('SELECT id,salt,hash FROM account').fetchall()
                target.execute('DELETE FROM sessions')
                if target.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='access_tokens'").fetchone():
                    target.execute('DELETE FROM access_tokens')
                target.commit()
                if target.execute('SELECT id,salt,hash FROM account').fetchall() != account:
                    raise BackupError('清理旧会话后账号数据不一致')
        finally:
            target.close(); source.close()
        with open(temporary, 'rb') as stream:
            os.fsync(stream.fileno())
        mode = stat.S_IMODE(database.stat().st_mode)
        os.replace(temporary, database)
        os.chmod(database, mode)
        for suffix in ('-wal', '-shm', '-journal'):
            (directory / ('app.db' + suffix)).unlink(missing_ok=True)
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
            with open(database, 'rb') as stream: os.fsync(stream.fileno())
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def publish(parent, temporary, name):
    rename = LIBC.renameat2
    result = rename(ctypes.c_int(parent), ctypes.c_char_p(os.fsencode(temporary)), ctypes.c_int(parent), ctypes.c_char_p(os.fsencode(name)), ctypes.c_uint(1))
    if result < 0:
        raise OSError(ctypes.get_errno(), '目标已存在或无法原子发布，未覆盖现有目录')
    try:
        os.fsync(parent)
    except OSError as error:
        raise BackupError('目录已发布，但父目录同步失败；请保留现有目标并核查，不要覆盖重试') from error


def contains_directory(root, candidate):
    target = identity(os.fstat(candidate))
    pending = ['.']
    while pending:
        relative = pending.pop()
        fd = safe_open(root, relative, os.O_RDONLY | os.O_DIRECTORY)
        try:
            if identity(os.fstat(fd)) == target:
                return True
            for name in os.listdir(fd):
                child = name if relative == '.' else relative + '/' + name
                reference = safe_open(root, child, os.O_PATH)
                try:
                    if stat.S_ISDIR(os.fstat(reference).st_mode): pending.append(child)
                finally:
                    os.close(reference)
        finally:
            os.close(fd)
    return False


def private_stage(output, forbidden, roots):
    output = Path(os.path.abspath(output))
    if output == Path('/'):
        raise BackupError('输出不能是根目录')
    parent = open_directory(output.parent)
    try:
        if any(contains_directory(source, parent) for source in roots):
            raise BackupError('输出父目录位于源目录内部，拒绝通过别名绕过隔离')
        for source in forbidden:
            if output == source or source in output.parents or output in source.parents:
                raise BackupError('输出目录必须与源目录相互独立')
        try:
            os.stat(output.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise BackupError('输出目录已存在，拒绝覆盖')
        temporary = '.folio-backup-' + uuid.uuid4().hex
        os.mkdir(temporary, mode=0o700, dir_fd=parent)
        descriptor = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        return parent, temporary, descriptor, Path(f'/proc/self/fd/{descriptor}')
    except BaseException:
        os.close(parent)
        raise


def clean_stage(parent, name, descriptor):
    try:
        if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(os.fstat(descriptor)):
            raise BackupError('暂存目录身份已变化，保留现场，不自动清理')
        shutil.rmtree(name, dir_fd=parent)
    except FileNotFoundError:
        pass


def write_json(path, value):
    with open(path, 'x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.chmod(path, 0o600)


def scan_pair(root):
    entries = []
    for prefix in ('workspace', 'app-data'):
        fd = safe_open(root, prefix, os.O_RDONLY | os.O_DIRECTORY)
        try:
            entries.extend(inventory(fd, prefix))
        finally:
            os.close(fd)
    return sorted(entries, key=lambda entry: entry['path'])


def backup(workspace, app_data, output):
    roots = [Path(os.path.abspath(workspace)), Path(os.path.abspath(app_data))]
    if roots[0] == roots[1] or roots[0] in roots[1].parents or roots[1] in roots[0].parents:
        raise BackupError('工作区与应用数据必须相互独立')
    descriptors = [open_directory(roots[0])]
    lock = None
    try:
        descriptors.append(open_directory(roots[1]))
        if identity(os.fstat(descriptors[0])) == identity(os.fstat(descriptors[1])):
            raise BackupError('两卷实际目录相同，拒绝别名重叠')
        reference = safe_open(descriptors[1], 'app.db', os.O_PATH)
        try: file_info(os.fstat(reference), 'app.db')
        finally: os.close(reference)
        try:
            reference = safe_open(descriptors[1], 'instance.lock', os.O_PATH)
        except FileNotFoundError:
            lock = os.open('instance.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=descriptors[1])
        else:
            try:
                file_info(os.fstat(reference), 'instance.lock')
                lock = os.open(f'/proc/self/fd/{reference}', os.O_RDWR | os.O_CLOEXEC)
            finally:
                os.close(reference)
        file_info(os.fstat(lock), 'instance.lock')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError('Folio 仍在运行：请先停止实例及外部编辑/同步，再备份') from None
        if contains_directory(descriptors[0], descriptors[1]) or contains_directory(descriptors[1], descriptors[0]):
            raise BackupError('两卷实际目录相互包含，拒绝别名重叠')
        parent, name, stage_fd, stage = private_stage(output, roots, descriptors)
        try:
            excluded = []
            before = []
            for prefix, source in zip(('workspace', 'app-data'), descriptors):
                before.extend(inventory(source, prefix, stage, excluded))
            after, after_excluded = [], []
            for prefix, source in zip(('workspace', 'app-data'), descriptors):
                after.extend(inventory(source, prefix, exclusions=after_excluded))
            if before != after or excluded != after_excluded:
                raise BackupError('源目录在备份期间变化，未发布备份')
            apply_metadata(stage, before)
            consolidate_database(stage / 'app-data')
            consolidate_shares(stage / 'app-data')
            manifest = {'format': 'folio-backup', 'version': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sqlite': '账号库和存在的分享库已合并已提交 WAL 并通过 integrity_check', 'excluded': sorted(excluded), 'entries': scan_pair(stage_fd)}
            write_json(stage / 'manifest.json', manifest)
            os.fsync(stage_fd)
            publish(parent, name, Path(output).name)
            return {'path': os.path.abspath(output), 'files': sum(entry['kind'] == 'file' for entry in manifest['entries']), 'verified': True}
        finally:
            clean_stage(parent, name, stage_fd); os.close(stage_fd); os.close(parent)
    finally:
        if lock is not None:
            os.close(lock)
        for descriptor in descriptors:
            os.close(descriptor)


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BackupError('清单含重复 JSON 字段')
        result[key] = value
    return result


def verify(root):
    if set(os.listdir(root)) != {'workspace', 'app-data', 'manifest.json'}:
        raise BackupError('备份顶层结构不匹配')
    reference = safe_open(root, 'manifest.json', os.O_PATH)
    try:
        file_info(os.fstat(reference), 'manifest.json')
        fd = os.open(f'/proc/self/fd/{reference}', os.O_RDONLY | os.O_CLOEXEC)
    finally:
        os.close(reference)
    try:
        file_info(os.fstat(fd), 'manifest.json')
        if os.fstat(fd).st_size > 64 * 1024 * 1024:
            raise BackupError('清单超过 64 MiB 上限')
        with os.fdopen(os.dup(fd), encoding='utf-8') as stream:
            manifest = json.load(stream, object_pairs_hook=unique_json)
    finally:
        os.close(fd)
    if not isinstance(manifest, dict) or manifest.get('format') != 'folio-backup' or manifest.get('version') != 1 or not isinstance(manifest.get('entries'), list):
        raise BackupError('备份格式/版本不受支持')
    paths = set()
    for entry in manifest['entries']:
        if not isinstance(entry, dict) or not valid_path(entry.get('path')):
            raise BackupError('清单路径无效')
        name = entry['path']
        if name.split('/')[0] not in ('workspace', 'app-data') or name in paths:
            raise BackupError('清单路径越界或重复')
        paths.add(name)
        if entry.get('kind') not in ('file', 'directory') or type(entry.get('mode')) is not int or not 0 <= entry['mode'] <= 0o777 or type(entry.get('mtimeNs')) is not int:
            raise BackupError('清单权限/类型无效')
        if entry['kind'] == 'file' and (type(entry.get('size')) is not int or entry['size'] < 0 or not isinstance(entry.get('sha256'), str) or len(entry['sha256']) != 64 or any(char not in '0123456789abcdef' for char in entry['sha256'])):
            raise BackupError('清单文件长度/摘要无效')
    actual = []
    for prefix in ('workspace', 'app-data'):
        directory = safe_open(root, prefix, os.O_RDONLY | os.O_DIRECTORY)
        try:
            actual.extend(inventory(directory, prefix))
        finally:
            os.close(directory)
    if sorted(actual, key=lambda entry: entry['path']) != manifest['entries']:
        raise BackupError('备份内容、目录、权限、时间或 SHA-256 与清单不匹配')
    return manifest


def restore(source, output):
    root = open_directory(source)
    try:
        manifest = verify(root)
        parent, name, stage_fd, stage = private_stage(output, [Path(os.path.abspath(source))], [root])
        try:
            entries = []
            for prefix in ('workspace', 'app-data'):
                directory = safe_open(root, prefix, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    entries.extend(inventory(directory, prefix, stage))
                finally:
                    os.close(directory)
            # 复制期间也验证，不能仅相信恢复开始前的校验结果。
            if sorted(entries, key=lambda entry: entry['path']) != manifest['entries']:
                raise BackupError('备份在恢复期间发生变化')
            apply_metadata(stage, entries)
            consolidate_database(stage / 'app-data', clear_sessions=True)
            consolidate_shares(stage / 'app-data', clear_grants=True)
            write_json(stage / 'restore.json', {'version': 1, 'restoredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sessionsCleared': True, 'search': '启动后从真实文件重建'})
            os.fsync(stage_fd); publish(parent, name, Path(output).name)
            return {'path': os.path.abspath(output), 'sessionsCleared': True, 'verified': True}
        finally:
            clean_stage(parent, name, stage_fd); os.close(stage_fd); os.close(parent)
    finally:
        os.close(root)


def main():
    parser = argparse.ArgumentParser(description='Folio 离线双卷备份/校验/恢复（仅 Linux amd64/arm64）')
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('backup', help='停止服务后创建新备份目录')
    create.add_argument('--workspace', required=True); create.add_argument('--app-data', required=True); create.add_argument('--output', required=True)
    check = commands.add_parser('verify', help='只读检查清单与所有文件')
    check.add_argument('--backup', required=True)
    recover = commands.add_parser('restore', help='恢复到不存在的新目录，不覆盖原数据')
    recover.add_argument('--backup', required=True); recover.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        if sys.version_info < (3, 11) or sys.platform != 'linux' or platform.machine() not in ('x86_64', 'aarch64') or not hasattr(LIBC, 'renameat2') or not shutil.rmtree.avoids_symlink_attacks:
            raise BackupError('需要 Python 3.11+、支持 openat2/renameat2 的 Linux、/proc 与安全目录清理支持')
        if args.command == 'backup':
            result = backup(args.workspace, args.app_data, args.output)
        elif args.command == 'restore':
            result = restore(args.backup, args.output)
        else:
            fd = open_directory(args.backup)
            try:
                manifest = verify(fd)
                result = {'verified': True, 'entries': len(manifest['entries'])}
            finally:
                os.close(fd)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (BackupError, OSError, sqlite3.Error, ValueError, UnicodeError, TypeError, OverflowError, RecursionError) as error:
        print(f'操作失败：{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
