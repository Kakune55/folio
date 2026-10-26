import { Link } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import type { Principal } from '../../services/api'

export function SettingsHeader({ principal, page }: { principal: Principal; page: 'user' | 'system' | 'api' }) {
  return <header className="settings-header">
    <Link to="/" className="settings-back"><ArrowLeft size={17} />返回工作区</Link>
    <div className="settings-header-links">
      {page !== 'user' ? <Link to={page === 'api' ? '/user-setting?tab=applications' : '/user-setting'}>用户设置</Link> : principal.admin && <Link to="/system-setting">系统设置</Link>}
      <span>{principal.username}</span>
    </div>
  </header>
}
