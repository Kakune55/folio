import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { isolateHistory } from '@codemirror/commands'
import { ChangeSet, EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'

export type TableAction = 'insertRowBefore' | 'insertRowAfter' | 'deleteRow' | 'insertColumnBefore' | 'insertColumnAfter' | 'deleteColumn' | 'alignLeft' | 'alignCenter' | 'alignRight'
type Failure = { error: string }
type Cell = { from: number; to: number; start: number; end: number }
type Row = { from: number; to: number; indent: string; cells: Cell[]; left: boolean; right: boolean }
type Alignment = 'left' | 'center' | 'right' | 'none'
type Table = { from: number; to: number; rows: Row[]; delimiter: Row; row: number; column: number }
export type TableContext = { from: number; to: number; row: number; column: number; rowCount: number; columnCount: number; alignment: Alignment; cell: { from: number; to: number } }
const unsupported = (): Failure => ({ error: '此表格的结构或范围无法安全验证，请继续使用源码编辑。' })
const readonly = (): Failure => ({ error: '当前文档为只读，不能操作表格。' })

// Lezer 的空单元格没有 TableCell；用转义规则分段，再与真实节点逐一核对。
function rowAt(state: EditorState, node: SyntaxNode, delimiter = false): Row | undefined {
  const line = state.doc.lineAt(node.from)
  if (node.to !== line.to || state.doc.lineAt(node.to).number !== line.number) return
  const indent = line.text.match(/^ {0,3}/)![0]
  const text = line.text.slice(indent.length), base = line.from + indent.length
  if (!text || /^[ \t]/.test(text)) return
  const pipes: number[] = []
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '|' && !escaped) pipes.push(base + i)
    escaped = !escaped && text[i] === '\\'
  }
  const left = pipes[0] === base, last = pipes.at(-1)
  const right = last !== undefined && /^[ \t]*$/.test(state.sliceDoc(last + 1, line.to))
  const boundaries = [left ? base + 1 : base, ...pipes.filter(p => (!left || p !== base) && (!right || p !== last)).map(p => p + 1)]
  const end = right ? last! : line.to
  const cells = boundaries.map((start, i) => {
    const stop = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : end
    const raw = state.sliceDoc(start, stop), leading = raw.match(/^[ \t]*/)![0].length
    const content = raw.trim()
    const from = start + leading
    return { start, end: stop, from: content ? from : start + Math.min(1, leading), to: content ? from + content.length : start + Math.min(1, leading) }
  })
  if (!cells.length || cells.some(c => c.end < c.start)) return
  if (delimiter) {
    if (cells.some(c => !/^:?-+:?$/.test(state.sliceDoc(c.from, c.to)))) return
  } else {
    const marks = node.getChildren('TableDelimiter')
    if (marks.length !== pipes.length || marks.some((m, i) => m.from !== pipes[i] || m.to !== m.from + 1)) return
    const nonempty = cells.filter(c => c.from !== c.to), parsed = node.getChildren('TableCell')
    if (nonempty.length !== parsed.length || parsed.some((c, i) => c.from !== nonempty[i].from || c.to !== nonempty[i].to)) return
  }
  return { from: line.from, to: line.to, indent, cells, left, right }
}

