"""将前端构建结果复制到 Go 的嵌入目录。"""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
source = root / 'frontend/dist'
target = root / 'backend/web/dist'
if not (source / 'index.html').is_file():
    raise SystemExit('前端构建产物缺失，请先执行 npm run build')
for child in target.iterdir():
    if child.name == '.gitkeep':
        continue
    if child.is_dir():
        shutil.rmtree(child)
    else:
        child.unlink()
shutil.copytree(source, target, dirs_exist_ok=True)
