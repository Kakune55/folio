import type { SearchTarget, SearchLocated } from '../features/search/location'
import { lazy } from 'react'
import type { Session, WorkspaceSessions } from '../sessions/workspace'
import type { EditorBridge } from './bridge'
const SourceEditor = lazy(() => import('./codemirror/SourceEditor'))
const AttachmentViewer = lazy(() => import('../viewers/AttachmentViewer'))

export function DocumentEditor({ session, sessions, onBlocked, bridge, searchTarget, onSearchLocated, navigationOpen }: { navigationOpen?: boolean; session: Session; sessions: WorkspaceSessions; onBlocked: (message: string) => void; bridge?: EditorBridge; searchTarget?: SearchTarget; onSearchLocated?: SearchLocated }) {
  if (session.metadata && ['image', 'pdf', 'binary'].includes(session.viewer)) return <AttachmentViewer metadata={session.metadata} />
  return <SourceEditor navigationOpen={navigationOpen} session={session} sessions={sessions} onBlocked={onBlocked} bridge={bridge} searchTarget={searchTarget} onSearchLocated={onSearchLocated} />
}
