export type EditorMode = 'rich' | 'source'
export type Session = {
  path: string
  source: string
  original: string
  mode: EditorMode
  dirty: boolean
}

// 正文只驻留在编辑会话中；全局状态仅管理导航和界面偏好。
export class WorkspaceSessions {
  private sessions = new Map<string, Session>()
  private listeners = new Set<() => void>()
  private revision = 0

  constructor(files: { path: string; source: string; mode: EditorMode }[]) {
    for (const file of files) this.sessions.set(file.path, { ...file, original: file.source, dirty: false })
  }
  get(path: string) {
    const session = this.sessions.get(path)
    if (!session) throw new Error('文件会话不存在')
    return session
  }
  list() { return [...this.sessions.values()] }
  update(path: string, source: string) {
    const session = this.get(path)
    session.source = source
    const dirty = source !== session.original
    if (session.dirty !== dirty) {
      session.dirty = dirty
      this.emit()
    }
  }
  setMode(path: string, mode: EditorMode) {
    const session = this.get(path)
    if (session.mode === mode) return
    session.mode = mode
    this.emit()
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  snapshot = () => this.revision
  private emit() {
    this.revision++
    this.listeners.forEach((listener) => listener())
  }
}

export const workspace = new WorkspaceSessions([
  {
    path: '开始使用.md', mode: 'rich',
    source: '# 留一处，安放想法\n\n这里是 Folio，一个以文件为中心的轻量工作区。\n\n## 从一段文字开始\n\n直接书写，或选中文字试试 **加粗**、*斜体* 与行内 `代码`。输入 / 可插入段落、列表和表格。\n\n> 文件属于你，工具只是让书写更顺手。\n\n## 试试切换文件\n\n1. 在这里写下一句话。\n2. 打开左侧的「工作区.json」。\n3. 再回到这里，文字仍在。\n\n## 当前阶段\n\n这是 M0 编辑器验证版本，修改仅保留在当前页面内存中。刷新前请下载草稿；文件保存将在下一阶段接入。\n',
  },
  { path: '工作区.json', mode: 'source', source: '{\n  "名称": "我的工作区",\n  "主题": "跟随系统",\n  "说明": "在这里试试编辑 JSON，再切回 Markdown。"\n}\n' },
])
