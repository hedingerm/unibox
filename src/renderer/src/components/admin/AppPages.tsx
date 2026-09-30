import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AttachmentCacheInfo } from '@shared/ipc'
import { FOLLOW_UP_DAY_CHOICES } from '@shared/followup'
import type {
  Account,
  Identity,
  RemoteImageTrust,
  SettleAvailability,
  Signature,
  Template,
  ThemePreference
} from '@shared/types'
import { AUTO_VARIABLES } from '@shared/template-vars'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { formatBytes, formatFullDate } from '../../lib/format'
import { sanitizeMessageHtml } from '../../lib/sanitize'
import { useAction } from '../../lib/useAction'
import { useUnibox } from '../../state'
import { InlineError } from '../InlineError'
import { AddButton, Card, PageHeader, Switch } from './ui'

/*
 * The pages that used to be the tabs of the settings window: app behaviour,
 * accounts, sending identities with their signatures, templates and
 * notifications. The content is unchanged; only the frame is the Verwaltung's.
 */

function AttachmentCache(): React.JSX.Element {
  const [info, setInfo] = useState<AttachmentCacheInfo | null>(null)
  const clear = useAction(async () => {
    setInfo(await api.invoke('attachments:clearCache'))
  })

  // Measuring means stat-ing every cached file, so it happens when the tab is
  // opened rather than on every refresh of the app state.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const measured = await Promise.resolve()
        .then(() => api.invoke('attachments:cacheInfo'))
        .catch(() => null)
      if (!cancelled) setInfo(measured)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <span className="settings__section-title">{t('settings.storage.attachments')}</span>
      <div className="settings__row-group">
        <div className="settings__row">
          <span className="settings__row-label">
            {info
              ? t('settings.storage.cacheSize', {
                  size: formatBytes(info.bytes),
                  count: info.files
                })
              : t('settings.storage.cacheUnknown')}
            <br />
            <span className="settings__row-sub">{t('settings.storage.cacheHint')}</span>
          </span>
          <button
            type="button"
            className="button-secondary"
            aria-busy={clear.busy}
            disabled={clear.busy || !info || info.reclaimableFiles === 0}
            onClick={() => void clear.run()}
          >
            {t('settings.storage.clearCache')}
          </button>
        </div>
        <InlineError message={clear.error} />
      </div>
    </>
  )
}

/**
 * The senders whose images the user waved through by hand. Everything the
 * correspondence history allows on its own stays out of the list — it would be
 * most of the address book, and there is nothing here to undo.
 */
