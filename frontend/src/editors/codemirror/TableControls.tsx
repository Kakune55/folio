import { useEffect, useRef, useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { EditorView } from '@codemirror/view'
import { Check, ChevronDown, Table2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { insertTableTransaction, tableContext, tableTransaction, type TableAction } from './tables'
import './table-controls.css'

type Props = { view: EditorView | null; disabled: boolean; onBlocked?: (message: string) => void; local?: () => boolean; canEdit?: () => boolean }
const actions: { action: TableAction; label: string }[] = [
  { action: 'insertRowBefore', label: '上方插入行' }, { action: 'insertRowAfter', label: '下方插入行' }, { action: 'deleteRow', label: '删除当前行' },
  { action: 'insertColumnBefore', label: '左侧插入列' }, { action: 'insertColumnAfter', label: '右侧插入列' }, { action: 'deleteColumn', label: '删除当前列' },
]

export function TableControls({ view, disabled, onBlocked, local, canEdit }: Props) {
  const [open, setOpen] = useState(false)
  const [context, setContext] = useState<ReturnType<typeof tableContext>>()
  const [insertOpen, setInsertOpen] = useState(false), [rows, setRows] = useState('2'), [columns, setColumns] = useState('2'), [error, setError] = useState('')
  const focusEditor = useRef(false), openingDialog = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const openingDocument = useRef(view?.state.doc)
  useEffect(() => {
    if (!view || !view.dom.isConnected || local && !open) return
    const update = () => setContext(tableContext(view.state))
    update(); view.dom.addEventListener('folio-navigation', update)
    return () => view.dom.removeEventListener('folio-navigation', update)
  }, [view, local, open])
  const ready = () => !!view && view.dom.isConnected && !disabled && canEdit?.() !== false && !view.state.readOnly && view.state.facet(EditorView.editable) && !view.composing && !view.compositionStarted
  const run = (action: TableAction) => {
    if (!ready()) { onBlocked?.('当前不能编辑表格，请先处理未确认输入或文件操作。'); return }
    const result = tableTransaction(view!.state, action)
    if ('error' in result) { onBlocked?.(result.error); return }
    view!.dispatch(result); focusEditor.current = true
  }
  return <>
    <Menu.Root modal={false} open={open} onOpenChange={next => {
      if (next) {
        if (local && !local()) return
        focusEditor.current = false; openingDialog.current = false
        if (view?.dom.isConnected) setContext(tableContext(view.state))
      }
      setOpen(next)
    }}>
      <Menu.Trigger asChild ref={trigger}><Button size={local ? undefined : 'icon'} className={local ? 'folio-table-local-trigger' : undefined} data-table-trigger={local ? undefined : true} aria-label={local ? '此表格操作' : '表格'} title={local ? '操作这张表格的行列与对齐' : '插入表格与行列操作'} disabled={disabled || !view || !!local && (view.state.readOnly || canEdit?.() === false)}><Table2 size={15} />{local && <><span>表格</span><ChevronDown size={12} /></>}</Button></Menu.Trigger>
      <Menu.Portal><Menu.Content className="context-menu folio-table-menu" sideOffset={5} aria-label="表格操作" onCloseAutoFocus={event => {
        if (openingDialog.current) { event.preventDefault(); return }
        if (focusEditor.current && view?.dom.isConnected) { event.preventDefault(); view.focus() }
      }}>
        {!local && <><Menu.Item onSelect={() => {
          if (!ready()) return
          openingDocument.current = view!.state.doc; openingDialog.current = true; setError(''); setInsertOpen(true)
        }}>插入新表格…</Menu.Item>
        <Menu.Separator /></>}
        <Menu.Label className="folio-table-context">{context ? `${context.row === 0 ? '表头' : `第 ${context.row} 行`} · 第 ${context.column + 1} 列` : '当前没有可操作的表格单元格'}</Menu.Label>
        {actions.map(({ action, label }) => <Menu.Item key={action} className={action.startsWith('delete') ? 'destructive' : undefined} disabled={disabled || !context || (context.row === 0 && ['insertRowBefore', 'deleteRow'].includes(action)) || (context.columnCount === 1 && action === 'deleteColumn')} onSelect={() => run(action)}>{label}</Menu.Item>)}
        <Menu.Separator />
        <Menu.Label className="folio-table-context">当前列对齐</Menu.Label>
        <Menu.RadioGroup value={context ? context.alignment === 'none' ? 'left' : context.alignment : ''} onValueChange={value => run(value === 'left' ? 'alignLeft' : value === 'center' ? 'alignCenter' : 'alignRight')}>
          {([['left', '左对齐'], ['center', '居中'], ['right', '右对齐']] as const).map(([value, label]) => <Menu.RadioItem key={value} value={value} disabled={disabled || !context}><span>{label}</span><Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator></Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
    <Dialog.Root open={insertOpen} onOpenChange={open => { setInsertOpen(open); if (!open) openingDialog.current = false }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content folio-table-dialog" onCloseAutoFocus={event => { event.preventDefault(); if (focusEditor.current && view?.dom.isConnected) view.focus(); else trigger.current?.focus() }}>
      <Dialog.Title>插入表格</Dialog.Title><Dialog.Description>创建表头和空白正文行，不覆盖现有文字。之后可用 Tab 切换单元格。</Dialog.Description>
      <form onSubmit={event => {
        event.preventDefault()
        if (!ready()) { setError('文件正在处理，暂不能插入表格。'); return }
        if (view!.state.doc !== openingDocument.current) { setError('打开窗口后正文已变化，请关闭后重新插入。'); return }
        const result = insertTableTransaction(view!.state, Number(rows), Number(columns))
        if ('error' in result) { setError(result.error); return }
        view!.dispatch(result); focusEditor.current = true; setInsertOpen(false); openingDialog.current = false
      }}>
        <div className="folio-table-size"><label>正文行数<input type="number" min={1} max={20} step={1} required value={rows} onChange={event => setRows(event.target.value)} /></label><label>列数<input type="number" min={1} max={20} step={1} required value={columns} onChange={event => setColumns(event.target.value)} /></label></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><Dialog.Close asChild><Button type="button">取消</Button></Dialog.Close><Button variant="outline" disabled={disabled} type="submit">插入</Button></div>
      </form>
    </DialogContent></Dialog.Portal></Dialog.Root>
  </>
}
