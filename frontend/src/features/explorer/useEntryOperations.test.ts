import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'
import type { ReactNode, ReactElement } from 'react'
import { api, ApiError } from '../../services/api'
import type { Entry } from '../../services/api'
import type { Session } from '../../sessions/workspace'
import { workspace } from '../../sessions/current'
import { useEntryOperations } from './useEntryOperations'

// 只执行 hook 和返回元素上的事件，不挂载 Radix，也不依赖浏览器 DOM。
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
const invalidate = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value }]
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = { current: initial }
    return hooks.values[index]
  },
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: invalidate }) }))
vi.mock('../../services/api', async (original) => ({
  ...await original<typeof import('../../services/api')>(),
  api: {
    entryRevision: vi.fn(async (path: string) => ({ path, kind: 'file', revision: 'v1' })),
    move: vi.fn(async () => {}), trash: vi.fn(async () => {}),
    metadata: vi.fn(async () => ({ viewer: 'text' })), read: vi.fn(),
  },
}))
vi.mock('../../sessions/current', () => ({ workspace: {
  flush: vi.fn(async () => true), canRemap: vi.fn(() => true), list: vi.fn(() => []),
  lockTree: vi.fn(() => []), remap: vi.fn(), remove: vi.fn(), unlock: vi.fn(),
  setMetadata: vi.fn(), acceptRemote: vi.fn(), operationFailed: vi.fn(),
} }))

const entry = (path: string, kind: Entry['kind'] = 'file'): Entry => ({ path, name: path.split('/').at(-1)!, kind, size: 0 })
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function harness(uploading = false) {
  const props = { onRemap: vi.fn(), onDelete: vi.fn(), onNotice: vi.fn(), uploading }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 状态已替换为上方的定向测试容器。
  const render = () => { hooks.cursor = 0; return useEntryOperations(props) }
  const find = (predicate: (element: ReactElement<Record<string, unknown>>) => boolean) => elements(render().dialogs).find(predicate)!
  const submit = () => (find((element) => element.type === 'form').props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} })
  const target = (value: string) => (find((element) => element.type === 'input').props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
  const text = () => JSON.stringify(render().dialogs)
  return { props, render, find, submit, target, text }
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0
  vi.clearAllMocks()
  vi.mocked(api.entryRevision).mockImplementation(async (path) => ({ path, kind: 'file', revision: 'v1' }))
  vi.mocked(api.move).mockResolvedValue(undefined as never)
  vi.mocked(api.trash).mockResolvedValue(undefined as never)
  vi.mocked(workspace.canRemap).mockReturnValue(true)
  vi.mocked(workspace.list).mockReturnValue([])
  vi.mocked(workspace.lockTree).mockReturnValue([])
  vi.mocked(workspace.flush).mockResolvedValue(true)
  invalidate.mockResolvedValue(undefined)
})

describe('文件操作固定集合与单项兼容', () => {
  it('复制选择与条目，目录去重后只删除一次；取消不触碰草稿', async () => {
    vi.mocked(api.entryRevision).mockImplementation(async path => ({ path, kind: path === '目录' ? 'directory' : 'file', revision: 'v1' }))
    const h = harness()
    const selection = [entry('目录/子.md'), entry('目录', 'directory'), entry('目录', 'directory'), entry('另一个.md')]
    h.render().showDelete(selection)
    selection[1].path = '被改动'; selection.pop()
    expect(h.text()).toContain('共 2 项')
    expect(h.text()).toContain('另一个.md')
    expect(h.text()).not.toContain('目录/子.md')
    await h.submit()
    expect(vi.mocked(api.trash).mock.calls).toEqual([['目录', 'v1'], ['另一个.md', 'v1']])
    expect(h.props.onDelete.mock.calls).toEqual([['目录'], ['另一个.md']])
    expect(h.props.onNotice).toHaveBeenCalledTimes(1)
    h.render().showDelete(entry('未删除.md'))
    const cancel = h.find((element) => element.props.children === '取消')
    ;(cancel.props.onClick as () => void)()
    expect(h.render().dialogOpen).toBe(false)
    expect(workspace.remove).not.toHaveBeenCalled()
  })

  it('单项保持完整目标路径，拖动和重命名仍接收 Entry', async () => {
    const h = harness()
    h.render().showMove(entry('旧/a.md'))
    expect(h.find((element) => element.type === 'input').props).toMatchObject({ value: '旧/a.md', required: true })
    h.target('新/改名.txt'); await h.submit()
    expect(api.move).toHaveBeenLastCalledWith('旧/a.md', '新/改名.txt', 'v1')
    await h.render().moveToDirectory(entry('旧/b.md'), '')
    expect(api.move).toHaveBeenLastCalledWith('旧/b.md', 'b.md', 'v1')
    await h.render().rename(entry('旧/c.md'), '新名.md')
    expect(api.move).toHaveBeenLastCalledWith('旧/c.md', '旧/新名.md', 'v1')
  })

  it('批量输入目录或空根目录，通知汇总一次，逐项保持重映射回调', async () => {
    const h = harness()
    h.render().showMove([entry('旧/a.md'), entry('旧/b.md')])
    expect(h.find((element) => element.type === 'input').props.required).toBe(false)
    h.target('新'); await h.submit()
    expect(vi.mocked(api.move).mock.calls).toEqual([['旧/a.md', '新/a.md', 'v1'], ['旧/b.md', '新/b.md', 'v1']])
    expect(h.props.onRemap.mock.calls).toEqual([['旧/a.md', '新/a.md'], ['旧/b.md', '新/b.md']])
    expect(h.props.onNotice).toHaveBeenCalledTimes(1)
    h.render().showMove([entry('旧/c.md'), entry('旧/d.md')]); await h.submit()
    expect(api.move).toHaveBeenLastCalledWith('旧/d.md', 'd.md', 'v1')
  })
})

