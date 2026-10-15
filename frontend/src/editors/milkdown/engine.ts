import { Crepe } from '@milkdown/crepe'
import { editorViewOptionsCtx } from '@milkdown/kit/core'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { codeTheme } from '../theme'
import '@milkdown/crepe/theme/common/prosemirror.css'
import '@milkdown/crepe/theme/common/reset.css'
import '@milkdown/crepe/theme/common/block-edit.css'
import '@milkdown/crepe/theme/common/code-mirror.css'
import '@milkdown/crepe/theme/common/cursor.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import '@milkdown/crepe/theme/common/list-item.css'
import '@milkdown/crepe/theme/common/placeholder.css'
import '@milkdown/crepe/theme/common/toolbar.css'
import '@milkdown/crepe/theme/common/table.css'
import '@milkdown/crepe/theme/classic.css'

// 只忽略序列化器添加的单个末尾换行；空格、转义和其他差异一律保守拒绝。
export function equivalentSource(source: string, serialized: string) {
  const withoutFinalNewline = (value: string) => value.endsWith('\n') ? value.slice(0, -1) : value
  return withoutFinalNewline(source) === withoutFinalNewline(serialized)
}

export function createCrepe(root: HTMLElement, source: string, onChange?: (source: string) => void, onUnsupported?: () => void) {
  const crepe = new Crepe({
    root, defaultValue: source,
    features: { [Crepe.Feature.AI]: false, [Crepe.Feature.TopBar]: false, [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: '写下想法，或输入 / 插入内容…' },
      [Crepe.Feature.Toolbar]: { boldLabel: '加粗', italicLabel: '斜体', codeLabel: '行内代码', linkLabel: '链接', strikethroughLabel: '删除线' },
      [Crepe.Feature.LinkTooltip]: { inputPlaceholder: '输入链接地址' },
      [Crepe.Feature.CodeMirror]: { theme: codeTheme, copyText: '复制', previewLabel: '预览', previewLoading: '正在加载…', searchPlaceholder: '搜索语言', noResultText: '没有匹配的语言', previewToggleText: (preview) => preview ? '编辑代码' : '预览代码' },
      [Crepe.Feature.BlockEdit]: {
        textGroup: { label: '文本', text: { label: '正文' }, h1: { label: '一级标题' }, h2: { label: '二级标题' }, h3: { label: '三级标题' }, h4: { label: '四级标题' }, h5: { label: '五级标题' }, h6: { label: '六级标题' }, quote: { label: '引用' }, divider: { label: '分隔线' } },
        listGroup: { label: '列表', bulletList: { label: '无序列表' }, orderedList: { label: '有序列表' }, taskList: { label: '任务列表' } },
        advancedGroup: { label: '更多', image: null, math: null, codeBlock: { label: '代码块' }, table: { label: '表格' } },
      },
    },
  })
  crepe.editor.config((ctx) => {
    // M0 无上传端点，禁止默认生成无法持久化的 blob 图片地址。
    ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: async () => { onUnsupported?.(); return [] } }))
    ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev,
      attributes: { 'aria-label': 'Markdown 富文本编辑器', role: 'textbox', 'aria-multiline': 'true' },
      handleDOMEvents: {
        click: (_view, event) => {
          const link = (event.target as HTMLElement).closest('a')
          if (!link) return false
          event.preventDefault()
          onUnsupported?.()
          return true
        },
      },
    }))
  })
  // 库的 markdownUpdated 带防抖；同步捕获文档事务，避免快速切换时遗漏最后输入。
  if (onChange) crepe.editor.use($prose(() => new Plugin({
    view: () => ({ update: (view, prev) => {
      if (!view.state.doc.eq(prev.doc)) onChange(crepe.getMarkdown())
    } }),
  })))
  return crepe
}

export async function inspectRoundTrip(source: string) {
  const root = document.createElement('div')
  root.hidden = true
  document.body.append(root)
  const editor = createCrepe(root, source)
  try {
    await editor.create()
    const serialized = editor.getMarkdown()
    return { serialized, safe: equivalentSource(source, serialized) }
  } finally {
    await editor.destroy()
    root.remove()
  }
}
