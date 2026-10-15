"""浏览器测试专用 API：隔离目录、固定测试账号，退出时删除测试数据。"""
from pathlib import Path
import os
import signal
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='folio-e2e-') as directory:
    base = Path(directory)
    workspace = base / 'workspace'
    workspace.mkdir()
    password = base / 'password'
    password.write_text('folio-browser-test-password-2026\n')
    password.chmod(0o600)
    env = dict(os.environ, FOLIO_WORKSPACE=str(workspace), FOLIO_APP_DATA=str(base / 'app-data'), FOLIO_PASSWORD_FILE=str(password), FOLIO_ADDR='127.0.0.1:18081', FOLIO_SECURE_COOKIE='false', FOLIO_ORIGIN='http://127.0.0.1:5173')
    binary = base / 'folio-test-server'
    subprocess.run(['go', 'build', '-o', str(binary), './cmd/server'], cwd=root / 'backend', check=True)
    process = subprocess.Popen([str(binary)], env=env)
    def stop(*_args):
        if process.poll() is None:
            process.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        raise SystemExit(process.wait())
    finally:
        stop()