describe('批量预检与失败保护', () => {
  it.each(['move', 'delete'] as const)('确认后条目类型变化时不操作替换对象并阻止重试：%s', async type => {
    vi.mocked(api.entryRevision).mockImplementation(async path => ({ path, kind: path === 'b.md' ? 'directory' : 'file', revision: 'v1' }))
    const h = harness()
    if (type === 'move') { h.render().showMove([entry('a.md'), entry('b.md')]); h.target('目标') }
    else h.render().showDelete([entry('a.md'), entry('b.md')])
    await h.submit()
    const request = type === 'move' ? vi.mocked(api.move) : vi.mocked(api.trash)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['a.md'])
    expect(h.text()).toContain('类型已变化')
    expect(h.text()).toContain('已完成 1/2 项')
    expect(h.find(element => element.props.type === 'submit').props.disabled).toBe(true)
    await h.submit()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { entries: [entry('甲/a.md'), entry('乙/a.md')], target: '目标', message: '同名目标' },
    { entries: [entry('目录', 'directory'), entry('b.md')], target: '目录/子目录', message: '移入自身' },
    { entries: [entry('旧/a.md'), entry('旧/b.md')], target: '../越界', message: '相对目标路径' },
    { entries: [entry('旧/a.md'), entry('旧/b.md')], target: '旧', message: '原路径' },
  ])('已知无效目标在任何写入前拒绝：$message', async ({ entries, target, message }) => {
    const h = harness(); h.render().showMove(entries); h.target(target); await h.submit()
    expect(h.text()).toContain(message)
    expect(api.move).not.toHaveBeenCalled(); expect(workspace.lockTree).not.toHaveBeenCalled()
  })

  it('后续条目的既有编辑会话冲突也在首次写入前拒绝', async () => {
    vi.mocked(workspace.canRemap).mockImplementation((_from, to) => to !== '目标/b.md')
    const h = harness(); h.render().showMove([entry('a.md'), entry('b.md')]); h.target('目标'); await h.submit()
    expect(api.move).not.toHaveBeenCalled(); expect(h.text()).toContain('已有编辑会话')
  })

  it('源目录没有打开的会话时也不能覆盖目标目录下的既有会话', async () => {
    vi.mocked(workspace.list).mockReturnValue([{ path: '目标/目录/打开.md' } as Session])
    const h = harness(); h.render().showMove([entry('目录', 'directory'), entry('b.md')]); h.target('目标'); await h.submit()
    expect(api.move).not.toHaveBeenCalled(); expect(h.text()).toContain('已有编辑会话')
  })

  it('确定失败立即停止；再次提交仅执行剩余项并报告累计完成数', async () => {
    vi.mocked(api.trash).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new ApiError(409, 'conflict', '不能删除'))
    const h = harness(); h.render().showDelete([entry('a.md'), entry('b.md'), entry('c.md')]); await h.submit()
    expect(vi.mocked(api.trash).mock.calls.map(([path]) => path)).toEqual(['a.md', 'b.md'])
    expect(h.text()).toContain('已完成 1/3 项')
    const remaining = h.find((element) => element.type === 'ul')
    expect(JSON.stringify(remaining)).not.toContain('a.md')
    await h.submit()
    expect(vi.mocked(api.trash).mock.calls.map(([path]) => path)).toEqual(['a.md', 'b.md', 'b.md', 'c.md'])
    expect(h.props.onNotice).toHaveBeenLastCalledWith(expect.stringContaining('已完成 3 项'))
  })

  it.each([new TypeError('网络中断'), new ApiError(503, 'unavailable', '服务不可用'), new ApiError(409, 'durability_uncertain', '落盘结果未知')])('结果未知禁止本轮再次提交：$message', async (problem) => {
    vi.mocked(api.trash).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(problem)
    const h = harness(); h.render().showDelete([entry('a.md'), entry('b.md'), entry('c.md')]); await h.submit()
    expect(h.text()).toContain('已完成 1/3 项'); expect(h.text()).toContain('刷新并核对')
    expect(h.find((element) => element.props.type === 'submit').props.disabled).toBe(true)
    await h.submit()
    expect(api.trash).toHaveBeenCalledTimes(2)
    expect(workspace.operationFailed).toHaveBeenCalledWith([], problem.message, false)
  })

  it('列表刷新失败不把已确认成功项当作剩余项重试', async () => {
    invalidate.mockRejectedValue(new Error('刷新失败'))
    const h = harness(); h.render().showDelete([entry('a.md'), entry('b.md')]); await h.submit()
    expect(h.render().dialogOpen).toBe(false)
    expect(api.trash).toHaveBeenCalledTimes(2)
    expect(h.props.onNotice).toHaveBeenLastCalledWith(expect.stringContaining('列表刷新失败'))
  })

  it('busy 时目标输入、替换选择、取消和重复提交都不可更改本轮操作', async () => {
    let finish!: () => void
    vi.mocked(api.move).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(undefined as never) }))
    const h = harness(); h.render().showMove([entry('a.md'), entry('b.md')]); h.target('目标')
    const pending = h.submit()
    await vi.waitFor(() => expect(api.move).toHaveBeenCalledTimes(1))
    h.target('被改动'); h.render().showDelete(entry('被替换.md'))
    ;(h.find((element) => element.props.children === '取消').props.onClick as () => void)()
    await h.submit()
    expect(h.render().dialogOpen).toBe(true)
    expect(h.find((element) => element.type === 'input').props).toMatchObject({ value: '目标', disabled: true })
    finish(); await pending
    expect(api.move).toHaveBeenLastCalledWith('b.md', '目标/b.md', 'v1')
    expect(api.trash).not.toHaveBeenCalled()
  })

  it('逐项仍先锁定、flush 与检查 ETag；冲突不发变更且释放锁', async () => {
    const session = { path: '目录/a.md', revision: '旧版本', viewer: 'text' } as Session
    vi.mocked(workspace.lockTree).mockReturnValue([session])
    const h = harness(); h.render().showDelete([entry('目录', 'directory'), entry('b.md')]); await h.submit()
    expect(workspace.flush).toHaveBeenCalledWith('目录/a.md', true)
    expect(api.trash).not.toHaveBeenCalled()
    expect(workspace.operationFailed).toHaveBeenCalledWith([session], expect.stringContaining('外部修改'), true)
    expect(workspace.unlock).toHaveBeenCalledWith([session], ['目录'])
    expect(h.text()).toContain('剩余 2 项')
  })

  it('保存或上传保护失败保留原集合，不发任何变更', async () => {
    const h = harness(true); h.render().showDelete([entry('a.md'), entry('b.md')]); await h.submit()
    expect(api.trash).not.toHaveBeenCalled(); expect(h.text()).toContain('附件正在上传')
    h.props.uploading = false
    vi.mocked(workspace.lockTree).mockReturnValue([{ path: 'a.md' } as Session])
    vi.mocked(workspace.flush).mockResolvedValue(false)
    await h.submit()
    expect(api.trash).not.toHaveBeenCalled(); expect(h.text()).toContain('保留原路径和草稿')
    expect(workspace.unlock).toHaveBeenCalled()
  })

  it('移动后仍刷新会话类型；刷新失败包含在最终汇总中', async () => {
    const session = { path: 'a.md', viewer: 'binary' } as Session
    vi.mocked(workspace.lockTree).mockReturnValue([session])
    vi.mocked(api.metadata).mockRejectedValueOnce(new Error('类型刷新失败'))
    const h = harness(); h.render().showMove(entry('a.md')); h.target('a.txt'); await h.submit()
    expect(api.metadata).toHaveBeenCalledWith('a.md')
    expect(h.props.onNotice).toHaveBeenLastCalledWith(expect.stringContaining('文件类型刷新失败'))
    expect(h.render().dialogOpen).toBe(false)
  })
})
