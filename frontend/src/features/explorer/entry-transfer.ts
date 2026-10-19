import type { Entry } from '../../services/api'
export const entryMime = 'application/x-folio-entry'
let active: { entry: Entry; token: string } | undefined
export function beginEntryTransfer(entry: Entry, transfer: DataTransfer) {
  const token = crypto.randomUUID()
  active = { entry, token }
  transfer.effectAllowed = 'copyMove'
  transfer.setData(entryMime, token)
  return token
}
export function endEntryTransfer() { active = undefined }
export function hasEntryTransfer(transfer: DataTransfer | null) {
  return !!active && !!transfer?.types.includes(entryMime) && !transfer.types.includes('Files')
}
export function readEntryTransfer(transfer: DataTransfer | null) {
  return transfer && hasEntryTransfer(transfer) && transfer.getData(entryMime) === active?.token ? active?.entry : undefined
}
