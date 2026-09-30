import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  SettleActionKind,
  SettleDecision,
  SettleProgress,
  SettleReport,
  SettleSuggestion
} from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { formatListDate } from '../lib/format'
import { useAction } from '../lib/useAction'
import { useUnibox } from '../state'
import { CloseIcon, LabelIcon, SettleIcon, SpamIcon, TrashIcon } from './Icons'
import { InlineError } from './InlineError'

/** Which mail a run looks at. */
type Scope = 'selection' | 'inbox'

/** A row as the user has it: the suggestion plus their edits to it. */
interface Row {
  suggestion: SettleSuggestion
  action: SettleActionKind
  labelName: string | null
  labelId: string | null
  /** Whether the row is included when Apply runs. */
  checked: boolean
}

function toRow(suggestion: SettleSuggestion): Row {
  return {
    suggestion,
    action: suggestion.action,
    labelName: suggestion.labelName,
    labelId: suggestion.labelId,
    // A `keep` proposal has nothing to apply, so it starts unchecked.
    checked: suggestion.action !== 'keep'
  }
}

function ActionIcon({ action }: { action: SettleActionKind }): React.JSX.Element | null {
  if (action === 'trash') return <TrashIcon size={13} color="var(--danger)" />
  if (action === 'spam') return <SpamIcon size={13} color="var(--danger)" />
  if (action === 'label') return <LabelIcon size={13} color="var(--accent)" />
  return null
}

function actionText(row: Row): string {
  if (row.action === 'trash') return t('settle.actionTrash')
  if (row.action === 'spam') return t('settle.actionSpam')
  if (row.action === 'keep') return t('settle.actionKeep')
  return row.labelName ?? ''
}

/**
 * The review step between Claude's proposal and the mailbox. Nothing here
 * moves a mail on its own: `settle:analyze` only reads, and `settle:apply`
 * receives exactly the rows the user left checked.
 */