function RemoteImageTrustList(): React.JSX.Element {
  const [entries, setEntries] = useState<RemoteImageTrust[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await Promise.resolve()
        .then(() => api.invoke('remoteImages:list'))
        .catch(() => [])
      if (!cancelled) setEntries(list)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const revoke = useAction(async (entry: RemoteImageTrust) => {
    await api.invoke('remoteImages:revoke', entry.kind, entry.value)
    setEntries(await api.invoke('remoteImages:list'))
  })

  return (
    <>
      <span className="settings__section-title">{t('settings.remoteImages.title')}</span>
      <div className="settings__row-group">
        <span className="settings__row-sub">{t('settings.remoteImages.hint')}</span>
        {entries.length === 0 ? (
          <span className="settings__row-sub">{t('settings.remoteImages.empty')}</span>
        ) : (
          entries.map((entry) => (
            <div className="settings__row" key={`${entry.kind}:${entry.value}`}>
              <span className="settings__row-label">
                {entry.kind === 'domain' ? `@${entry.value}` : entry.value}
                <br />
                <span className="settings__row-sub">
                  {t('settings.remoteImages.addedOn', { date: formatFullDate(entry.createdAt) })}
                </span>
              </span>
              <button
                type="button"
                className="button-secondary"
                disabled={revoke.busy}
                onClick={() => void revoke.run(entry)}
              >
                {t('settings.remoteImages.revoke')}
              </button>
            </div>
          ))
        )}
        <InlineError message={revoke.error} />
      </div>
    </>
  )
}

/** Save-as copy of the database, wherever the user points the dialog. */
export function DatabaseBackup(): React.JSX.Element {
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const backup = useAction(async () => {
    setSavedTo(await api.invoke('db:backup'))
  })

  return (
    <>
      <span className="settings__section-title">{t('settings.storage.backup')}</span>
      <div className="settings__row-group">
        <div className="settings__row">
          <span className="settings__row-label">
            {t('settings.storage.backupTitle')}
            <br />
            <span className="settings__row-sub">{t('settings.storage.backupHint')}</span>
          </span>
          <button
            type="button"
            className="button-secondary"
            aria-busy={backup.busy}
            disabled={backup.busy}
            onClick={() => void backup.run()}
          >
            {t('settings.storage.backupAction')}
          </button>
        </div>
        {savedTo ? (
          <span className="settings__row-sub">
            {t('settings.storage.backupDone', { path: savedTo })}
          </span>
        ) : null}
        <InlineError message={backup.error} />
      </div>
    </>
  )
}

/** Which model writes mail, and in whose voice. */
function AiSection(): React.JSX.Element {
  const { settings, saveSettings } = useUnibox()

  return (
    <>
      <span className="settings__section-title">{t('settings.ai.title')}</span>
      <div className="settings__row-group">
        <div className="settings__row">
          <span className="settings__row-label">{t('settings.ai.model')}</span>
          <select
            aria-label={t('settings.ai.model')}
            value={settings.aiModel}
            onChange={(event) => void saveSettings({ aiModel: event.target.value })}
          >
            <option value="haiku">{t('settings.ai.modelHaiku')}</option>
            <option value="sonnet">{t('settings.ai.modelSonnet')}</option>
            <option value="opus">{t('settings.ai.modelOpus')}</option>
          </select>
        </div>
        <div className="settings__row settings__row--stacked">
          <span className="settings__row-label">
            {t('settings.ai.style')}
            <br />
            <span className="settings__row-sub">{t('settings.ai.styleHint')}</span>
          </span>
          <textarea
            className="settings__textarea"
            aria-label={t('settings.ai.style')}
            rows={10}
            defaultValue={settings.aiStylePrompt}
            key={settings.aiStylePrompt}
            onBlur={(event) => void saveSettings({ aiStylePrompt: event.target.value })}
          />
        </div>
      </div>
    </>
  )
}

/** Which model settles the inbox, and where the CLI that runs it lives. */
function SettleSection(): React.JSX.Element {
  const { settings, saveSettings } = useUnibox()
  const [availability, setAvailability] = useState<SettleAvailability | null>(null)

  const check = useCallback(async () => {
    setAvailability(await api.invoke('settle:available').catch(() => null))
  }, [])

  // Resolving the CLI touches the file system, so it runs once per opened tab.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const resolved = await api.invoke('settle:available').catch(() => null)
      if (!cancelled) setAvailability(resolved)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <span className="settings__section-title">{t('settings.settle.title')}</span>
      <div className="settings__row-group">
        <div className="settings__row">
          <span className="settings__row-label">{t('settings.settle.model')}</span>
          <select
            aria-label={t('settings.settle.model')}
            value={settings.settleModel}
            onChange={(event) => void saveSettings({ settleModel: event.target.value })}
          >
            <option value="haiku">{t('settings.settle.modelHaiku')}</option>
            <option value="sonnet">{t('settings.settle.modelSonnet')}</option>
            <option value="opus">{t('settings.settle.modelOpus')}</option>
          </select>
        </div>
        <div className="settings__row">
          <span className="settings__row-label">
            {t('settings.settle.binary')}
            <br />
            <span className="settings__row-sub">
              {availability?.binaryPath ?? t('settings.settle.notFound')}
            </span>
          </span>
          <input
            type="text"
            aria-label={t('settings.settle.binary')}
            placeholder={t('settings.settle.autoDetect')}
            defaultValue={settings.claudePath ?? ''}
            onBlur={(event) => {
              const value = event.target.value.trim()
              void saveSettings({ claudePath: value === '' ? null : value }).then(check)
            }}
          />
        </div>
      </div>
    </>
  )
}

/**
 * The two knobs behind "Wartet auf Antwort": whether the composer arms a
 * reminder by itself, and how long it waits. Both are only the starting point
 * — every mail can still say otherwise in the composer.
 */
