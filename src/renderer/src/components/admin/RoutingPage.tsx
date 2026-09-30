import { useState } from 'react'
import type {
  RoutingRule,
  RuleAction,
  RuleInput,
  RuleMatchField,
  RuleOperator,
  RuleTestResult
} from '@shared/admin'
import { RULE_ACTIONS, RULE_MATCH_FIELDS, RULE_OPERATORS } from '@shared/admin'
import type { Account, LabelWithCounts } from '@shared/types'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { formatFullDate } from '../../lib/format'
import { useAction } from '../../lib/useAction'
import { useUnibox } from '../../state'
import { InlineError } from '../InlineError'
import { DeleteIcon, EditIcon, RouteIcon } from './icons'
import {
  AddButton,
  Card,
  Chip,
  Dialog,
  MoveButtons,
  PageHeader,
  Switch,
  moved,
  useLoaded
} from './ui'

/** The regex check the main process does too — here it answers while typing. */
function regexError(operator: RuleOperator, value: string): string | null {
  if (operator !== 'regex' || !value) return null
  try {
    new RegExp(value, 'i')
    return null
  } catch (cause) {
    return t('admin.routing.regexInvalid', {
      message: cause instanceof Error ? cause.message : String(cause)
    })
  }
}

function actionText(
  action: RuleAction,
  arg: string | null,
  labels: Record<string, LabelWithCounts[]>
): string {
  if (action === 'label') {
    const label = Object.values(labels)
      .flat()
      .find((entry) => entry.id === arg)
    return t('admin.routing.sentence.label', { label: label?.name ?? arg ?? '' })
  }
  if (action === 'forward') return t('admin.routing.sentence.forward', { address: arg ?? '' })
  return t(`admin.routing.actions.${action}`)
}

/** "Wenn Absender enthält «rechnung» → Label «Buchhaltung»". */
export function ruleSentence(
  rule: Pick<RoutingRule, 'matchField' | 'operator' | 'value' | 'action' | 'actionArg'>,
  labels: Record<string, LabelWithCounts[]>
): string {
  return t('admin.routing.sentence.rule', {
    field: t(`admin.routing.fields.${rule.matchField}`),
    operator: t(`admin.routing.operators.${rule.operator}`),
    value: rule.value,
    action: actionText(rule.action, rule.actionArg, labels)
  })
}

