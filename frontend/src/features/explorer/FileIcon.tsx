import { DefaultFolderOpenedIcon, FileIcon as SymbolFileIcon, FolderIcon as SymbolFolderIcon } from '@react-symbols/icons/utils'

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  return <SymbolFileIcon fileName={path.split('/').at(-1) ?? path} autoAssign width={size} height={size} className="file-type-icon" aria-hidden="true" focusable="false" />
}

export function FolderIcon({ path = '', expanded = false }: { path?: string; expanded?: boolean }) {
  const props = { width: 16, height: 16, className: 'file-type-icon', 'aria-hidden': true as const, focusable: false as const }
  return expanded ? <DefaultFolderOpenedIcon {...props} /> : <SymbolFolderIcon folderName={path.split('/').at(-1) ?? path} {...props} />
}
