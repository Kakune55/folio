import { api } from '../services/api'
import { WorkspaceSessions } from './workspace'
export const workspace = new WorkspaceSessions([], api.write)
