import { useEffect, useRef } from 'react'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { useAction } from '../lib/useAction'
import { useUnibox } from '../state'
import { RefreshIcon } from './Icons'
import { InlineError } from './InlineError'

/**
 * The bar above the list: pick everything, see how much is loaded, pull new
 * mail. What to *do* with the picked rows lives above the reading pane.
 */
export function ListHeader(): React.JSX.Element {
  const { threads, hasMore, selectedThreadIds, selectAll, selectThread, refresh } = useUnibox()
  const box = useRef<HTMLInputElement>(null)
  const count = selectedThreadIds.length
  const all = threads.length > 0 && count === threads.length
  // One row is always "selected" while it is being read, so only a real
  // multi-selection short of everything reads as partial.
  const partial = count > 1 && !all
  const sync = useAction(async () => {
    await api.invoke('sync:now')
    await refresh()
  })

  useEffect(() => {
    if (box.current) box.current.indeterminate = partial
  }, [partial])

  const range =
    threads.length === 1
      ? t('list.rangeOne')
      : t(hasMore ? 'list.rangeMore' : 'list.range', { count: threads.length })

  return (
    <div className="list-header">
      <label className="list-header__check" data-tip={t('list.selectAll')}>
        <input
          ref={box}
          type="checkbox"
          className="checkbox"
          aria-label={t('list.selectAll')}
          checked={all}
          disabled={threads.length === 0}
          onChange={() => (all ? selectThread(null) : selectAll())}
        />
      </label>
      {/* Announced only when it says something new: how many are picked. */}
      <span className="list-header__count" role={count > 1 ? 'status' : undefined}>
        {count > 1 ? t('toolbar.selected', { count }) : threads.length > 0 ? range : ''}
      </span>
      <InlineError message={sync.error} />
      <button
        type="button"
        className="icon-button"
        data-tip={t('toolbar.refresh')}
        aria-label={t('toolbar.refresh')}
        aria-busy={sync.busy}
        disabled={sync.busy}
        onClick={() => void sync.run()}
      >
        <RefreshIcon />
      </button>
    </div>
  )
}