function locate(state: EditorState, position?: number, complete = false): Table | Failure | undefined {
  const selection = position === undefined ? state.selection.main : EditorSelection.cursor(position)
  const at = (tree: Tree) => {
    // 只操作外层 Markdown；围栏子语言里的 Table 不是当前文档表格。
    let node: SyntaxNode | null = tree.resolve(selection.head, 1)
    while (node && node.name !== 'Table') node = node.parent
    if (!node) {
      node = tree.resolve(selection.head, -1)
      while (node && node.name !== 'Table') node = node.parent
    }
    return node
  }
  // 输入、选区及滚动订阅只读现有树；表外 Tab 也不能强迫长文档补解析。
  let node = at(syntaxTree(state))
  if (!node) return
  if (complete) {
    if (node.to - node.from > 20000) return unsupported()
    const tree = ensureSyntaxTree(state, Math.min(state.doc.length, node.from + 20001), 30)
    if (!tree) return unsupported()
    node = at(tree)
  }
  if (!node) return
  if ((position === undefined && state.selection.ranges.length !== 1) || node.parent?.name !== 'Document' || node.to - node.from > 20000 || selection.from < node.from || selection.to > node.to) return unsupported()
  const nodes = node.getChildren('TableHeader').concat(node.getChildren('TableRow'))
  const separator = node.getChild('TableDelimiter')
  if (!separator || !nodes.length || nodes.length > 500) return unsupported()
  const delimiter = rowAt(state, separator, true), rows: Row[] = []
  if (!delimiter) return unsupported()
  for (const item of nodes) {
    const row = rowAt(state, item)
    if (!row || row.cells.length !== delimiter.cells.length) return unsupported()
    rows.push(row)
  }
  if (rows.length * delimiter.cells.length > 500 || rows[0].to + 1 !== delimiter.from || rows.some((r, i) => i > 0 && r.from !== (i === 1 ? delimiter.to : rows[i - 1].to) + 1)) return unsupported()
  const line = state.doc.lineAt(selection.head)
  const row = rows.findIndex(r => line.from === r.from)
  // 分隔行映射至表头；光标在管线或 padding 时选择其左侧单元格。
  const current = row < 0 && line.from === delimiter.from ? 0 : row
  if (current < 0 || state.doc.lineAt(selection.from).number !== state.doc.lineAt(selection.to).number) return unsupported()
  const cells = row < 0 ? delimiter.cells : rows[current].cells
  let column = cells.findIndex(c => selection.head <= c.end)
  if (column < 0) column = cells.length - 1
  if (!selection.empty && (selection.from < cells[column].start || selection.to > cells[column].end)) return unsupported()
  return { from: rows[0].from, to: node.to, rows, delimiter, row: current, column }
}

function alignment(state: EditorState, cell: Cell): Alignment {
  const text = state.sliceDoc(cell.from, cell.to)
  return text.startsWith(':') ? text.endsWith(':') ? 'center' : 'left' : text.endsWith(':') ? 'right' : 'none'
}

export function tableContext(state: EditorState): TableContext | undefined {
  const table = locate(state)
  if (!table || 'error' in table) return
  const { from, to, row, column, rows, delimiter } = table
  const cell = rows[row].cells[column]
  return { from, to, row, column, rowCount: rows.length, columnCount: delimiter.cells.length, alignment: alignment(state, delimiter.cells[column]), cell: { from: cell.from, to: cell.to } }
}

export function tableAlignments(state: EditorState, from: number): Alignment[] | undefined {
  if (!Number.isInteger(from) || from < 0 || from > state.doc.length) return
  const line = state.doc.lineAt(from)
  const position = Math.max(from, line.from + line.text.match(/^ */)![0].length)
  const table = locate(state, position)
  if (!table || 'error' in table || line.from !== table.from) return
  return table.delimiter.cells.map(cell => alignment(state, cell))
}

export function tableSourceRows(state: EditorState, from: number): { from: number; to: number; text: string }[][] | undefined {
  if (!Number.isInteger(from) || from < 0 || from > state.doc.length) return
  const line = state.doc.lineAt(from), table = locate(state, Math.max(from, line.from + line.text.match(/^ */)![0].length))
  if (!table || 'error' in table || line.from !== table.from) return
  return table.rows.map(row => row.cells.map(cell => ({ from: cell.from, to: cell.to, text: state.sliceDoc(cell.from, cell.to) })))
}

