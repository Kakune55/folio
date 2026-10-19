import { dropIndicatorState } from '@milkdown/kit/plugin/cursor'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { createDropIndicatorPlugin } from 'prosemirror-drop-indicator'

// 0.1.4 的拖放指示器销毁后仍可能执行 30ms 隐藏回调。
// 为本实例增加生命周期约束，避免切换模式后写入已移除的 Milkdown 上下文。
export const safeDropIndicator = $prose(ctx => {
  let disposed = false
  const indicator = createDropIndicatorPlugin({
    onShow: options => { if (!disposed) ctx.set(dropIndicatorState.key, options) },
    onHide: () => { if (!disposed) ctx.set(dropIndicatorState.key, null) },
    onDrag: () => true,
  })
  return new Plugin({ ...indicator.spec, view: view => {
    const instance = indicator.spec.view?.(view)
    return { ...instance, destroy: () => { disposed = true; instance?.destroy?.() } }
  } })
})
