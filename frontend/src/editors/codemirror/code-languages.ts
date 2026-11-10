import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

const aliases: Record<string, string> = {
  py: 'python', py3: 'python', python3: 'python', rb: 'ruby', rs: 'rust', golang: 'go', kt: 'kotlin', kts: 'kotlin',
  ps1: 'powershell', console: 'shell', 'shell-session': 'shell',
}
const plain = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none'])
const plainSupport = new LanguageSupport(StreamLanguage.define({ token(stream) { stream.skipToEnd(); return null } }))

export function codeLanguage(info: string, catalog: readonly LanguageDescription[] = languages) {
  const name = info.trim().split(/\s/, 1)[0] ?? ''
  const key = name.toLowerCase()
  const description = plain.has(key) ? undefined : LanguageDescription.matchLanguageName(catalog, aliases[key] ?? key, false) ?? undefined
  return { name, description, label: description?.name ?? (name || '纯文本') }
}

// 包装每个文件所需的懒加载；失败明确报告并停止重试，正文仍可编辑／复制。
export function createCodeLanguages(onFailure: (name: string) => void, catalog: readonly LanguageDescription[] = languages) {
  const cached = new Map<LanguageDescription, LanguageDescription>()
  return (info: string) => {
    const { description } = codeLanguage(info, catalog)
    if (!description) return null
    let entry = cached.get(description)
    if (!entry) {
      entry = LanguageDescription.of({ name: description.name, load: async () => {
        try { return await description.load() }
        catch { onFailure(description.name); return plainSupport }
      } })
      cached.set(description, entry)
    }
    return entry
  }
}