export function SettleSheet(): React.JSX.Element {
  const { accounts, labels, openSettle, refresh, selectedThreadIds } = useUnibox()
  const [report, setReport] = useState<SettleReport | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [progress, setProgress] = useState<SettleProgress | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // What was selected when the sheet opened. Frozen, so applying a row — which
  // takes it out of the list — cannot change what a re-run would look at.
  const [targets] = useState(() => selectedThreadIds)
  // Whatever the user had picked is the cheaper run, so it goes first; the
  // whole inbox is one click away.
  const [scope, setScope] = useState<Scope>(targets.length > 0 ? 'selection' : 'inbox')

  const analyze = useAction(async (next: Scope) => {
    setDone(null)
    const result = await api.invoke('settle:analyze', next === 'selection' ? targets : null)
    setReport(result)
    setRows(result.suggestions.map(toRow))
  })

  const runAnalyze = analyze.run
  useEffect(() => {
    void runAnalyze(scope)
  }, [runAnalyze, scope])

  useEffect(() => api.on('settle:progress', setProgress), [])

  const accountName = useCallback(
    (accountId: string) => accounts.find((account) => account.id === accountId)?.email ?? '',
    [accounts]
  )

  const update = (threadId: string, patch: Partial<Row>): void => {
    setRows((current) =>
      current.map((row) => (row.suggestion.threadId === threadId ? { ...row, ...patch } : row))
    )
  }

  /** Every label the account already has, for the override dropdown. */
  const optionsFor = (accountId: string): string[] =>
    (labels[accountId] ?? []).filter((label) => label.type === 'user').map((label) => label.name)

  const selected = useMemo(() => rows.filter((row) => row.checked && row.action !== 'keep'), [rows])

  const apply = useAction(async () => {
    const decisions: SettleDecision[] = selected.map((row) => ({
      threadId: row.suggestion.threadId,
      action: row.action,
      labelName: row.labelName,
      labelId: row.labelId,
      archive: row.action !== 'keep'
    }))
    const result = await api.invoke('settle:apply', decisions)
    await refresh()
    if (result.failed.length > 0) {
      throw new Error(t('settle.applyFailed', { count: result.failed.length }))
    }
    setRows((current) =>
      current.filter((row) => !decisions.some((d) => d.threadId === row.suggestion.threadId))
    )
    setDone(t('settle.applied', { count: result.applied }))
  })

  const busy = analyze.busy || apply.busy
  const total = progress?.total ?? 0

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('settle.title')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) openSettle(false)
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) openSettle(false)
      }}
    >
      <div className="window settle">
        <div className="window__titlebar">
          <span className="window__title">{t('settle.title')}</span>
          <button
            type="button"
            className="window__close"
            aria-label={t('settle.close')}
            disabled={busy}
            onClick={() => openSettle(false)}
          >
            <CloseIcon />
          </button>
        </div>

        {targets.length > 0 ? (
          <div className="settle__scope" role="group" aria-label={t('settle.scope')}>
            <button
              type="button"
              className={`settle__scope-tab${scope === 'selection' ? ' settle__scope-tab--active' : ''}`}
              aria-pressed={scope === 'selection'}
              disabled={busy}
              onClick={() => setScope('selection')}
            >
              {t('settle.scopeSelection', { count: targets.length })}
            </button>
            <button
              type="button"
              className={`settle__scope-tab${scope === 'inbox' ? ' settle__scope-tab--active' : ''}`}
              aria-pressed={scope === 'inbox'}
              disabled={busy}
              onClick={() => setScope('inbox')}
            >
              {t('settle.scopeInbox')}
            </button>
          </div>
        ) : null}

        <div className="settle__body">
          {analyze.busy ? (
            <div className="settle__empty" role="status">
              <SettleIcon size={22} color="var(--accent)" />
              <p>
                {total > 0
                  ? t('settle.analyzingCount', { processed: progress?.processed ?? 0, total })
                  : t('settle.analyzing')}
              </p>
            </div>
          ) : null}

          {!analyze.busy && rows.length === 0 ? (
            <div className="settle__empty" role="status">
              <p>{done ?? t('settle.nothingToDo')}</p>
            </div>
          ) : null}

          {!analyze.busy && rows.length > 0 ? (
            <ul className="settle__list">
              {rows.map((row) => {
                const { suggestion } = row
                const options = optionsFor(suggestion.accountId)
                const isNew =
                  row.action === 'label' &&
                  row.labelName !== null &&
                  !options.includes(row.labelName)
                return (
                  <li
                    key={suggestion.threadId}
                    className={`settle__row${row.checked ? '' : ' settle__row--off'}`}
                  >
                    <input
                      type="checkbox"
                      className="settle__check"
                      checked={row.checked}
                      aria-label={t('settle.include')}
                      disabled={apply.busy}
                      onChange={(event) =>
                        update(suggestion.threadId, { checked: event.target.checked })
                      }
                    />
                    <div className="settle__mail">
                      <div className="settle__mailhead">
                        <span className="settle__from">
                          {suggestion.from.name ?? suggestion.from.email}
                        </span>
                        <span className="settle__account">{accountName(suggestion.accountId)}</span>
                        <span className="settle__date">
                          {formatListDate(suggestion.lastMessageAt)}
                        </span>
                      </div>
                      <div className="settle__subject">{suggestion.subject}</div>
                      <div className="settle__reason">{suggestion.reason}</div>
                    </div>
                    <div className="settle__target">
                      <span className={`settle__chip settle__chip--${row.action}`}>
                        <ActionIcon action={row.action} />
                        <span>{actionText(row)}</span>
                        {isNew ? <em className="settle__new">{t('settle.newLabel')}</em> : null}
                      </span>
                      <select
                        className="settle__select"
                        aria-label={t('settle.override')}
                        disabled={apply.busy}
                        value={row.action === 'label' ? `label:${row.labelName ?? ''}` : row.action}
                        onChange={(event) => {
                          const value = event.target.value
                          if (value.startsWith('label:')) {
                            const name = value.slice('label:'.length)
                            const match = (labels[suggestion.accountId] ?? []).find(
                              (label) => label.name === name
                            )
                            update(suggestion.threadId, {
                              action: 'label',
                              labelName: name,
                              labelId: match?.id ?? null,
                              checked: true
                            })
                            return
                          }
                          update(suggestion.threadId, {
                            action: value as SettleActionKind,
                            labelName: null,
                            labelId: null,
                            checked: value !== 'keep'
                          })
                        }}
                      >
                        {row.action === 'label' &&
                        row.labelName &&
                        !options.includes(row.labelName) ? (
                          <option value={`label:${row.labelName}`}>
                            {`${row.labelName} (${t('settle.newLabel')})`}
                          </option>
                        ) : null}
                        {options.map((name) => (
                          <option key={name} value={`label:${name}`}>
                            {name}
                          </option>
                        ))}
                        <option value="keep">{t('settle.actionKeep')}</option>
                        <option value="trash">{t('settle.actionTrash')}</option>
                        <option value="spam">{t('settle.actionSpam')}</option>
                      </select>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>

        <div className="settle__footer">
          <div className="settle__status">
            <InlineError message={analyze.error ?? apply.error ?? report?.warning ?? null} />
            {!analyze.error && !apply.error && report && !analyze.busy ? (
              <span className="settle__hint">
                {t('settle.summary', { scanned: report.scanned, skipped: report.skipped })}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => openSettle(false)}
          >
            {t('settle.close')}
          </button>
          <button
            type="button"
            className="button-primary"
            aria-busy={apply.busy}
            disabled={busy || selected.length === 0}
            onClick={() => void apply.run()}
          >
            <span>{t('settle.apply', { count: selected.length })}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
