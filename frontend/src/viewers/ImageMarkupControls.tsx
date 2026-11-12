import { ArrowUpRight, Eraser, Hand, Highlighter, Minus, PenLine, RectangleHorizontal, Redo2, Trash2, Undo2 } from 'lucide-react'
import { Button } from '../components/ui/button'
import type { Annotation } from './image-annotations'
import type { ImageSize } from './image-transform'
import type { ImageTool, useImageMarkup } from './useImageMarkup'

type Markup = ReturnType<typeof useImageMarkup>
const tools = [
  ['pan', '移动图片', Hand], ['pen', '普通笔', PenLine], ['highlighter', '荧光笔', Highlighter],
  ['line', '直线', Minus], ['arrow', '箭头', ArrowUpRight], ['rectangle', '矩形', RectangleHorizontal], ['eraser', '橡皮擦（整笔）', Eraser],
] as const

export function ImageMarkupControls({ markup, disabled, toolsRef }: { markup: Markup; disabled: boolean; toolsRef: React.RefObject<HTMLDivElement | null> }) {
  const paint = markup.tool !== 'pan' && markup.tool !== 'eraser'
  return <>
    <div className="image-markup-tools" role="group" aria-label="图片标注工具" ref={toolsRef}>
      {tools.map(([tool, label, Icon]) => <Button key={tool} size="icon" aria-label={label} title={label} aria-pressed={markup.tool === tool} disabled={disabled && tool !== 'pan'} onClick={() => markup.selectTool(tool as ImageTool)}><Icon size={18} /></Button>)}
    </div>
    {(markup.tool !== 'pan' || markup.annotations.length > 0 || markup.canRedo) && <div className="image-markup-properties" role="group" aria-label="标注设置">
      {paint && <><input type="color" value={markup.color} aria-label="画笔颜色" title="画笔颜色" disabled={disabled} onChange={event => markup.setColor(event.target.value)} /><select aria-label="笔宽（原图像素）" value={markup.width} disabled={disabled} onChange={event => markup.setWidth(Number(event.target.value))}>{[2, 4, 6, 12, 24, 48].map(width => <option key={width} value={width}>{width} px</option>)}</select></>}
      <Button size="icon" aria-label="撤销标注" title="撤销标注（Ctrl／⌘ Z）" disabled={!markup.canUndo} onClick={markup.undo}><Undo2 size={17} /></Button>
      <Button size="icon" aria-label="重做标注" title="重做标注（Ctrl／⌘ Shift Z）" disabled={!markup.canRedo} onClick={markup.redo}><Redo2 size={17} /></Button>
      <Button aria-label="清空标注" title="清空临时标注，可撤销" disabled={!markup.annotations.length} onClick={markup.clear}><Trash2 size={15} />清空</Button>
    </div>}
  </>
}

export function ImageAnnotationLayer({ size, marks, draft }: { size: ImageSize; marks: Annotation[]; draft?: Annotation }) {
  return <svg className="image-annotation-layer" width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true" data-mark-count={marks.length}>
    {[...marks, ...(draft ? [draft] : [])].map(mark => <path key={mark.id} data-mark-id={mark.id} data-tool={mark.tool} d={mark.path} fill="none" stroke={mark.color} strokeWidth={mark.width} strokeLinecap="round" strokeLinejoin="round" opacity={mark.tool === 'highlighter' ? 0.28 : 1} />)}
  </svg>
}
