import { EditorView as CodeMirrorView } from '@codemirror/view'
import { Transaction as CodeMirrorTransaction } from '@codemirror/state'
import { languages } from '@codemirror/language-data'
import { createMermaidPreview, mermaidLanguage } from './mermaid-preview'
import { dropIndicatorPlugin } from '@milkdown/kit/plugin/cursor'
import { safeDropIndicator } from './drop-indicator'
import { entryMime, hasEntryTransfer, readEntryTransfer } from '../../features/explorer/entry-transfer'
import { Crepe } from '@milkdown/crepe'
import { editorViewOptionsCtx, editorViewCtx, parserCtx, serializerCtx, remarkCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { $view, $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { codeTheme } from '../theme'
import { imageSchema } from '@milkdown/kit/preset/commonmark'
import { extendListItemSchemaForTask } from '@milkdown/kit/preset/gfm'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CrepeBridge } from './bridge'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { createSourcePreserver, unsupportedMarkdown } from './preserve-source'
import { createMarkdownCodeInputPlugin } from './markdown-input'
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

type MarkdownNode = { type: string; position?: { start: { offset?: number } }; children?: MarkdownNode[] }
type Preserver = NonNullable<ReturnType<typeof createSourcePreserver>['preserver']>
const sourceAdapters = new WeakMap<Crepe, (source: string) => { safe: boolean; reason?: string }>()
export function prepareRichSource(editor: Crepe, source: string) {
  return sourceAdapters.get(editor)?.(source) ?? { safe: false, reason: '富文本保源检查尚未就绪。' }
}

export function createCrepe(root: HTMLElement, source: string, onChange?: (source: string) => void, onUnsupported?: (message?: string) => void, bridge?: CrepeBridge) {
  let tabReleaseUntil = 0
  const codeInput = createMarkdownCodeInputPlugin()
  let preserver: Preserver | undefined, emittedSource = source
  let prepared: { doc: ProseNode; result: ReturnType<Preserver['prepare']> } | undefined
  const prepareDocument = (doc: ProseNode) => {
    if (prepared?.doc !== doc) prepared = { doc, result: preserver!.prepare(doc) }
    return prepared.result
  }
  const mermaidPreview = createMermaidPreview(root)
  const crepe = new Crepe({
    root, defaultValue: source,
    features: { [Crepe.Feature.AI]: false, [Crepe.Feature.TopBar]: false, [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: '写下想法，或输入 / 插入内容…' },
      [Crepe.Feature.Toolbar]: { boldLabel: '加粗', italicLabel: '斜体', codeLabel: '行内代码', linkLabel: '链接', strikethroughLabel: '删除线' },
      [Crepe.Feature.LinkTooltip]: { inputPlaceholder: '输入链接地址' },
      [Crepe.Feature.CodeMirror]: { languages: [...languages, mermaidLanguage], renderPreview: mermaidPreview.render, extensions: [
        CodeMirrorView.contentAttributes.of({ 'aria-label': '代码块源码' }),
        CodeMirrorView.updateListener.of(update => {
          if (!update.docChanged || !preserver) return
          // 库先改 CM 缓冲再提交 PM；若事务被拒绝，恢复可见代码，不能让界面假装已接纳。
          queueMicrotask(() => {
            if (!update.view.dom.isConnected) return
            crepe.editor.action(ctx => {
              const view = ctx.get(editorViewCtx), block = update.view.dom.closest('.milkdown-code-block')
              if (view.isDestroyed || !block) return
              let expected: string | undefined
              view.state.doc.descendants((node, pos) => {
                if (node.type.name === 'code_block' && view.nodeDOM(pos) === block) { expected = node.textContent; return false }
              })
              if (expected === undefined || update.view.state.doc.toString() === expected) return
              // 库仅在 CM 有焦点时反向转发；恢复前临时失焦，避免把 B→A 差量应用到仍为 A 的 PM。
              const focused = update.view.hasFocus
              if (focused) update.view.contentDOM.blur()
              try {
                update.view.dispatch({ changes: { from: 0, to: update.view.state.doc.length, insert: expected }, selection: { anchor: Math.min(update.view.state.selection.main.head, expected.length) }, annotations: CodeMirrorTransaction.addToHistory.of(false) })
              } finally { if (focused && update.view.dom.isConnected) update.view.focus() }
              onUnsupported?.('代码块修改未被接纳，已恢复原代码；可切换源码编辑。')
            })
          })
        }),
      ], theme: codeTheme, copyText: '复制', previewLabel: '预览', previewLoading: '正在加载…', searchPlaceholder: '搜索语言', noResultText: '没有匹配的语言', previewToggleText: (preview) => preview ? '编辑代码' : '预览代码' },
      [Crepe.Feature.BlockEdit]: {
        textGroup: { label: '文本', text: { label: '正文' }, h1: { label: '一级标题' }, h2: { label: '二级标题' }, h3: { label: '三级标题' }, h4: { label: '四级标题' }, h5: { label: '五级标题' }, h6: { label: '六级标题' }, quote: { label: '引用' }, divider: { label: '分隔线' } },
        listGroup: { label: '列表', bulletList: { label: '无序列表' }, orderedList: { label: '有序列表' }, taskList: { label: '任务列表' } },
        advancedGroup: { label: '更多', image: null, math: null, codeBlock: { label: '代码块' }, table: { label: '表格' } },
      },
    },
  })
  void crepe.editor.remove(dropIndicatorPlugin)
  crepe.editor.use(safeDropIndicator)
  sourceAdapters.set(crepe, original => crepe.editor.action(ctx => {
    const result = createSourcePreserver(original, ctx.get(editorViewCtx).state.doc, {
      parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx), ast: text => ctx.get(remarkCtx).parse(text),
    })
    if (!result.preserver) return { safe: false, reason: result.reason }
    preserver = result.preserver; emittedSource = original; prepared = undefined
    return { safe: true }
  }))
  crepe.editor.use($prose(() => new Plugin({ view: () => ({ destroy: mermaidPreview.destroy }) })))
  const uploads = new PluginKey<Map<symbol, number>>('folio-image-uploads')
  const protectTransfer = (event: ClipboardEvent | DragEvent) => {
    const transfer = event instanceof ClipboardEvent ? event.clipboardData : event.dataTransfer
    const text = transfer?.getData('text/plain')
    if (!text || transfer?.files.length) return false
    const reason = unsupportedMarkdown(text, crepe.editor.action(ctx => ctx.get(remarkCtx).parse(text)))
    if (!reason) return false
    event.preventDefault()
    onUnsupported?.(`剪贴板 Markdown 无法安全保留，已取消粘贴／拖入；原文未变。${reason}请切换源码后粘贴。`)
    return true
  }
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
        try {
          view.dispatch(view.state.tr.replaceRangeWith(pos, pos, view.state.schema.nodes.image.create({ src: url, alt: file.name })).setMeta(uploads, { remove: id }))
          if (uploads.getState(view.state)?.has(id)) throw new Error('图片插入事务被拒绝')
        }
        catch { bridge.detachedImage(url, file.name); onUnsupported?.('图片已上传，当前位置无法安全插入，已追加到原笔记末尾。') }
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
    ctx.update(extendListItemSchemaForTask.key, previous => context => {
      const schema = previous(context)
      // 新建单段列表项应是紧凑列表；解析已有宽松列表时显式 spread 仍保留。
      return { ...schema, attrs: { ...schema.attrs, spread: { ...schema.attrs!.spread, default: false } } }
    })
    const bullets = new Set<'-' | '*' | '+'>()
    const visit = (node: MarkdownNode) => {
      if (node.type === 'listItem' && node.position?.start.offset !== undefined) {
        const marker = source[node.position.start.offset]
        if (marker === '-' || marker === '*' || marker === '+') bullets.add(marker)
      }
      node.children?.forEach(visit)
    }
    // 使用解析节点位置，不把代码块或行内文本中的符号误认为列表风格。
    visit(ctx.get(remarkCtx).parse(source))
    ctx.update(remarkStringifyOptionsCtx, previous => ({ ...previous, bullet: bullets.size === 1 ? [...bullets][0] : '-' }))
    // 不使用库的临时 blob 上传；真实上传由带会话保护的桥接处理。
    ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: async () => { onUnsupported?.(); return [] } }))
    ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev,
      attributes: { 'aria-label': 'Markdown 富文本编辑器', role: 'textbox', 'aria-multiline': 'true', 'aria-description': '按 Escape 后再按 Tab 或 Shift+Tab 离开编辑器。' },
      handleDOMEvents: {
        keydown: (view, event) => {
          // DOM 阶段先处理围栏，避免默认 Enter 分段快捷键先消费事件。
          if (codeInput.props.handleKeyDown?.call(codeInput, view, event)) { event.preventDefault(); return true }
          if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
            const selection = view.state.selection
            if (selection instanceof TextSelection && selection.empty && selection.$from.parent.type.name === 'paragraph'
              && selection.$from.parentOffset === selection.$from.parent.content.size) {
              // Milkdown 会剔除段末 hardbreak；绝不能把看似插入的换行静默保存成普通段落。
              event.preventDefault()
              onUnsupported?.('段落末尾的 Shift+Enter 暂无法无损保存，操作未生效；请用普通 Enter 新建段落，或切换源码编辑硬换行。')
              return true
            }
          }
          if (event.key === 'Escape') { tabReleaseUntil = Date.now() + 2000; return false }
          if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && Date.now() < tabReleaseUntil) {
            tabReleaseUntil = 0
            // 接管 ProseMirror 的 Tab 快捷键，但不 preventDefault，让浏览器正常移动焦点。
            return true
          }
          if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) tabReleaseUntil = 0
          return false
        },
        paste: (view, event) => protectTransfer(event) || handleFiles(view, event, event.clipboardData?.files),
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
          return protectTransfer(event) || handleFiles(view, event, event.dataTransfer?.files)
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
  crepe.editor.use($prose(() => new Plugin({
    filterTransaction(transaction) {
      if (!transaction.docChanged || !preserver) return true
      const result = prepareDocument(transaction.doc)
      if (!('error' in result)) return true
      queueMicrotask(() => onUnsupported?.(`此操作无法安全保留 Markdown，已阻止：${result.error} 可切换源码编辑，原文未被替换。`))
      return false
    },
    view: () => ({ update: (view, prev) => {
      if (!preserver || view.state.doc.eq(prev.doc)) return
      const result = prepareDocument(view.state.doc)
      if ('error' in result) { onUnsupported?.(`Markdown 保源核对失败，未保存：${result.error}`); return }
      result.commit(); prepared = undefined
      if (result.source !== emittedSource) { emittedSource = result.source; onChange?.(result.source) }
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
    return { serialized, safe: prepareRichSource(editor, source).safe }
  } finally {
    await editor.destroy()
    root.remove()
  }
}
