import { describe, expect, it } from 'vitest'
import { lineDiff } from './line-diff'
describe('行差异', () => {
  it('分离远距离修改并保留双侧行号', () => {
    const middle = Array.from({ length: 20 }, (_, i) => `相同行${i}\n`).join('')
    const result = lineDiff(`旧首\n${middle}旧尾`, `新首\n${middle}新尾`)
    expect(result.deleted).toBe(2)
    expect(result.inserted).toBe(2)
    expect(result.rows).toContain(null)
    expect(result.rows.find(r => r?.text === '新尾')).toMatchObject({ after: 22, kind: 'insert' })
  })
  it('应用增删后精确还原换行和特殊正文', () => {
    for (const [a, b] of [['', '新增\r\n'], ['旧', ''], ['甲\r\n乙\r', '甲\n乙'], ['<script>\n尾', '<img>\n尾']]) {
      const result = lineDiff(a, b)
      expect(result.rows.filter(r => r && r.kind !== 'delete').map(r => r!.text).join('')).toBe(b)
    }
    expect(lineDiff('', '').deleted).toBe(0)
  })
  it('大范围修改受计算预算约束', () => {
    const result = lineDiff('甲\n'.repeat(1000), '乙\n'.repeat(1000))
    expect(result.limited).toBe(true)
    expect(result.deleted).toBe(1000)
    expect(result.inserted).toBe(1000)
  })
})