function transaction(state: EditorState, edits: { from: number; to?: number; insert?: string }[], cell: { from: number; to: number }, inserted?: { at: number; offset: number; length?: number }): TransactionSpec {
  const changes = ChangeSet.of(edits, state.doc.length)
  const anchor = inserted ? changes.mapPos(inserted.at, -1) + inserted.offset : changes.mapPos(cell.from, 1)
  const head = inserted ? anchor + (inserted.length ?? 0) : changes.mapPos(cell.to, 1)
  return { changes, selection: { anchor, head }, userEvent: 'input.table', annotations: isolateHistory.of('full'), scrollIntoView: true }
}

function addRow(state: EditorState, table: Table, after: number): TransactionSpec | Failure {
  const count = table.delimiter.cells.length
  if ((table.rows.length + 1) * count > 500) return unsupported()
  const previous = after === 0 ? table.delimiter : table.rows[after]
  const text = previous.indent + '| ' + Array.from({ length: count }, () => ' |').join(' ')
  if (table.to - table.from + text.length + 1 > 20000) return unsupported()
  const afterNewline = previous.to < state.doc.length
  const at = previous.to + (afterNewline ? 1 : 0)
  return transaction(state, [{ from: at, insert: afterNewline ? text + '\n' : '\n' + text }], table.rows[table.row].cells[table.column], { at, offset: previous.indent.length + (afterNewline ? 2 : 3) })
}

export function tableTransaction(state: EditorState, action: TableAction): TransactionSpec | Failure {
  if (state.readOnly) return readonly()
  const table = locate(state, undefined, true)
  if (!table) return { error: '光标不在可操作的表格内。' }
  if ('error' in table) return table
  const { rows, delimiter, row, column } = table, cell = rows[row].cells[column]
  if (action === 'insertRowBefore' || action === 'insertRowAfter') {
    if (action === 'insertRowBefore' && row === 0) return { error: '不能在表头之前插入正文行，请在表头之后插入。' }
    return addRow(state, table, action === 'insertRowAfter' ? row : row - 1)
  }
  if (action === 'deleteRow') {
    if (row === 0) return { error: '不能删除表头，请使用源码编辑。' }
    const target = rows[row + 1] ?? rows[row - 1]
    const ownNewline = rows[row].to < state.doc.length
    return transaction(state, [{ from: ownNewline ? rows[row].from : rows[row].from - 1, to: rows[row].to + (ownNewline ? 1 : 0) }], target.cells[column])
  }
  if (action === 'alignLeft' || action === 'alignCenter' || action === 'alignRight') {
    const token = delimiter.cells[column], text = state.sliceDoc(token.from, token.to)
    const left = action !== 'alignRight', right = action !== 'alignLeft'
    const edits: { from: number; to?: number; insert?: string }[] = []
    if (text.startsWith(':') !== left) edits.push(left ? { from: token.from, insert: ':' } : { from: token.from, to: token.from + 1 })
    if (text.endsWith(':') !== right) edits.push(right ? { from: token.to, insert: ':' } : { from: token.to - 1, to: token.to })
    return transaction(state, edits, cell)
  }
  if (action === 'deleteColumn') {
    if (delimiter.cells.length === 1) return { error: '不能删除最后一列，请使用源码编辑。' }
    const edits = [rows[0], delimiter, ...rows.slice(1)].flatMap(r => {
      const c = r.cells[column], next = r.cells[column + 1]
      // 无外管线的两列表删为一列时保留原分隔管线，否则不再是 Markdown 表格。
      if (r.cells.length === 2 && !r.right) {
        if (!next) return [{ from: c.start, to: c.end }]
        const deletion = { from: c.start, to: next.start - (r.left ? 0 : 1) }
        // Lezer 的单列分隔行必须有末管线，仅有首管线不足以识别。
        return r === delimiter ? [deletion, { from: r.to, to: r.to, insert: '|' }] : [deletion]
      }
      return [next ? { from: c.start, to: next.start } : { from: c.start - 1, to: c.end }]
    })
    return transaction(state, edits, rows[row].cells[column + 1] ?? rows[row].cells[column - 1])
  }
  if (action !== 'insertColumnBefore' && action !== 'insertColumnAfter') return { error: '不支持的表格操作。' }
  if (rows.length * (delimiter.cells.length + 1) > 500) return unsupported()
  const before = action === 'insertColumnBefore'
  if (!before && rows.some(r => {
    const c = r.cells[column]
    let backslashes = 0
    for (let p = c.end - 1; p >= c.start && state.sliceDoc(p, p + 1) === '\\'; p--) backslashes++
    return backslashes % 2 !== 0
  })) return unsupported()
  const edits = [rows[0], delimiter, ...rows.slice(1)].map(r => {
    const c = r.cells[column], content = r === delimiter ? ' --- ' : r === rows[0] ? ' 新列 ' : '  '
    return { from: before ? c.start : c.end, insert: before ? (column === 0 && !r.left ? '|' : '') + content + '|' : '|' + content + (column === r.cells.length - 1 && !r.right ? '|' : '') }
  })
  if (table.to - table.from + edits.reduce((sum, e) => sum + e.insert.length, 0) > 20000) return unsupported()
  return transaction(state, edits, cell, { at: before ? cell.start : cell.end, offset: before ? column === 0 && !rows[row].left ? 2 : 1 : 2, length: row === 0 ? 2 : 0 })
}

