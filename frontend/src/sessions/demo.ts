import { WorkspaceSessions } from './workspace'

export const workspace = new WorkspaceSessions([
  {
    path: '开始使用.md', mode: 'rich',
    source: '# 留一处，安放想法\n\n这里是 Folio，一个以文件为中心的轻量工作区。\n\n## 从一段文字开始\n\n直接书写，或选中文字试试 **加粗**、*斜体* 与行内 `代码`。工具条可插入链接、列表和引用；实时预览与源码共用同一份文本。\n\n> 文件属于你，工具只是让书写更顺手。\n\n## 试试切换文件\n\n1. 在这里写下一句话。\n2. 打开左侧的「工作区.json」。\n3. 再回到这里，文字仍在。\n\n## 当前阶段\n\n这页用于验证 CodeMirror 6 实时预览，修改仅保留在当前页面内存中。切换模式保留选区和撤销，刷新前请下载草稿；正常登录的工作区仍使用条件自动保存。\n',
  },
  { path: '工作区.json', mode: 'source', source: '{\n  "名称": "我的工作区",\n  "主题": "跟随系统",\n  "说明": "在这里试试编辑 JSON，再切回 Markdown。"\n}\n' },
])
