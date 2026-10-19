import { useMemo } from 'react'
import { displayLine, lineDiff } from './line-diff'

export function DiffView({ original, modified, beforeLabel, afterLabel, label }: {
  original: string; modified: string; beforeLabel: string; afterLabel: string; label: string
}) {
  const diff = useMemo(() => lineDiff(original, modified), [original, modified])
  return <div className="diff-view">
    <div className="diff-legend"><span className="diff-delete">− {beforeLabel} · 删除 {diff.deleted} 行</span><span className="diff-insert">+ {afterLabel} · 新增 {diff.inserted} 行</span></div>
    {diff.rows.length > 2000 && <p>差异超过 2000 行，仅展示前 2000 行；完整内容请查看上方正文或下载原文。</p>}
    {diff.limited && <p>修改范围较大，以下按完整替换区间展示，可能包含未变化的行。请结合上方完整正文核对。</p>}
    <p className="diff-help">左右行号分别对应{beforeLabel}与{afterLabel}；LF / CRLF / CR 表示换行，EOF 表示末行无换行。</p>
    <div className="diff-scroll" role="region" aria-label={label} tabIndex={0}>
      {!diff.deleted && !diff.inserted ? <div className="diff-empty">无差异</div> : diff.rows.slice(0, 2000).map((row, index) => row ? <div className={`diff-line diff-${row.kind}`} key={index}>
        <span className="diff-number" aria-hidden="true">{row.before}</span><span className="diff-number" aria-hidden="true">{row.after}</span><code>{row.kind === 'delete' ? '- ' : row.kind === 'insert' ? '+ ' : '  '}{displayLine(row.text)}</code>
      </div> : <div className="diff-gap" key={index}>⋯ 未变化的行已折叠 ⋯</div>)}
    </div>
  </div>
}