function FollowUpSection(): React.JSX.Element {
  const { settings, saveSettings } = useUnibox()
  return (
    <>
      <span className="settings__section-title">{t('followup.title')}</span>
      <div className="settings__row-group">
        <div className="settings__row">
          <span className="settings__row-label">
            {t('settings.followUp.enabled')}
            <br />
            <span className="settings__row-sub">{t('followup.hint')}</span>
          </span>
          <input
            type="checkbox"
            aria-label={t('settings.followUp.enabled')}
            checked={settings.followUpEnabled}
            onChange={(event) => void saveSettings({ followUpEnabled: event.target.checked })}
          />
        </div>
        <div className="settings__row">
          <span className="settings__row-label">{t('settings.followUp.days')}</span>
          <select
            aria-label={t('settings.followUp.days')}
            value={settings.followUpDays}
            onChange={(event) => void saveSettings({ followUpDays: Number(event.target.value) })}
          >
            {FOLLOW_UP_DAY_CHOICES.map((days) => (
              <option key={days} value={days}>
                {days === 1
                  ? t('followup.oneWorkingDay')
                  : t('followup.workingDays', { count: days })}
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  )
}

const THEMES: Array<[ThemePreference, string]> = [
  ['system', 'settings.general.themeSystem'],
  ['light', 'settings.general.themeLight'],
  ['dark', 'settings.general.themeDark']
]

export function GeneralPage(): React.JSX.Element {
  const { settings, saveSettings } = useUnibox()
  return (
    <>
      <PageHeader title={t('admin.nav.general')} description={t('admin.general.description')} />
      <Card title={t('admin.general.behaviour')}>
        <div className="settings__row">
          <span className="settings__row-label">{t('settings.general.theme')}</span>
          <select
            aria-label={t('settings.general.theme')}
            value={settings.theme ?? 'system'}
            onChange={(event) => void saveSettings({ theme: event.target.value as ThemePreference })}
          >
            {THEMES.map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
        </div>
        <div className="settings__row">
          <span className="settings__row-label">
            {t('shortcuts.setting')}
            <br />
            <span className="settings__row-sub">{t('shortcuts.settingHint')}</span>
          </span>
          <input
            type="checkbox"
            aria-label={t('shortcuts.setting')}
            checked={settings.shortcutsEnabled !== false}
            onChange={(event) => void saveSettings({ shortcutsEnabled: event.target.checked })}
          />
        </div>
        <div className="settings__row">
          <span className="settings__row-label">{t('settings.general.undoSend')}</span>
          <select
            aria-label={t('settings.general.undoSend')}
            value={settings.undoSendSeconds}
            onChange={(event) => void saveSettings({ undoSendSeconds: Number(event.target.value) })}
          >
            {[5, 10, 20, 30].map((seconds) => (
              <option key={seconds} value={seconds}>
                {t('settings.general.seconds', { count: seconds })}
              </option>
            ))}
          </select>
        </div>
        <div className="settings__row">
          <span className="settings__row-label">{t('settings.general.pollInterval')}</span>
          <select
            aria-label={t('settings.general.pollInterval')}
            value={settings.pollIntervalSeconds}
            onChange={(event) =>
              void saveSettings({ pollIntervalSeconds: Number(event.target.value) })
            }
          >
            {[30, 60, 90, 120].map((seconds) => (
              <option key={seconds} value={seconds}>
                {t('settings.general.pollSeconds', { count: seconds })}
              </option>
            ))}
          </select>
        </div>
      </Card>
      <Card>
        <FollowUpSection />
      </Card>
      <Card>
        <AiSection />
      </Card>
      <Card>
        <SettleSection />
      </Card>
      <Card>
        <RemoteImageTrustList />
      </Card>
      <Card>
        <AttachmentCache />
      </Card>
    </>
  )
}

function AccountRow({ account }: { account: Account }): React.JSX.Element {
  const { refresh } = useUnibox()
  const reconnect = useAction(async () => {
    await api.invoke('google:reconnect', account.id)
    await refresh()
  })
  const remove = useAction(async () => {
    await api.invoke('accounts:remove', account.id)
    await refresh()
  })

  return (
    <div className="settings__row-group">
      <div className="settings__row">
        <span className="sidebar__dot" style={{ background: account.color }} />
        <span className="settings__row-label">
          {account.email}
          <br />
          <span className="settings__row-sub">
            {t('settings.accounts.lastSync', {
              time: account.lastSyncedAt
                ? formatFullDate(account.lastSyncedAt)
                : t('settings.accounts.never')
            })}
          </span>
        </span>
        {account.status === 'reconnect_required' ? (
          <button
            type="button"
            className="button-secondary"
            aria-busy={reconnect.busy}
            disabled={reconnect.busy}
            onClick={() => void reconnect.run()}
          >
            {t('settings.accounts.reconnect')}
          </button>
        ) : null}
        <button
          type="button"
          className="button-secondary"
          aria-busy={remove.busy}
          disabled={remove.busy}
          onClick={() => {
            if (!window.confirm(t('settings.accounts.confirmRemove', { name: account.email })))
              return
            void remove.run()
          }}
        >
          {t('settings.accounts.remove')}
        </button>
      </div>
      {/* Why this account stopped syncing, in the API's own words. */}
      {account.status !== 'ok' && account.lastError ? (
        <span className="error-text">
          {t('settings.accounts.syncFailed', { message: account.lastError })}
        </span>
      ) : null}
      <InlineError message={reconnect.error ?? remove.error} />
    </div>
  )
}

export function AccountsPage(): React.JSX.Element {
  const { accounts, refresh, openAdmin } = useUnibox()
  const connect = useAction(async () => {
    await api.invoke('google:connect')
    await refresh()
  })

  return (
    <>
      <PageHeader
        title={t('admin.nav.accounts')}
        description={t('admin.accounts.description')}
        action={
          <AddButton
            label={t('settings.accounts.addGoogle')}
            disabled={connect.busy}
            onClick={() => void connect.run()}
          />
        }
      />
      <InlineError message={connect.error} />
      <Card>
        {accounts.length === 0 ? (
          <p className="admin-empty">{t('admin.accounts.empty')}</p>
        ) : (
          accounts.map((account) => <AccountRow key={account.id} account={account} />)
        )}
      </Card>
      <Card
        title={t('admin.accounts.resendTitle')}
        description={t('settings.accounts.domainsDescription')}
        action={
          <button type="button" className="button-secondary" onClick={() => openAdmin('domains')}>
            {t('admin.accounts.toDomains')}
          </button>
        }
      />
    </>
  )
}

/**
 * Shows the signature as the recipient will see it — the field holds raw HTML,
 * so without this the user is editing blind. Sanitised like any other mail
 * body; remote images are the user's own logo, so they are allowed to load.
 */
function SignaturePreview({ html }: { html: string }): React.JSX.Element | null {
  const clean = useMemo(
    () => sanitizeMessageHtml(html, { allowRemoteImages: true }).html,
    [html]
  )
  if (!html.trim()) return null
  return (
    <>
      <span className="settings__row-sub">{t('settings.identities.preview')}</span>
      <div className="signature-preview" dangerouslySetInnerHTML={{ __html: clean }} />
    </>
  )
}

/** Name and text of one library entry, with the preview right underneath. */
function SignatureEditor({
  signature,
  onDone
}: {
  signature: Signature
  onDone: () => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(signature.name)
  const [html, setHtml] = useState(signature.html)
  const save = useAction(async () => {
    await api.invoke('signatures:update', signature.id, { name, html })
    await onDone()
  })

  return (
    <div className="field" style={{ gap: 8 }}>
      <label htmlFor={`signature-name-${signature.id}`}>{t('settings.signatures.name')}</label>
      <input
        id={`signature-name-${signature.id}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor={`signature-html-${signature.id}`}>{t('settings.signatures.html')}</label>
      <textarea
        id={`signature-html-${signature.id}`}
        rows={5}
        value={html}
        onChange={(event) => setHtml(event.target.value)}
      />
      <SignaturePreview html={html} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="button-primary"
          aria-busy={save.busy}
          disabled={save.busy}
          onClick={() => void save.run()}
        >
          {t('settings.identities.save')}
        </button>
        <button type="button" className="button-secondary" onClick={() => void onDone()}>
          {t('settings.identities.cancel')}
        </button>
      </div>
      <InlineError message={save.error} />
    </div>
  )
}

/**
 * The signatures themselves, kept apart from the addresses that use them:
 * editing the company footer here reaches every address signing with it.
 */
function SignatureLibrary(): React.JSX.Element {
  const { signatures, reloadSignatures, reloadIdentities } = useUnibox()
  const [editing, setEditing] = useState<string | null>(null)
  const create = useAction(async () => {
    const created = await api.invoke('signatures:create', {
      name: t('settings.signatures.newName'),
      html: ''
    })
    await reloadSignatures()
    setEditing(created.id)
  })
  // Addresses pointing at it are left without one, so say how many there are.
  const remove = useAction(async (id: string) => {
    const signature = signatures.find((entry) => entry.id === id)
    if (
      signature &&
      signature.usedBy > 0 &&
      !window.confirm(
        t('settings.signatures.confirmRemove', {
          name: signature.name,
          count: signature.usedBy
        })
      )
    ) {
      return
    }
    await api.invoke('signatures:remove', id)
    await reloadSignatures()
    await reloadIdentities()
  })

  return (
    <>
      <span className="settings__section-title">{t('settings.signatures.section')}</span>
      <p className="settings__row-sub">{t('settings.signatures.description')}</p>
      {signatures.map((signature) => (
        <div key={signature.id}>
          <div className="settings__row">
            <span className="settings__row-label">
              {signature.name}
              <br />
              <span className="settings__row-sub">
                {signature.usedBy === 1
                  ? t('settings.signatures.usedByOne')
                  : t('settings.signatures.usedBy', { count: signature.usedBy })}
              </span>
            </span>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setEditing(editing === signature.id ? null : signature.id)}
            >
              {t('settings.identities.edit')}
            </button>
            <button
              type="button"
              className="button-secondary"
              aria-busy={remove.busy}
              disabled={remove.busy}
              onClick={() => void remove.run(signature.id)}
            >
              {t('settings.identities.delete')}
            </button>
          </div>
          {editing === signature.id ? (
            <SignatureEditor
              signature={signature}
              onDone={async () => {
                setEditing(null)
                await reloadSignatures()
                await reloadIdentities()
              }}
            />
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="button-secondary"
        style={{ alignSelf: 'flex-start' }}
        aria-busy={create.busy}
        disabled={create.busy}
        onClick={() => void create.run()}
      >
        {t('settings.signatures.add')}
      </button>
      <InlineError message={create.error ?? remove.error} />
    </>
  )
}

/** Name, shortcut, subject and body of one template, with a live preview. */
function TemplateEditor({
  template,
  onDone
}: {
  template: Template
  onDone: () => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(template.name)
  const [shortcut, setShortcut] = useState(template.shortcut ?? '')
  const [subject, setSubject] = useState(template.subject)
  const [html, setHtml] = useState(template.html)
  const save = useAction(async () => {
    await api.invoke('templates:update', template.id, { name, shortcut, subject, html })
    await onDone()
  })

  return (
    <div className="field" style={{ gap: 8 }}>
      <label htmlFor={`template-name-${template.id}`}>{t('settings.templates.name')}</label>
      <input
        id={`template-name-${template.id}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor={`template-shortcut-${template.id}`}>
        {t('settings.templates.shortcut')}
      </label>
      <input
        id={`template-shortcut-${template.id}`}
        value={shortcut}
        onChange={(event) => setShortcut(event.target.value)}
      />
      <span className="settings__row-sub">
        {shortcut.trim()
          ? t('settings.templates.shortcutHint', {
              shortcut: shortcut.trim().replace(/^\/+/, '')
            })
          : t('settings.templates.shortcutNone')}
      </span>
      <label htmlFor={`template-subject-${template.id}`}>{t('settings.templates.subject')}</label>
      <input
        id={`template-subject-${template.id}`}
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      />
      <label htmlFor={`template-html-${template.id}`}>{t('settings.templates.html')}</label>
      <textarea
        id={`template-html-${template.id}`}
        rows={6}
        value={html}
        onChange={(event) => setHtml(event.target.value)}
      />
      <span className="settings__row-sub">
        {t('settings.templates.autoHint', { list: AUTO_VARIABLES.join(', ') })}
      </span>
      {/* The same preview a signature gets: the field holds raw HTML, so
          without it the template is edited blind. */}
      <SignaturePreview html={html} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="button-primary"
          aria-busy={save.busy}
          disabled={save.busy}
          onClick={() => void save.run()}
        >
          {t('settings.identities.save')}
        </button>
        <button type="button" className="button-secondary" onClick={() => void onDone()}>
          {t('settings.identities.cancel')}
        </button>
      </div>
      <InlineError message={save.error} />
    </div>
  )
}

/**
 * The template library. Kept next to the signatures because it is the same
 * kind of thing — a text that belongs to no account and is written once — and
 * because that is where somebody looks for it.
 */
export function TemplatesPage(): React.JSX.Element {
  const { templates, reloadTemplates } = useUnibox()
  const [editing, setEditing] = useState<string | null>(null)
  const create = useAction(async () => {
    const created = await api.invoke('templates:create', {
      name: t('settings.templates.newName'),
      shortcut: null,
      subject: '',
      html: ''
    })
    await reloadTemplates()
    setEditing(created.id)
  })
  const remove = useAction(async (id: string) => {
    const template = templates.find((entry) => entry.id === id)
    if (
      template &&
      !window.confirm(t('settings.templates.confirmRemove', { name: template.name }))
    ) {
      return
    }
    await api.invoke('templates:remove', id)
    await reloadTemplates()
  })

  return (
    <>
      <PageHeader
        title={t('admin.nav.templates')}
        description={t('settings.templates.description')}
        action={
          <AddButton
            label={t('settings.templates.add')}
            disabled={create.busy}
            onClick={() => void create.run()}
          />
        }
      />
      <InlineError message={create.error ?? remove.error} />
      <Card>
        {templates.length === 0 ? (
          <p className="admin-empty">{t('settings.templates.empty')}</p>
        ) : null}
        {templates.map((template) => (
          <div key={template.id}>
            <div className="settings__row">
              <span className="settings__row-label">
                {template.shortcut ? `${template.name} · /${template.shortcut}` : template.name}
                <br />
                <span className="settings__row-sub">
                  {template.variables.length === 0
                    ? t('settings.templates.noVariables')
                    : t('settings.templates.variables', { list: template.variables.join(', ') })}
                </span>
              </span>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setEditing(editing === template.id ? null : template.id)}
              >
                {t('settings.identities.edit')}
              </button>
              <button
                type="button"
                className="button-secondary"
                aria-busy={remove.busy}
                disabled={remove.busy}
                onClick={() => void remove.run(template.id)}
              >
                {t('settings.identities.delete')}
              </button>
            </div>
            {editing === template.id ? (
              <TemplateEditor
                template={template}
                onDone={async () => {
                  setEditing(null)
                  await reloadTemplates()
                }}
              />
            ) : null}
          </div>
        ))}
      </Card>
    </>
  )
}

function IdentityEditor({
  identity,
  onDone
}: {
  identity: Identity
  onDone: () => Promise<void>
}): React.JSX.Element {
  const { signatures } = useUnibox()
  const [name, setName] = useState(identity.name)
  const [signatureId, setSignatureId] = useState(identity.signatureId)
  const selected = signatures.find((entry) => entry.id === signatureId) ?? null
  const save = useAction(async () => {
    await api.invoke('identities:update', identity.id, { name, signatureId })
    await onDone()
  })
  const makeDefault = useAction(async () => {
    await api.invoke('identities:update', identity.id, { isDefault: true })
    await onDone()
  })

  return (
    <div className="field" style={{ gap: 8 }}>
      <label htmlFor={`identity-name-${identity.id}`}>{t('settings.identities.name')}</label>
      <input
        id={`identity-name-${identity.id}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor={`identity-signature-${identity.id}`}>
        {t('settings.identities.signature')}
      </label>
      {/* Only the address's starting point — the draft may still pick another. */}
      <select
        id={`identity-signature-${identity.id}`}
        value={signatureId ?? ''}
        onChange={(event) => setSignatureId(event.target.value || null)}
      >
        <option value="">{t('settings.identities.noSignature')}</option>
        {signatures.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
      {signatures.length === 0 ? (
        <span className="settings__row-sub">{t('settings.signatures.empty')}</span>
      ) : null}
      <SignaturePreview html={selected?.html ?? ''} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="button-primary"
          aria-busy={save.busy}
          disabled={save.busy}
          onClick={() => void save.run()}
        >
          {t('settings.identities.save')}
        </button>
        <button
          type="button"
          className="button-secondary"
          aria-busy={makeDefault.busy}
          disabled={makeDefault.busy}
          onClick={() => void makeDefault.run()}
        >
          {t('settings.identities.makeDefault')}
        </button>
        <button type="button" className="button-secondary" onClick={() => void onDone()}>
          {t('settings.identities.cancel')}
        </button>
      </div>
      <InlineError message={save.error ?? makeDefault.error} />
    </div>
  )
}

export function IdentitiesPage(): React.JSX.Element {
  const { identities, accounts, reloadIdentities } = useUnibox()
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ accountId: '', name: '', email: '' })
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const resendIdentities = identities.filter(
    (i) => accountsById.get(i.accountId)?.kind === 'resend'
  )
  const gmailIdentities = identities.filter((i) => accountsById.get(i.accountId)?.kind === 'google')
  const resendAccounts = accounts.filter((account) => account.kind === 'resend')

  const create = useAction(async () => {
    await api.invoke('identities:create', {
      accountId: draft.accountId || (resendAccounts[0]?.id ?? ''),
      name: draft.name,
      email: draft.email,
      signatureId: null,
      isDefault: false
    })
    setCreating(false)
    setDraft({ accountId: '', name: '', email: '' })
    await reloadIdentities()
  })

  const remove = useAction(async (id: string) => {
    await api.invoke('identities:remove', id)
    await reloadIdentities()
  })

  return (
    <>
      <PageHeader
        title={t('admin.nav.identities')}
        description={t('settings.identities.description')}
        action={
          <AddButton
            label={t('admin.identities.add')}
            disabled={resendAccounts.length === 0}
            onClick={() => {
              setDraft({ accountId: resendAccounts[0]?.id ?? '', name: '', email: '' })
              setCreating(true)
            }}
          />
        }
      />

      <Card>
        <span className="settings__section-title">{t('settings.identities.resendSection')}</span>
        {resendAccounts.length === 0 ? (
          <span className="settings__row-sub">{t('settings.identities.noResendAccounts')}</span>
        ) : null}
        {resendIdentities.map((identity) => (
          <div key={identity.id}>
            <div className="settings__row">
              <span
                className="sidebar__dot"
                style={{ background: accountsById.get(identity.accountId)?.color }}
              />
              <span className="settings__row-label">
                {identity.name}
                <br />
                <span className="settings__row-sub">{identity.email}</span>
              </span>
              {identity.isDefault ? (
                <span className="badge" style={{ color: 'var(--text-muted)', background: 'var(--hover)' }}>
                  {t('settings.identities.default')}
                </span>
              ) : null}
              <button
                type="button"
                className="button-secondary"
                onClick={() => setEditing(editing === identity.id ? null : identity.id)}
              >
                {t('settings.identities.edit')}
              </button>
              <button
                type="button"
                className="button-secondary"
                aria-busy={remove.busy}
                disabled={remove.busy}
                onClick={() => void remove.run(identity.id)}
              >
                {t('settings.identities.delete')}
              </button>
            </div>
            {editing === identity.id ? (
              <IdentityEditor
                identity={identity}
                onDone={async () => {
                  setEditing(null)
                  await reloadIdentities()
                }}
              />
            ) : null}
          </div>
        ))}

        {creating ? (
          <div className="field" style={{ gap: 8 }}>
            <label htmlFor="new-identity-account">{t('settings.identities.resendSection')}</label>
            <select
              id="new-identity-account"
              value={draft.accountId}
              onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}
            >
              {resendAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
            <label htmlFor="new-identity-name">{t('settings.identities.name')}</label>
            <input
              id="new-identity-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <label htmlFor="new-identity-email">{t('settings.identities.email')}</label>
            <input
              id="new-identity-email"
              value={draft.email}
              onChange={(event) => setDraft({ ...draft, email: event.target.value })}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="button-primary"
                aria-busy={create.busy}
                disabled={create.busy}
                onClick={() => void create.run()}
              >
                {t('settings.identities.save')}
              </button>
              <button type="button" className="button-secondary" onClick={() => setCreating(false)}>
                {t('settings.identities.cancel')}
              </button>
            </div>
            <InlineError message={create.error} />
          </div>
        ) : null}

        <InlineError message={remove.error} />
      </Card>
      <Card>
        <span className="settings__section-title">{t('settings.identities.gmailSection')}</span>
        {gmailIdentities.map((identity) => (
          <div key={identity.id}>
            <div className="settings__row">
              <span
                className="sidebar__dot"
                style={{ background: accountsById.get(identity.accountId)?.color }}
              />
              <span className="settings__row-label">
                {identity.name}
                <br />
                <span className="settings__row-sub">{identity.email}</span>
              </span>
              <span className="badge" style={{ color: 'var(--text-muted)', background: 'var(--hover)' }}>
                {identity.email === accountsById.get(identity.accountId)?.email
                  ? t('settings.identities.account')
                  : t('settings.identities.alias')}
              </span>
              {identity.verified ? null : (
                <span
                  className="badge"
                  title={t('settings.identities.unverifiedHint')}
                  style={{ color: 'var(--warning-text)', background: 'var(--warning-bg)' }}
                >
                  {t('settings.identities.unverified')}
                </span>
              )}
              <button
                type="button"
                className="button-secondary"
                onClick={() => setEditing(editing === identity.id ? null : identity.id)}
              >
                {t('settings.identities.signature')}
              </button>
            </div>
            {editing === identity.id ? (
              <IdentityEditor
                identity={identity}
                onDone={async () => {
                  setEditing(null)
                  await reloadIdentities()
                }}
              />
            ) : null}
          </div>
        ))}
      </Card>
      <Card>
        <SignatureLibrary />
      </Card>
    </>
  )
}

export function NotificationsPage(): React.JSX.Element {
  const { settings, saveSettings, accounts, refresh } = useUnibox()
  const toggleAccount = useAction(async (accountId: string, enabled: boolean) => {
    await api.invoke('accounts:update', accountId, { notificationsEnabled: enabled })
    await refresh()
  })

  return (
    <>
      <PageHeader
        title={t('admin.nav.notifications')}
        description={t('admin.notifications.description')}
      />
      <Card>
        <div className="settings__row">
          <span className="settings__row-label">{t('settings.notifications.enabled')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.notificationsEnabled}
            aria-label={t('settings.notifications.enabled')}
            className={`switch${settings.notificationsEnabled ? ' switch--on' : ''}`}
            onClick={() =>
              void saveSettings({ notificationsEnabled: !settings.notificationsEnabled })
            }
          >
            <span className="switch__knob" />
          </button>
        </div>
      </Card>
      <Card>
        <div className="admin-toggle-row">
          <span>
            <strong>{t('settings.notifications.openAtLogin')}</strong>
            <span className="admin-muted">{t('settings.notifications.openAtLoginHint')}</span>
          </span>
          <Switch
            on={settings.openAtLogin ?? false}
            label={t('settings.notifications.openAtLogin')}
            onToggle={() => void saveSettings({ openAtLogin: !(settings.openAtLogin ?? false) })}
          />
        </div>
      </Card>
      <Card>
        <span className="settings__section-title">{t('settings.notifications.perAccount')}</span>
        {accounts.map((account) => (
          <div key={account.id} className="settings__row">
            <span className="sidebar__dot" style={{ background: account.color }} />
            <span className="settings__row-label">{account.email}</span>
            <button
              type="button"
              role="switch"
              aria-checked={account.notificationsEnabled}
              aria-label={account.email}
              className={`switch${account.notificationsEnabled ? ' switch--on' : ''}`}
              onClick={() => void toggleAccount.run(account.id, !account.notificationsEnabled)}
            >
              <span className="switch__knob" />
            </button>
          </div>
        ))}
        <InlineError message={toggleAccount.error} />
      </Card>
    </>
  )
}
