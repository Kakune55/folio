import type { SearchTarget, SearchLocated } from '../features/search/location'
import { lazy } from 'react'
import type { Session, WorkspaceSessions } from '../sessions/workspace'
import type { CrepeBridge } from './milkdown/bridge'
const RichEditor = lazy(() => import('./milkdown/RichEditor'))
const SourceEditor = lazy(() => import('./codemirror/SourceEditor'))
const AttachmentViewer = lazy(() => import('../viewers/AttachmentViewer'))

export function DocumentEditor({ session, sessions, onBlocked, bridge, searchTarget, onSearchLocated, navigationOpen }: { navigationOpen?: boolean; session: Session; sessions: WorkspaceSessions; onBlocked: (message: string) => void; bridge?: CrepeBridge; searchTarget?: SearchTarget; onSearchLocated?: SearchLocated }) {
  if (session.metadata && ['image', 'pdf', 'binary'].includes(session.viewer)) return <AttachmentViewer metadata={session.metadata} />
  if (session.viewer === 'markdown' && session.mode === 'rich') return <RichEditor navigationOpen={navigationOpen} session={session} sessions={sessions} onBlocked={onBlocked} bridge={bridge} searchTarget={searchTarget} onSearchLocated={onSearchLocated} />
  return <SourceEditor navigationOpen={navigationOpen} session={session} sessions={sessions} onBlocked={onBlocked} bridge={bridge} searchTarget={searchTarget} onSearchLocated={onSearchLocated} />
}