export function insertTableTransaction(state: EditorState, bodyRows: number, columns: number): TransactionSpec | Failure {
  if (state.readOnly) return readonly()
  if (!Number.isInteger(bodyRows) || bodyRows < 1 || bodyRows > 20 || !Number.isInteger(columns) || columns < 1 || columns > 20) return { error: '表格正文行数和列数必须是 1 到 20 的整数。' }
  if (state.selection.ranges.length !== 1) return { error: '请只保留一个光标或选区，再插入表格。' }
  const selection = state.selection.main, position = selection.to
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, position + 1), 30)
  if (!tree) return unsupported()
  const protectedNodes = ['FencedCode', 'CodeBlock', 'HTMLBlock', 'Blockquote', 'ListItem', 'Table', 'InlineCode', 'Link', 'Image']
  let blocked = false
  tree.iterate({ from: selection.from, to: selection.to, enter(node) {
    if (protectedNodes.includes(node.name) && (selection.empty ? node.from < position && position < node.to : node.from < selection.to && node.to > selection.from)) { blocked = true; return false }
  } })
  if (blocked) return { error: '请在代码、HTML、引用、列表、链接和已有表格之外插入新表格，复杂选区请使用源码编辑。' }
  const header = '| ' + Array.from({ length: columns }, (_, i) => `列 ${i + 1}`).join(' | ') + ' |'
  const delimiter = '| ' + Array.from({ length: columns }, () => '---').join(' | ') + ' |'
  const body = '| ' + Array.from({ length: columns }, () => ' ').join(' | ') + ' |'
  const before = state.sliceDoc(Math.max(0, position - 2), position), after = state.sliceDoc(position, Math.min(state.doc.length, position + 2))
  const prefix = position === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const suffix = position === state.doc.length || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const insert = prefix + [header, delimiter, ...Array.from({ length: bodyRows }, () => body)].join('\n') + suffix
  return transaction(state, [{ from: position, insert }], { from: position, to: position }, { at: position, offset: prefix.length + 2, length: 3 })
}

export function tableNavigation(state: EditorState, backward: boolean): TransactionSpec | { boundary: true } | undefined | Failure {
  const table = locate(state, undefined, true)
  if (!table || 'error' in table) return table
  if (state.readOnly) return readonly()
  const { row, column, rows, delimiter } = table, count = delimiter.cells.length
  const index = row * count + column + (backward ? -1 : 1)
  if (index < 0) return { boundary: true }
  if (index >= rows.length * count) return addRow(state, table, rows.length - 1)
  return transaction(state, [], rows[Math.floor(index / count)].cells[index % count])
}
