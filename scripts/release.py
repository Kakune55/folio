"""构建包含前端资源的发布附件；与 GitHub Release 工作流共用。"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {
    'linux-amd64': ('linux', 'amd64', ''),
    'linux-arm64': ('linux', 'arm64', ''),
    'linux-armv7': ('linux', 'arm', '7'),
    'windows-amd64': ('windows', 'amd64', ''),
    'windows-arm64': ('windows', 'arm64', ''),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=TARGETS)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    tag = re.sub(r'[^A-Za-z0-9._-]+', '-', args.tag).strip('.-')
    if not tag:
        parser.error('Release 标签不能生成为空文件名')
    if not (ROOT / 'backend/web/dist/index.html').is_file():
        parser.error('缺少嵌入前端，请先构建前端并执行 scripts/copy-dist.py')
    goos, goarch, goarm = TARGETS[args.target]
    directory = ROOT / 'artifacts/release'
    build = directory / 'build' / args.target
    dist = directory / 'dist'
    build.mkdir(parents=True, exist_ok=True)
    dist.mkdir(parents=True, exist_ok=True)
    binary = build / ('folio.exe' if goos == 'windows' else 'folio')
    env = {**os.environ, 'CGO_ENABLED': '0', 'GOOS': goos, 'GOARCH': goarch, 'GOARM': goarm}
    subprocess.run(['go', 'build', '-trimpath', '-ldflags=-s -w', '-o', str(binary), './cmd/server'], cwd=ROOT / 'backend', env=env, check=True)
    base = f'folio_{tag}_{args.target}'
    if goos == 'windows':
        archive = dist / f'{base}.zip'
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
            output.write(binary, binary.name)
    else:
        archive = dist / f'{base}.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            info = output.gettarinfo(str(binary), arcname=binary.name)
            info.mode = 0o755
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            with binary.open('rb') as source:
                output.addfile(info, source)
    with archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    archive.with_name(archive.name + '.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
    print(f'已生成 {archive.name} 及 SHA-256 校验文件')


if __name__ == '__main__':
    main()
