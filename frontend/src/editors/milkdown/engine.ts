import { dropIndicatorPlugin } from '@milkdown/kit/plugin/cursor'
import { safeDropIndicator } from './drop-indicator'
import { entryMime, hasEntryTransfer, readEntryTransfer } from '../../features/explorer/entry-transfer'
import { Crepe } from '@milkdown/crepe'
import { editorViewOptionsCtx } from '@milkdown/kit/core'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { $view, $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { codeTheme } from '../theme'
import { imageSchema } from '@milkdown/kit/preset/commonmark'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CrepeBridge } from './bridge'
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

export function createCrepe(root: HTMLElement, source: string, onChange?: (source: string) => void, onUnsupported?: (message?: string) => void, bridge?: CrepeBridge) {
  let tabReleaseUntil = 0
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
  void crepe.editor.remove(dropIndicatorPlugin)
  crepe.editor.use(safeDropIndicator)
  const uploads = new PluginKey<Map<symbol, number>>('folio-image-uploads')
  const handleFiles = (view: EditorView, event: ClipboardEvent | DragEvent, files: FileList | undefined) => {
    if (!bridge || !files?.length) return false
    event.preventDefault()
    const position = event instanceof DragEvent ? view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from : view.state.selection.from
    for (const file of Array.from(files)) {
      if (!bridge.beginUpload()) { onUnsupported?.('文件操作正在进行，请稍后再粘贴图片。'); continue }
      const id = Symbol('图片上传')
      view.dispatch(view.state.tr.setMeta(uploads, { add: id, position }))
      void bridge.upload(file).then((url) => {
        if (view.isDestroyed || (bridge.attached && !bridge.attached())) { bridge.detachedImage(url, file.name); return }
        const pos = uploads.getState(view.state)?.get(id)
        if (pos === undefined) { bridge.detachedImage(url, file.name); return }
        try { view.dispatch(view.state.tr.replaceRangeWith(pos, pos, view.state.schema.nodes.image.create({ src: url, alt: file.name })).setMeta(uploads, { remove: id })) }
        catch { bridge.detachedImage(url, file.name); onUnsupported?.('图片已上传，插入位置发生变化，已追加到原笔记末尾。') }
      }).catch((error: unknown) => onUnsupported?.(error instanceof Error ? error.message : '图片上传失败，原文保持不变'))
        .finally(() => {
          if (!view.isDestroyed && (!bridge.attached || bridge.attached())) view.dispatch(view.state.tr.setMeta(uploads, { remove: id }))
          bridge.endUpload()
        })
    }
    return true
  }
  if (bridge) {
    crepe.editor.use($prose(() => new Plugin({
      key: uploads,
      state: {
        init: () => new Map(),
        apply: (tr, state) => {
          const next = new Map([...state].map(([key, position]) => [key, tr.mapping.map(position)]))
          const action = tr.getMeta(uploads)
          if (action?.add) next.set(action.add, action.position)
          if (action?.remove) next.delete(action.remove)
          return next
        },
      },
      view: () => {
        const handleLink = (event: MouseEvent) => {
          const link = event.target instanceof Element ? event.target.closest('a') : null
          const image = event.target instanceof Element ? event.target.closest<HTMLImageElement>('img[data-file-link]') : null
          if (!link && !image) return
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) {
            if (link) event.preventDefault()
            return
          }
          event.preventDefault(); event.stopPropagation(); bridge.openLink(image?.dataset.fileLink ?? link?.getAttribute('href') ?? '')
        }
        root.addEventListener('click', handleLink, true)
        return { destroy: () => root.removeEventListener('click', handleLink, true) }
      },
    })))
    crepe.editor.use($view(imageSchema.node, () => (initialNode) => {
      const image = document.createElement('img')
      image.loading = 'lazy'; image.className = 'folio-markdown-image'
      const bind = (node: typeof initialNode) => { const url = bridge.imageURL(node.attrs.src); if (url) image.src = url; else image.removeAttribute('src'); image.alt = node.attrs.alt ?? ''; image.dataset.fileLink = node.attrs.src; image.title = 'Ctrl/Cmd+点击打开图片文件' }
      bind(initialNode)
      image.onerror = () => onUnsupported?.('笔记中的图片加载失败，请确认文件仍存在、格式受支持且登录有效。')
      return { dom: image, update: (node) => { if (node.type !== initialNode.type) return false; bind(node); return true }, destroy: () => { image.onerror = null } }
    }))
  }
  crepe.editor.config((ctx) => {
    // 不使用库的临时 blob 上传；真实上传由带会话保护的桥接处理。
    ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: async () => { onUnsupported?.(); return [] } }))
    ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev,
      attributes: { 'aria-label': 'Markdown 富文本编辑器', role: 'textbox', 'aria-multiline': 'true', 'aria-description': '按 Escape 后再按 Tab 或 Shift+Tab 离开编辑器。' },
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (event.key === 'Escape') { tabReleaseUntil = Date.now() + 2000; return false }
          if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && Date.now() < tabReleaseUntil) {
            tabReleaseUntil = 0
            // 接管 ProseMirror 的 Tab 快捷键，但不 preventDefault，让浏览器正常移动焦点。
            return true
          }
          if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) tabReleaseUntil = 0
          return false
        },
        paste: (view, event) => handleFiles(view, event, event.clipboardData?.files),
        dragover: (_view, event) => {
          if (!bridge || !hasEntryTransfer(event.dataTransfer)) return false
          event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; return true
        },
        drop: (view, event) => {
          if (bridge && event.dataTransfer?.types.includes(entryMime)) {
            event.preventDefault()
            const entry = readEntryTransfer(event.dataTransfer)
            const reference = entry && bridge.reference(entry)
            if (reference) {
              const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
              const node = reference.image ? view.state.schema.nodes.image.create({ src: reference.url, alt: reference.alt }) : view.state.schema.text(reference.alt, [view.state.schema.marks.link.create({ href: reference.url })])
              try { view.dispatch(view.state.tr.replaceRangeWith(position, position, node)); view.focus() }
              catch { onUnsupported?.('当前拖放位置无法插入引用，请选择正文段落后重试。') }
            }
            return true
          }
          return handleFiles(view, event, event.dataTransfer?.files)
        },
        click: (_view, event) => {
          const link = (event.target as HTMLElement).closest('a')
          if (!link) return false
          event.preventDefault()
          if (bridge) return false
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
