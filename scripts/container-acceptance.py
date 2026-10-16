"""用独立的两个挂载目录验收实际 HTTPS 容器，结束后清理本次容器和测试数据。"""
from pathlib import Path
import datetime
import base64
import hashlib
import json
import os
import secrets
import ssl
import subprocess
import tempfile
import time
import urllib.request
import uuid

root = Path(__file__).resolve().parent.parent
engine = os.environ.get('CONTAINER_ENGINE', 'docker')
image = os.environ.get('FOLIO_TEST_IMAGE', 'folio:local')
evidence = root / 'artifacts/container'
evidence.mkdir(parents=True, exist_ok=True)
name = 'folio-accept-' + uuid.uuid4().hex[:12]
emulator = os.environ.get('FOLIO_TEST_QEMU')

def run(*args, **kwargs):
    return subprocess.run([engine, *args], check=True, text=True, **kwargs)

image_info = json.loads(run('image', 'inspect', image, capture_output=True).stdout)[0]
rootless = False
if Path(engine).name == 'podman':
    rootless = run('info', '--format', '{{.Host.Security.Rootless}}', capture_output=True).stdout.strip() == 'true'
with tempfile.TemporaryDirectory(prefix='folio-container-accept-') as directory:
    data = Path(directory)
    subprocess.run(['sh', str(root / 'scripts/setup-local-tls.sh'), str(data)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    public = subprocess.run(['openssl', 'x509', '-in', str(data / 'app-data/tls/server.crt'), '-pubkey', '-noout'], check=True, capture_output=True).stdout
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public, check=True, capture_output=True).stdout
    spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
    args = ['run', '-d', '--platform', 'linux/' + image_info.get('Architecture', 'amd64'), '--pull=never', '--name', name, '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m', '-p', '127.0.0.1::8080', '-v', f'{data / "workspace"}:/workspace', '-v', f'{data / "app-data"}:/app-data', '-e', 'FOLIO_TLS_CERT=/app-data/tls/server.crt', '-e', 'FOLIO_TLS_KEY=/app-data/tls/server.key']
    if rootless:
        args += ['--userns=keep-id']
    args += ['--user', f'{os.getuid()}:{os.getgid()}']
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
        trust = ssl.create_default_context(cafile=str(data / 'app-data/tls/server.crt'))
        def ready():
            for _ in range(100):
                try:
                    with urllib.request.urlopen(url + '/api/v1/healthz', context=trust, timeout=1) as response:
                        if response.status == 200:
                            return
                except (OSError, TimeoutError):
                    time.sleep(.2)
            raise RuntimeError('容器未在时间内就绪')
        ready()
        run('exec', name, *(['/qemu'] if emulator else []), '/folio', '-healthcheck', stdout=subprocess.DEVNULL)
        if rootless and not emulator:
            run('healthcheck', 'run', name, stdout=subprocess.DEVNULL)
        password = (data / 'app-data/initial-password').read_text().strip()
        env = dict(os.environ, FOLIO_ACCEPT_URL=url, FOLIO_ACCEPT_DATA=str(data), FOLIO_ACCEPT_PROFILE=str(data / 'browser-profile'), FOLIO_ACCEPT_PASSWORD=password, FOLIO_ACCEPT_SPKI=spki, FOLIO_ACCEPT_EVIDENCE=str(evidence), FOLIO_ACCEPT_ARCH=image_info.get('Architecture', 'unknown'))
        driver = root / 'frontend/scripts/container-acceptance.mjs'
        subprocess.run(['node', str(driver), 'write'], cwd=root / 'frontend', env=env, check=True, timeout=90)
        run('restart', '--time', '15', name, stdout=subprocess.DEVNULL)
        ready()
        run('exec', name, *(['/qemu'] if emulator else []), '/folio', '-healthcheck', stdout=subprocess.DEVNULL)
        if rootless and not emulator:
            run('healthcheck', 'run', name, stdout=subprocess.DEVNULL)
        subprocess.run(['node', str(driver), 'verify'], cwd=root / 'frontend', env=env, check=True, timeout=90)
        new_password = secrets.token_urlsafe(24)
        secret = data / 'reset-password'
        secret.write_text(new_password + '\n'); secret.chmod(0o600)
        maintenance = ['run', '--rm', '--pull=never', '--platform', 'linux/' + image_info.get('Architecture', 'amd64'), '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', f'{os.getuid()}:{os.getgid()}', '-v', f'{data / "app-data"}:/app-data', '-v', f'{secret}:/reset-password:ro']
        if rootless:
            maintenance += ['--userns=keep-id']
        if emulator:
            maintenance += ['--entrypoint', '/qemu', '-v', f'{Path(emulator).resolve()}:/qemu:ro', image, '/folio']
        else:
            maintenance += [image]
        maintenance += ['-reset-password', '-app-data', '/app-data', '-password-file', '/reset-password']
        refused = subprocess.run([engine, *maintenance], text=True, capture_output=True, timeout=60)
        if refused.returncode == 0 or '已有运行中的实例' not in refused.stderr:
            raise RuntimeError('在线离线改密命令未被实例锁明确拒绝')
        run('stop', '--time', '15', name, stdout=subprocess.DEVNULL)
        run(*maintenance, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run('start', name, stdout=subprocess.DEVNULL)
        ready()
        env['FOLIO_ACCEPT_RESET_PASSWORD'] = new_password
        subprocess.run(['node', str(driver), 'reset'], cwd=root / 'frontend', env=env, check=True, timeout=90)
        report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'engine': engine, 'image': image, 'imageId': image_info.get('Id'), 'architecture': image_info.get('Architecture'), 'size': image_info.get('Size'), 'user': image_info.get('Config', {}).get('User'), 'rootless': rootless, 'emulated': bool(emulator), 'healthcheck': True, 'tls': '宿主 CA/主机名校验；浏览器只例外临时证书 SPKI，不全局忽略 HTTPS 错误', 'onlineResetRefused': True, 'phases': [json.loads((data / f'{phase}.json').read_text()) for phase in ['write', 'verify', 'reset']]}
        report_path = evidence / f"container-acceptance-{report['architecture']}.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(f'部署/重启/离线改密容器验收通过，证据已写入 {report_path.relative_to(root)}')
    except BaseException:
        if created:
            subprocess.run([engine, 'logs', '--tail', '30', name], check=False)
        raise
    finally:
        if created:
            subprocess.run([engine, 'stop', '--time', '15', name], check=False, stdout=subprocess.DEVNULL)
            subprocess.run([engine, 'rm', name], check=False, stdout=subprocess.DEVNULL)
