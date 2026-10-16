#!/usr/bin/env python3
"""备份恢复演练只使用临时目录和测试账号，不访问日常预览数据。"""
from contextlib import closing
import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import uuid
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / 'scripts/backup.py'


def cli(*args, ok=True):
    result = subprocess.run(['python3', str(TOOL), *map(str, args)], capture_output=True, text=True, timeout=30)
    if (result.returncode == 0) != ok:
        raise AssertionError(f'备份命令状态异常：{result.stderr}')
    return json.loads(result.stdout) if ok else result.stderr


class Server:
    def __init__(self, binary, workspace, app_data, password=None):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
        self.url = f'http://127.0.0.1:{port}'
        clean_environment = {key: value for key, value in os.environ.items() if not key.startswith('FOLIO_')}
        env = dict(clean_environment, FOLIO_ADDR=f'127.0.0.1:{port}', FOLIO_WORKSPACE=str(workspace), FOLIO_APP_DATA=str(app_data), FOLIO_SECURE_COOKIE='false', FOLIO_ORIGIN=self.url, FOLIO_PASSWORD_FILE=str(password) if password else '')
        self.log = tempfile.TemporaryFile(mode='w+')
        self.process = subprocess.Popen([str(binary)], env=env, stdout=self.log, stderr=self.log)
        self.cookies = http.cookiejar.CookieJar()
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies))
        self.csrf = ''
        for _ in range(100):
            try:
                self.call('GET', '/healthz'); break
            except (OSError, urllib.error.URLError):
                if self.process.poll() is not None:
                    self.log.seek(0); raise AssertionError('测试服务启动失败：' + self.log.read())
                time.sleep(.05)
        else:
            raise AssertionError('测试服务就绪超时')

    def call(self, method, route, data=None, revision=None, expect=200, cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        headers = {'Origin': self.url}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if self.csrf:
            headers['X-CSRF-Token'] = self.csrf
        if revision:
            headers['If-Match'] = '"' + revision + '"'
        if cookie:
            headers['Cookie'] = cookie
        request = urllib.request.Request(self.url + '/api/v1' + route, data=body, method=method, headers=headers)
        try:
            response = self.client.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            if error.code != expect:
                raise AssertionError(f'接口 {method} {route} 状态 {error.code}，预期 {expect}') from error
            return None
        with response:
            assert response.status == expect
            if '/download?' in route:
                return response.read()
            return json.load(response)

    def login(self):
        result = self.call('POST', '/auth/login', {'username': 'admin', 'password': 'folio-backup-test-password-2026'})
        self.csrf = result['csrfToken']
        return result['workspaceId']

    def stop(self, kill=False):
        if self.process.poll() is None:
            self.process.kill() if kill else self.process.terminate()
            self.process.wait(timeout=10)
        self.log.close()


class ContainerServer(Server):
    engine = 'podman'
    image = ''

    def __init__(self, _binary, workspace, app_data, password=None):
        self.name = 'folio-backup-' + uuid.uuid4().hex[:12]
        if password:
            shutil.copyfile(password, app_data / 'test-password')
            (app_data / 'test-password').chmod(0o600)
        if not (app_data / 'tls/server.crt').exists():
            subprocess.run(['sh', str(ROOT / 'scripts/setup-local-tls.sh'), str(app_data.parent)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        rootless = self.engine.endswith('podman') and subprocess.run([self.engine, 'info', '--format', '{{.Host.Security.Rootless}}'], check=True, capture_output=True, text=True).stdout.strip() == 'true'
        args = [self.engine, 'run', '-d', '--pull=never', '--name', self.name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m', '-p', '127.0.0.1::8080', '-v', f'{workspace}:/workspace', '-v', f'{app_data}:/app-data', '--user', f'{os.getuid()}:{os.getgid()}', '-e', 'FOLIO_TLS_CERT=/app-data/tls/server.crt', '-e', 'FOLIO_TLS_KEY=/app-data/tls/server.key']
        if rootless: args += ['--userns=keep-id']
        if password: args += ['-e', 'FOLIO_PASSWORD_FILE=/app-data/test-password']
        try:
            subprocess.run([*args, self.image], check=True, capture_output=True, text=True, timeout=30)
            binding = subprocess.run([self.engine, 'port', self.name, '8080/tcp'], check=True, capture_output=True, text=True).stdout.strip().splitlines()[0]
            self.url = 'https://' + binding
            self.cookies = http.cookiejar.CookieJar()
            trust = ssl.create_default_context(cafile=str(app_data / 'tls/server.crt'))
            self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=trust), urllib.request.HTTPCookieProcessor(self.cookies))
            self.csrf = ''
            for _ in range(100):
                try: self.call('GET', '/healthz'); break
                except (OSError, urllib.error.URLError): time.sleep(.05)
            else: raise AssertionError('恢复测试容器未就绪')
            subprocess.run([self.engine, 'exec', self.name, '/folio', '-healthcheck'], check=True, capture_output=True, timeout=10)
        except BaseException:
            subprocess.run([self.engine, 'rm', '-f', self.name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            raise

    def stop(self, kill=False):
        if kill:
            subprocess.run([self.engine, 'kill', '--signal', 'KILL', self.name], check=True, capture_output=True, timeout=15)
        subprocess.run([self.engine, 'rm', '-f', self.name], check=True, capture_output=True, timeout=15)


def main():
    parser = argparse.ArgumentParser(description='用隔离目录演练 Folio 双卷恢复')
    parser.add_argument('--container-image'); parser.add_argument('--engine', default='podman')
    args = parser.parse_args()
    factory = Server
    if args.container_image:
        ContainerServer.engine, ContainerServer.image = args.engine, args.container_image
        factory = ContainerServer
    report = {'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'toolSha256': hashlib.sha256(TOOL.read_bytes()).hexdigest(), 'sqliteVersion': sqlite3.sqlite_version, 'checks': [], 'source': '临时工作区与测试账号，HTTPS 容器演练' if args.container_image else '临时工作区与测试账号，普通主机进程演练'}
    if args.container_image:
        image = json.loads(subprocess.run([args.engine, 'image', 'inspect', args.container_image], check=True, capture_output=True, text=True).stdout)[0]
        report['runtime'] = {'engine': args.engine, 'imageId': image['Id'], 'architecture': image['Architecture'], 'healthcheck': bool(image.get('Healthcheck') or image.get('Config', {}).get('Healthcheck'))}
        assert report['runtime']['healthcheck'], '容器镜像必须保留 HEALTHCHECK 元数据'
    with tempfile.TemporaryDirectory(prefix='folio-backup-test-') as directory:
        base = Path(directory); workspace = base / 'workspace'; data = base / 'app-data'
        workspace.mkdir(); data.mkdir(mode=0o700)
        password = base / 'password'; password.write_text('folio-backup-test-password-2026'); password.chmod(0o600)
        binary = base / 'folio'
        if not args.container_image: subprocess.run(['go', 'build', '-o', str(binary), './cmd/server'], cwd=ROOT / 'backend', check=True, timeout=120)
        server = factory(binary, workspace, data, password)
        try:
            original_id = server.login()
            cookie = '; '.join(f'{value.name}={value.value}' for value in server.cookies)
            server.call('POST', '/directories', {'path': '中文目录'}, expect=201)
            note = '中文目录/笔记.md'; content = '---\r\ntitle: 原始元数据\r\n---\r\n\r\n# 备份验收\r\n\r\n真实文件正文与 request_id。<!-- 保留注释 -->\r\n'
            server.call('POST', '/files', {'path': note, 'content': content}, expect=201)
            server.call('POST', '/files', {'path': '配置.json', 'content': '{"portable":true}'}, expect=201)
            server.call('POST', '/files', {'path': '待恢复.md', 'content': '回收站完整原文'}, expect=201)
            revision = server.call('GET', '/entries/revision?path=' + urllib.parse.quote('待恢复.md'))['revision']
            trashed = server.call('DELETE', '/entries?path=' + urllib.parse.quote('待恢复.md'), revision=revision)
            # 附件作为原始文件放入隔离挂载，随后通过认证下载比对字节。
            attachment = (ROOT / 'frontend/tests/fixtures/preview.png').read_bytes()
            (workspace / '1/中文目录/图片.png').write_bytes(attachment)
            snapshot = base / 'snapshot'
            assert '仍在运行' in cli('backup', '--workspace', workspace, '--app-data', data, '--output', snapshot, ok=False)
            assert not snapshot.exists()
            report['checks'].append('运行中的实例锁拒绝备份')
        finally:
            server.stop(kill=True)
        assert (data / 'app.db-wal').stat().st_size > 0
        # 重建缓存不应成为正文恢复前提，即使旧缓存已损坏。
        (data / '1/search.db').write_bytes(b'broken cache')
        original_database_bytes = {name: hashlib.sha256((data / name).read_bytes()).hexdigest() for name in ('app.db', 'app.db-wal')}
        cli('backup', '--workspace', workspace, '--app-data', data, '--output', snapshot)
        assert {name: hashlib.sha256((data / name).read_bytes()).hexdigest() for name in original_database_bytes} == original_database_bytes
        cli('verify', '--backup', snapshot)
        assert not (snapshot / 'app-data/app.db-wal').exists()
        assert not (snapshot / 'app-data/1/search.db').exists()
        assert (snapshot / 'workspace/1' / note).read_bytes() == content.encode()
        with closing(sqlite3.connect(f'file:{snapshot}/app-data/app.db?immutable=1', uri=True)) as database:
            assert database.execute('PRAGMA integrity_check').fetchone() == ('ok',)
            assert database.execute('SELECT count(*) FROM sessions').fetchone()[0] > 0
        report['checks'].append('SIGKILL 后已提交 WAL 合并、源库原始字节不变、完整性与双卷摘要校验')
        existing = base / 'existing'; existing.mkdir(); (existing / '保留.txt').write_text('不能覆盖')
        cli('restore', '--backup', snapshot, '--output', existing, ok=False)
        assert (existing / '保留.txt').read_text() == '不能覆盖'
        cli('backup', '--workspace', workspace, '--app-data', data, '--output', snapshot, ok=False)
        report['checks'].append('已存在的备份/恢复目标拒绝覆盖')
        damaged = base / 'damaged'; shutil.copytree(snapshot, damaged)
        (damaged / 'workspace/1' / note).write_text('损坏')
        cli('verify', '--backup', damaged, ok=False)
        cli('restore', '--backup', damaged, '--output', base / 'rejected', ok=False)
        assert not (base / 'rejected').exists()
        report['checks'].append('损坏内容拒绝校验与恢复，不发布部分结果')
        malicious = base / 'malicious'; shutil.copytree(snapshot, malicious)
        manifest = json.loads((malicious / 'manifest.json').read_text())
        manifest['entries'][0]['path'] = '../outside'
        (malicious / 'manifest.json').write_text(json.dumps(manifest))
        cli('restore', '--backup', malicious, '--output', base / 'escaped', ok=False)
        assert not (base / 'outside').exists() and not (base / 'escaped').exists()
        outside = base / 'private'; outside.write_text('不得跟随')
        (workspace / '链接').symlink_to(outside)
        cli('backup', '--workspace', workspace, '--app-data', data, '--output', base / 'linked', ok=False)
        (workspace / '链接').unlink()
        os.link(outside, workspace / '硬链接')
        cli('backup', '--workspace', workspace, '--app-data', data, '--output', base / 'hardlinked', ok=False)
        (workspace / '硬链接').unlink()
        assert not (base / 'linked').exists() and not (base / 'hardlinked').exists()
        special = base / 'special'; shutil.copytree(snapshot, special)
        (special / 'manifest.json').unlink(); os.mkfifo(special / 'manifest.json')
        cli('verify', '--backup', special, ok=False)
        cli('backup', '--workspace', workspace, '--app-data', data, '--output', workspace / '内部备份', ok=False)
        assert not (workspace / '内部备份').exists()
        report['checks'].append('越界清单、符号链接、硬链接、管道清单和源内输出拒绝，无外部文件覆盖')
        restored = base / 'restored'
        cli('restore', '--backup', snapshot, '--output', restored)
        assert (restored / 'workspace/1' / note).read_bytes() == content.encode()
        assert (restored / 'workspace/1/中文目录/图片.png').read_bytes() == attachment
        with closing(sqlite3.connect(f'file:{restored}/app-data/app.db?immutable=1', uri=True)) as database:
            assert database.execute('SELECT count(*) FROM sessions').fetchone() == (0,)
        server = factory(binary, restored / 'workspace', restored / 'app-data')
        try:
            server.call('GET', '/auth/me', expect=401, cookie=cookie)
            assert server.login() != original_id
            result = server.call('GET', '/files/content?path=' + urllib.parse.quote(note))
            assert result['content'] == content
            assert server.call('GET', '/files/download?path=' + urllib.parse.quote('中文目录/图片.png')) == attachment
            records = server.call('GET', '/trash')['entries']
            assert any(record['id'] == trashed['id'] for record in records)
            server.call('POST', f'/trash/{trashed["id"]}/restore')
            assert (restored / 'workspace/1/待恢复.md').read_text() == '回收站完整原文'
            for _ in range(100):
                if server.call('GET', '/search?q=' + urllib.parse.quote('备份'))['entries']:
                    break
                time.sleep(.05)
            else:
                raise AssertionError('恢复后搜索索引未重建')
            server.call('PUT', '/files/content?path=' + urllib.parse.quote(note), {'content': content + '\n恢复后继续编辑\n'}, revision=result['revision'])
            assert '恢复后继续编辑' in (restored / 'workspace/1' / note).read_text()
        finally:
            server.stop()
        report['checks'].append('新位置启动、原密码登录、旧会话失效、正文/附件/回收站恢复、搜索重建与后续条件保存')
        report['noteSha256'] = hashlib.sha256(content.encode()).hexdigest()
        report['attachmentSha256'] = hashlib.sha256(attachment).hexdigest()
        report['passed'] = True
    evidence = ROOT / 'artifacts/backup'; evidence.mkdir(parents=True, exist_ok=True)
    (evidence / ('container-run.json' if args.container_image else 'last-run.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('备份恢复演练通过：' + '；'.join(report['checks']))


if __name__ == '__main__':
    main()
