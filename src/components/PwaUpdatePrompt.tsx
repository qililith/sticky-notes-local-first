import { useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft } from '../data/saveGuard'

function canReload(): boolean {
  if (hasPendingEditorWrites()) { toast.error('本地仍在保存，请稍等再更新'); return false }
  if (hasUnresolvedEditorDraft()) { toast.error('便签有未保存草稿，请先另存或复制草稿文本'); return false }
  return true
}

export function PwaUpdatePrompt() {
  const [workerActivated, setWorkerActivated] = useState(false)
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onNeedReload() {
      // Activation is asynchronous and may have been requested in another tab.
      // Recheck here, not just at the original button click.
      setWorkerActivated(true)
      if (canReload()) window.location.reload()
    }
  })
  if (!needRefresh && !workerActivated) return null

  return <div className="pwa-update-prompt" role="status">
    <span>新版本已就绪。更新前请确认便签显示“本地已保存”。</span>
    <button type="button" onClick={() => {
      if (!canReload()) return
      // A previous activation was deferred for a draft. There is no waiting
      // worker left to message, so explicit retry must reload this tab itself.
      if (workerActivated) { window.location.reload(); return }
      void updateServiceWorker(true).catch(() => toast.error('更新未完成，请保持当前页面并稍后重试'))
    }}>更新并刷新</button>
  </div>
}
