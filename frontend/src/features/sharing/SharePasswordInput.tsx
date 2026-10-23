import { useEffect, useRef, useState } from 'react'

// 一个原生输入框承接输入、粘贴和选区，六个格子只负责展示。
export function SharePasswordInput({ value, onChange, disabled, invalid }: {
 value: string; onChange: (value: string) => void; disabled: boolean; invalid: boolean
}) {
 const input = useRef<HTMLInputElement>(null)
 const [focused, setFocused] = useState(false)
 const [selection, setSelection] = useState({ start: 0, end: 0 })
 useEffect(() => {
  if (invalid && !disabled) {input.current?.focus();input.current?.select()}
 }, [invalid, disabled])
 return <div className="share-password-code" data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
  <div className="share-password-cells" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} className={`share-password-cell${focused && (selection.start === selection.end ? index === Math.min(selection.start, 5) : index >= selection.start && index < selection.end) ? ' active' : ''}`}>{value[index] ?? ''}</span>)}</div>
  <input ref={input} id="access-password" className="share-password-native" type="text" autoComplete="off" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required disabled={disabled} value={value} aria-invalid={invalid || undefined} aria-describedby={invalid ? 'share-access-error' : undefined}
   onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
   onSelect={event => setSelection({start: event.currentTarget.selectionStart ?? 0, end: event.currentTarget.selectionEnd ?? 0})}
   onPointerDown={event => {
    if (disabled) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = Math.min(value.length, Math.max(0, Math.floor((event.clientX - bounds.left) / (bounds.width / 6))))
    input.current?.focus();input.current?.setSelectionRange(position, position)
    setSelection({start: position, end: position})
   }}
   onChange={event => onChange(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} />
 </div>
}