function TestResult({ result }: { result: RuleTestResult }): React.JSX.Element {
  if (result.error) return <InlineError message={result.error} />
  return (
    <div className="admin-test" role="status">
      <strong>
        {t('admin.routing.testSummary', {
          count: result.matches.length,
          scanned: result.scanned
        })}
      </strong>
      {result.matches.length > 0 ? (
        <ul className="admin-test__list">
          {result.matches.slice(0, 10).map((match) => (
            <li key={match.messageId}>
              <span className="admin-test__subject">
                {match.subject || t('queue.noSubject')}
              </span>
              <span className="admin-muted">
                {match.from} · {formatFullDate(match.date)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function RuleDialog({
  rule,
  accounts,
  onClose,
  onSaved
}: {
  rule: RoutingRule | null
  accounts: Account[]
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { labels } = useUnibox()
  const [name, setName] = useState(rule?.name ?? '')
  const [accountId, setAccountId] = useState<string | null>(rule?.accountId ?? null)
  const [matchField, setMatchField] = useState<RuleMatchField>(rule?.matchField ?? 'from')
  const [operator, setOperator] = useState<RuleOperator>(rule?.operator ?? 'contains')
  const [value, setValue] = useState(rule?.value ?? '')
  const [action, setAction] = useState<RuleAction>(rule?.action ?? 'label')
  const [actionArg, setActionArg] = useState(rule?.actionArg ?? '')
  const [stopProcessing, setStopProcessing] = useState(rule?.stopProcessing ?? true)
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [result, setResult] = useState<RuleTestResult | null>(null)
  const invalid = regexError(operator, value)

  // Labels of the chosen domain; for a rule on every domain, those of all of
  // them — the main process finds or makes the same-named label per domain.
  const labelChoices = accounts
    .filter((account) => accountId === null || account.id === accountId)
    .flatMap((account) =>
      (labels[account.id] ?? [])
        .filter((label) => label.type === 'user')
        .map((label) => ({ label, domain: account.email }))
    )

  const test = useAction(async () => {
    setResult(await api.invoke('rules:test', { accountId, matchField, operator, value }))
  })

  const save = useAction(async () => {
    const input: RuleInput = {
      accountId,
      name: name.trim() || value.trim(),
      enabled,
      matchField,
      operator,
      value,
      action,
      actionArg: action === 'label' || action === 'forward' ? actionArg.trim() || null : null,
      stopProcessing
    }
    if (rule) await api.invoke('rules:update', rule.id, input)
    else await api.invoke('rules:create', input)
    onSaved()
  })

  const title = rule ? t('admin.routing.editTitle') : t('admin.routing.createTitle')
  return (
    <Dialog
      title={title}
      description={t('admin.routing.dialogDescription')}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="button-secondary admin-dialog__left"
            aria-busy={test.busy}
            disabled={test.busy || !value.trim() || invalid !== null}
            onClick={() => void test.run()}
          >
            {t('admin.routing.test')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('admin.common.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            aria-busy={save.busy}
            disabled={save.busy || !value.trim() || invalid !== null}
            onClick={() => void save.run()}
          >
            {rule ? t('admin.common.save') : t('admin.routing.create')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="rule-name">{t('admin.routing.name')}</label>
        <input
          id="rule-name"
          value={name}
          placeholder={t('admin.routing.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="rule-domain">{t('admin.routing.domain')}</label>
        <select
          id="rule-domain"
          value={accountId ?? ''}
          onChange={(event) => {
            setAccountId(event.target.value || null)
            setResult(null)
          }}
        >
          <option value="">{t('admin.routing.allDomains')}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.email}
            </option>
          ))}
        </select>
      </div>
      <div className="admin-field-row">
        <div className="field">
          <label htmlFor="rule-field">{t('admin.routing.field')}</label>
          <select
            id="rule-field"
            value={matchField}
            onChange={(event) => {
              setMatchField(event.target.value as RuleMatchField)
              setResult(null)
            }}
          >
            {RULE_MATCH_FIELDS.map((field) => (
              <option key={field} value={field}>
                {t(`admin.routing.fields.${field}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-operator">{t('admin.routing.operator')}</label>
          <select
            id="rule-operator"
            value={operator}
            onChange={(event) => {
              setOperator(event.target.value as RuleOperator)
              setResult(null)
            }}
          >
            {RULE_OPERATORS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`admin.routing.operators.${entry}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="rule-value">{t('admin.routing.value')}</label>
        <input
          id="rule-value"
          className={operator === 'regex' ? 'admin-mono' : undefined}
          value={value}
          aria-invalid={invalid !== null}
          onChange={(event) => {
            setValue(event.target.value)
            setResult(null)
          }}
        />
        {invalid ? <InlineError message={invalid} /> : null}
      </div>
      <div className="admin-field-row">
        <div className="field">
          <label htmlFor="rule-action">{t('admin.routing.action')}</label>
          <select
            id="rule-action"
            value={action}
            onChange={(event) => {
              setAction(event.target.value as RuleAction)
              setActionArg('')
            }}
          >
            {RULE_ACTIONS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`admin.routing.actions.${entry}`)}
              </option>
            ))}
          </select>
        </div>
        {action === 'label' ? (
          <div className="field">
            <label htmlFor="rule-arg">{t('admin.routing.label')}</label>
            <select
              id="rule-arg"
              value={actionArg}
              onChange={(event) => setActionArg(event.target.value)}
            >
              <option value="">{t('admin.routing.pickLabel')}</option>
              {labelChoices.map(({ label, domain }) => (
                <option key={label.id} value={label.id}>
                  {accountId ? label.name : `${label.name} (${domain})`}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {action === 'forward' ? (
          <div className="field">
            <label htmlFor="rule-arg">{t('admin.routing.forwardTo')}</label>
            <input
              id="rule-arg"
              type="email"
              value={actionArg}
              placeholder={t('admin.routing.forwardPlaceholder')}
              onChange={(event) => setActionArg(event.target.value)}
            />
          </div>
        ) : null}
      </div>
      {action === 'label' && labelChoices.length === 0 ? (
        <span className="admin-muted">{t('admin.routing.noLabels')}</span>
      ) : null}
      <div className="admin-toggle-row">
        <span>
          <strong>{t('admin.routing.stop')}</strong>
          <span className="admin-muted">{t('admin.routing.stopHint')}</span>
        </span>
        <Switch
          on={stopProcessing}
          label={t('admin.routing.stop')}
          onToggle={() => setStopProcessing(!stopProcessing)}
        />
      </div>
      <div className="admin-toggle-row">
        <span>
          <strong>{t('admin.routing.enabled')}</strong>
        </span>
        <Switch on={enabled} label={t('admin.routing.enabled')} onToggle={() => setEnabled(!enabled)} />
      </div>
      <InlineError message={save.error ?? test.error} />
      {result ? <TestResult result={result} /> : null}
    </Dialog>
  )
}

function RuleRow({
  rule,
  first,
  last,
  busy,
  accounts,
  onMove,
  onToggle,
  onEdit,
  onRemove
}: {
  rule: RoutingRule
  first: boolean
  last: boolean
  busy: boolean
  accounts: Account[]
  onMove: (delta: -1 | 1) => void
  onToggle: () => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { labels } = useUnibox()
  const domain = accounts.find((account) => account.id === rule.accountId)?.email
  return (
    <li className={rule.enabled ? 'admin-row' : 'admin-row admin-row--off'}>
      <span className="admin-row__icon">
        <RouteIcon size={18} />
      </span>
      <span className="admin-row__main">
        <span className="admin-row__title">
          {rule.name}
          <Chip tone="info" icon={false}>
            {domain ?? t('admin.routing.allDomains')}
          </Chip>
        </span>
        <span className="admin-row__sub">{ruleSentence(rule, labels)}</span>
        <span className="admin-row__meta">
          {t('admin.routing.meta', {
            priority: rule.priority,
            count: rule.matchCount,
            last: rule.lastMatchedAt ? formatFullDate(rule.lastMatchedAt) : t('admin.routing.never')
          })}
          {rule.stopProcessing ? '' : ` · ${t('admin.routing.continues')}`}
        </span>
      </span>
      <Switch on={rule.enabled} label={t('admin.routing.enableName', { name: rule.name })} busy={busy} onToggle={onToggle} />
      <MoveButtons name={rule.name} first={first} last={last} disabled={busy} onMove={onMove} />
      <button
        type="button"
        className="icon-button admin-icon-button"
        aria-label={t('admin.common.editName', { name: rule.name })}
        onClick={onEdit}
      >
        <EditIcon size={15} />
      </button>
      <button
        type="button"
        className="icon-button admin-icon-button admin-icon-button--danger"
        aria-label={t('admin.common.deleteName', { name: rule.name })}
        disabled={busy}
        onClick={onRemove}
      >
        <DeleteIcon size={15} />
      </button>
    </li>
  )
}

export function RoutingPage(): React.JSX.Element {
  const { accounts } = useUnibox()
  const rules = useLoaded(() => api.invoke('rules:list'))
  const [dialog, setDialog] = useState<{ rule: RoutingRule | null } | null>(null)
  const resendAccounts = accounts.filter((account) => account.kind === 'resend')
  const list = rules.data ?? []

  const reorder = useAction(async (index: number, delta: -1 | 1) => {
    const next = moved(list, index, delta)
    rules.setData(next)
    rules.setData(await api.invoke('rules:reorder', next.map((rule) => rule.id)))
  })
  const toggle = useAction(async (rule: RoutingRule) => {
    await api.invoke('rules:update', rule.id, { enabled: !rule.enabled })
    rules.reload()
  })
  const remove = useAction(async (rule: RoutingRule) => {
    if (!window.confirm(t('admin.routing.confirmRemove', { name: rule.name }))) return
    await api.invoke('rules:remove', rule.id)
    rules.reload()
  })
  const busy = reorder.busy || toggle.busy || remove.busy

  return (
    <>
      <PageHeader
        title={t('admin.nav.routing')}
        description={t('admin.routing.description')}
        action={
          <AddButton
            label={t('admin.routing.add')}
            disabled={resendAccounts.length === 0}
            onClick={() => setDialog({ rule: null })}
          />
        }
      />
      <Card title={t('admin.routing.howTitle')}>
        <ol className="admin-steps">
          <li>{t('admin.routing.how1')}</li>
          <li>{t('admin.routing.how2')}</li>
          <li>{t('admin.routing.how3')}</li>
        </ol>
      </Card>
      <InlineError message={rules.error ?? reorder.error ?? toggle.error ?? remove.error} />
      <Card title={t('admin.routing.listTitle')}>
        {list.length === 0 ? (
          <p className="admin-empty">
            {resendAccounts.length === 0 ? t('admin.routing.noDomains') : t('admin.routing.empty')}
          </p>
        ) : (
          <ul className="admin-list">
            {list.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                first={index === 0}
                last={index === list.length - 1}
                busy={busy}
                accounts={resendAccounts}
                onMove={(delta) => void reorder.run(index, delta)}
                onToggle={() => void toggle.run(rule)}
                onEdit={() => setDialog({ rule })}
                onRemove={() => void remove.run(rule)}
              />
            ))}
          </ul>
        )}
      </Card>
      {dialog ? (
        <RuleDialog
          rule={dialog.rule}
          accounts={resendAccounts}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            rules.reload()
          }}
        />
      ) : null}
    </>
  )
}
