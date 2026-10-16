"""隔离 HTTPS 容器：生产浏览器安全探针与 512 KiB 临时工作区 ENOSPC 恢复。"""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
engine = os.environ.get('CONTAINER_ENGINE', 'docker')
image = os.environ.get('FOLIO_TEST_IMAGE', 'folio:local')
emulator = os.environ.get('FOLIO_TEST_QEMU')
name = 'folio-review-' + uuid.uuid4().hex[:12]
evidence = ROOT / 'artifacts/security'
evidence.mkdir(parents=True, exist_ok=True)


def run(*args, **kwargs):
    return subprocess.run([engine, *args], check=True, text=True, timeout=60, **kwargs)


info = json.loads(run('image', 'inspect', image, capture_output=True).stdout)[0]
rootless = Path(engine).name == 'podman' and run('info', '--format', '{{.Host.Security.Rootless}}', capture_output=True).stdout.strip() == 'true'
health = info.get('Healthcheck') or info.get('Config', {}).get('Healthcheck')
if not health:
    raise SystemExit('镜像缺少 HEALTHCHECK；请使用保留该元数据的镜像格式重新构建')

with tempfile.TemporaryDirectory(prefix='folio-container-review-') as temporary:
    data = Path(temporary)
    subprocess.run(['sh', str(ROOT / 'scripts/setup-local-tls.sh'), temporary], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cert = data / 'app-data/tls/server.crt'
    public = subprocess.run(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'], check=True, capture_output=True).stdout
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public, check=True, capture_output=True).stdout
    spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
    nonce = uuid.uuid4().hex
    args = ['run', '-d', '--pull=never', '--platform', 'linux/' + info['Architecture'], '--name', name, '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m', '--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=512k,mode=1777', '-p', '127.0.0.1::8080', '-v', f'{data / "app-data"}:/app-data', '-e', 'FOLIO_TLS_CERT=/app-data/tls/server.crt', '-e', 'FOLIO_TLS_KEY=/app-data/tls/server.key', '--user', f'{os.getuid()}:{os.getgid()}']
    if rootless:
        args += ['--userns=keep-id']
    if emulator:
        args += ['--no-healthcheck', '--entrypoint', '/qemu', '-v', f'{Path(emulator).resolve()}:/qemu:ro', image, '/folio']
    else:
        args += [image]
    created = False
    try:
        run(*args, stdout=subprocess.DEVNULL)
        created = True
        binding = run('port', name, '8080/tcp', capture_output=True).stdout.strip().splitlines()[0]
        url = 'https://' + binding
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(cert))))
        for _ in range(100):
            try:
                with client.open(url + '/api/v1/healthz', timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('隔离审查容器未就绪')
        run('exec', name, *(['/qemu'] if emulator else []), '/folio', '-healthcheck', stdout=subprocess.DEVNULL)
        (data / 'review-marker.json').write_text(json.dumps({'nonce': nonce, 'url': url}))
        env = {key: value for key, value in os.environ.items() if not key.startswith('FOLIO_')}
        env.update(FOLIO_REVIEW_URL=url, FOLIO_REVIEW_DATA=str(data), FOLIO_REVIEW_NONCE=nonce, FOLIO_REVIEW_SPKI=spki, FOLIO_REVIEW_PASSWORD=(data / 'app-data/initial-password').read_text().strip())
        subprocess.run(['node', str(ROOT / 'frontend/scripts/container-review.mjs')], cwd=ROOT / 'frontend', env=env, check=True, timeout=150)
        logs = run('logs', name, capture_output=True)
        disk_full = 'no space left on device' in logs.stdout + logs.stderr
        if not disk_full:
            raise RuntimeError('未观察到内核 ENOSPC 日志，不能以模拟错误替代磁盘满证据')
        checks = json.loads((data / 'browser-review.json').read_text())
        report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': image, 'imageId': info.get('Id'), 'architecture': info['Architecture'], 'engine': engine, 'rootless': rootless, 'emulated': bool(emulator), 'healthcheck': True, 'workspace': '仅本次容器内的 512 KiB tmpfs，非持久工作区', 'appData': '本次临时私有 bind mount', 'tls': '宿主完整校验证书/主机名；Chromium 仅对该测试证书公钥 SPKI 例外，不全局忽略 HTTPS 错误', 'kernelENOSPC': disk_full, 'browser': checks, 'passed': True}
        output = evidence / f'container-review-{info["Architecture"]}.json'
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(f'生产安全与磁盘满恢复演练通过：{output.relative_to(ROOT)}')
    except BaseException:
        if created:
            subprocess.run([engine, 'logs', '--tail', '30', name], check=False)
        raise
    finally:
        if created:
            subprocess.run([engine, 'stop', '--time', '15', name], check=False, stdout=subprocess.DEVNULL)
            subprocess.run([engine, 'rm', name], check=False, stdout=subprocess.DEVNULL)
