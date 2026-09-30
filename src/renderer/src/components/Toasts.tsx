import { t } from '../i18n'
import { useNow } from '../hooks/useNow'
import { api } from '../lib/bridge'
import { formatFullDate } from '../lib/format'
import { useUnibox } from '../state'

/** Shows the undo affordance for as long as a message is still cancellable. */
export function Toasts(): React.JSX.Element | null {
  const {
    outbox,
    reloadOutbox,
    error,
    setError,
    settleNotices,
    undoSettle,
    dismissSettleNotice,
    compose,
    aiJobs,
    dismissAi,
    openAiJob
  } = useUnibox()
  const now = useNow()

  const undoable = outbox.filter((item) => item.state === 'undoable' && item.sendAt > now)
  const scheduled = outbox.filter((item) => item.state === 'scheduled')
  const settled = settleNotices.filter((notice) => notice.expiresAt > now)
  // While the compose window is open the result belongs in it, not out here.
  const jobs = compose ? [] : aiJobs

  if (
    undoable.length === 0 &&
    scheduled.length === 0 &&
    settled.length === 0 &&
    jobs.length === 0 &&
    !error
  ) {
    return null
  }

  return (
    <div className="toast-stack">
      {jobs.map((job) => (
        <div key={job.id} className="toast toast--ai" role="status">
          <span className="toast__body">
            <span>
              {job.state === 'running'
                ? t('ai.toastRunning')
                : job.state === 'error'
                  ? t('ai.toastFailed')
                  : t('ai.toastReady')}
            </span>
            {job.state === 'error' && job.error ? (
              <span className="toast__reason">{job.error}</span>
            ) : job.instruction ? (
              <span className="toast__reason">{job.instruction}</span>
            ) : null}
          </span>
          {job.state === 'done' ? (
            <button type="button" onClick={() => void openAiJob(job.id)}>
              {t('ai.toastOpen')}
            </button>
          ) : null}
          {job.state === 'running' ? null : (
            <button type="button" onClick={() => dismissAi(job.id)}>
              {t('settings.close')}
            </button>
          )}
        </div>
      ))}
      {settled.map((notice) => (
        <div key={notice.id} className="toast toast--settle" role="status">
          <span className="toast__body">
            <span>
              {notice.target
                ? t('settle.noticeMoved', { subject: notice.subject, target: notice.target })
                : t('settle.noticeKept', { subject: notice.subject })}
            </span>
            {notice.reason ? <span className="toast__reason">{notice.reason}</span> : null}
          </span>
          {notice.decision ? (
            <button type="button" onClick={() => void undoSettle(notice.id)}>
              {t('undo.undo')}
            </button>
          ) : (
            <button type="button" onClick={() => dismissSettleNotice(notice.id)}>
              {t('settings.close')}
            </button>
          )}
        </div>
      ))}
      {error ? (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            {t('settings.close')}
          </button>
        </div>
      ) : null}
      {undoable.map((item) => (
        <div key={item.id} className="toast" role="status">
          <span>
            {t('undo.sending')} ({Math.max(0, Math.ceil((item.sendAt - now) / 1000))})
          </span>
          <button
            type="button"
            onClick={() =>
              void api.invoke('compose:cancel', item.id).then(() => {
                void reloadOutbox()
              })
            }
          >
            {t('undo.undo')}
          </button>
        </div>
      ))}
      {scheduled.map((item) => (
        <div key={item.id} className="toast" role="status">
          <span>{t('undo.scheduled', { time: formatFullDate(item.sendAt) })}</span>
          <button
            type="button"
            onClick={() =>
              void api.invoke('compose:cancel', item.id).then(() => {
                void reloadOutbox()
              })
            }
          >
            {t('undo.undo')}
          </button>
        </div>
      ))}
    </div>
  )
}
