import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { DialogContent } from '../../components/ui/dialog-content'
import { Button } from '../../components/ui/button'
import { useAppearance } from '../../stores/appearance'

export function AppearanceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { width, fontSize, comfortScroll, update, reset, storageError } = useAppearance()
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <DialogContent className="dialog-content appearance-dialog" aria-describedby={undefined}>
      <Dialog.Title>个性化</Dialog.Title>
      <fieldset><legend>Markdown 正文宽度</legend>
        <div className="appearance-options">{([[800, '窄'], [1200, '中'], [1600, '宽']] as const).map(([value, label]) => <label key={value}>
          <input type="radio" name="editor-width" value={value} checked={width === value} onChange={() => update({ width: value })} />
          <span>{label}<small>{value} px</small></span>
        </label>)}</div>
      </fieldset>
      <fieldset><legend>编辑器字号</legend>
        <div className="appearance-options">{([[14, '小'], [16, '标准'], [18, '大']] as const).map(([value, label]) => <label key={value}>
          <input type="radio" name="editor-font" value={value} checked={fontSize === value} onChange={() => update({ fontSize: value })} />
          <span>{label}<small>{value} px</small></span>
        </label>)}</div>
      </fieldset>
      <fieldset><legend>输入时滚动</legend>
        <div className="appearance-options">{([['3/4', '3/4 处', '舒适区'], ['2/3', '2/3 处', '更靠上'], ['off', '默认', '到底部才滚动']] as const).map(([value, label, hint]) => <label key={value}>
          <input type="radio" name="editor-comfort-scroll" checked={comfortScroll === value} onChange={() => update({ comfortScroll: value })} />
          <span>{label}<small>{hint}</small></span>
        </label>)}</div>
      </fieldset>
      {storageError && <p className="form-error" role="alert">{storageError}</p>}
      <div className="appearance-footer"><Button variant="outline" onClick={reset}>恢复默认</Button><Dialog.Close asChild><Button variant="outline">完成</Button></Dialog.Close></div>
      <Dialog.Close asChild><Button className="dialog-close" size="icon" aria-label="关闭个性化"><X size={16} /></Button></Dialog.Close>
    </DialogContent>
  </Dialog.Portal></Dialog.Root>
}
