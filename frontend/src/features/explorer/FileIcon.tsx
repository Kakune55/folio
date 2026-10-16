import { FileArchive, FileCode2, FileJson, FileText, Image } from 'lucide-react'

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  const Icon = extension && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension) ? Image
    : extension && ['zip', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(extension) ? FileArchive
      : extension && ['json', 'jsonc'].includes(extension) ? FileJson
        : extension && ['go', 'py', 'js', 'ts', 'tsx', 'jsx', 'sh', 'html', 'css', 'yaml', 'yml', 'toml', 'ini'].includes(extension) ? FileCode2 : FileText
  return <Icon size={size} aria-hidden="true" />
}
