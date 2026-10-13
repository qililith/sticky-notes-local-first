import { ArrowLeft, ChevronRight, Cloud, LayoutGrid, List, Moon, Sun } from 'lucide-react'

type Props = {
  theme: string
  syncStatus: string
  hasSyncIssue: boolean
  onThemeChange: (theme: 'light' | 'dark') => void
  onOpenSync: () => void
  onClose: () => void
  listStyle: 'cards' | 'compact'
  onListStyleChange: (style: 'cards' | 'compact') => void
}

export function SettingsPanel({ theme, syncStatus, hasSyncIssue, onThemeChange, onOpenSync, onClose, listStyle, onListStyleChange }: Props) {
  return <section className="settings-page" aria-label="设置">
    <header className="settings-heading"><button type="button" aria-label="返回便签" onClick={onClose}><ArrowLeft size={22} /></button><h2>设置</h2></header>
    <button type="button" className="settings-sync" onClick={onOpenSync}>
      <Cloud size={23} /><span><strong>云同步</strong><small className={hasSyncIssue ? 'has-issue' : ''}>{syncStatus}</small></span><ChevronRight size={20} />
    </button>
    <fieldset className="settings-theme"><legend>显示模式</legend>
      <label><input type="radio" name="display-theme" value="light" checked={theme !== 'dark'} onChange={() => onThemeChange('light')} /><Sun size={21} /><span>白天模式</span></label>
      <label><input type="radio" name="display-theme" value="dark" checked={theme === 'dark'} onChange={() => onThemeChange('dark')} /><Moon size={21} /><span>暗夜模式</span></label>
    </fieldset>
    <fieldset className="settings-theme"><legend>便签展示</legend>
      <label><input type="radio" name="note-list-style" checked={listStyle === 'cards'} onChange={() => onListStyleChange('cards')} /><LayoutGrid size={21} /><span>卡片视图</span></label>
      <label><input type="radio" name="note-list-style" checked={listStyle === 'compact'} onChange={() => onListStyleChange('compact')} /><List size={21} /><span>列表视图</span></label>
    </fieldset>
  </section>
}
