import { WorkspaceSessions } from './workspace'

export const workspace = new WorkspaceSessions([
  {
    path: '开始使用.md', mode: 'rich',
    source: '# 留一处，安放想法\n\n这里是 Folio，一个以文件为中心的轻量工作区。\n\n## 从一段文字开始\n\n直接书写，或选中文字试试 **加粗**、*斜体* 与行内 `代码`。输入 / 可插入段落、列表和表格。\n\n> 文件属于你，工具只是让书写更顺手。\n\n## 试试切换文件\n\n1. 在这里写下一句话。\n2. 打开左侧的「工作区.json」。\n3. 再回到这里，文字仍在。\n\n## 当前阶段\n\n这是 M0 编辑器验证版本，修改仅保留在当前页面内存中。刷新前请下载草稿；文件保存将在下一阶段接入。\n',
  },
  { path: '工作区.json', mode: 'source', source: '{\n  "名称": "我的工作区",\n  "主题": "跟随系统",\n  "说明": "在这里试试编辑 JSON，再切回 Markdown。"\n}\n' },
])
