import { useState } from 'react'
import type { Mailbox } from '@shared/admin'
import type { Account } from '@shared/types'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { useAction } from '../../lib/useAction'
import { useUnibox } from '../../state'
import { CloseIcon } from '../Icons'
import { InlineError } from '../InlineError'
import { DeleteIcon, EditIcon } from './icons'
import { AddButton, Card, Chip, Dialog, MoveButtons, PageHeader, movedTo, useLoaded } from './ui'

/** `info` becomes `info@domain`; a full address is taken as typed. */
function fullAddress(value: string, domain: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : `${trimmed}@${domain}`
}

function MailboxDialog({
  mailbox,
  accounts,
  onClose,
  onSaved
}: {
  mailbox: Mailbox | null
  accounts: Account[]
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { identities } = useUnibox()
  const [accountId, setAccountId] = useState(mailbox?.accountId ?? accounts[0]?.id ?? '')
  const domain = accounts.find((account) => account.id === accountId)?.email ?? ''
  const [local, setLocal] = useState(mailbox ? mailbox.address.split('@')[0]! : '')
  const [displayName, setDisplayName] = useState(mailbox?.displayName ?? '')
  const [aliases, setAliases] = useState<string[]>(mailbox?.aliases ?? [])
  const [aliasDraft, setAliasDraft] = useState('')
  const [identityId, setIdentityId] = useState<string | null>(mailbox?.identityId ?? null)
  const domainIdentities = identities.filter((identity) => identity.accountId === accountId)

  const addAlias = (): void => {
    const value = aliasDraft.replace(/,/g, '').trim()
    if (!value) return
    const address = fullAddress(value, domain)
    setAliases((current) => (current.includes(address) ? current : [...current, address]))
    setAliasDraft('')
  }

  const save = useAction(async () => {
    const pendingAlias = aliasDraft.trim() ? [fullAddress(aliasDraft, domain)] : []
    const input = {
      address: `${local.trim().toLowerCase()}@${domain}`,
      displayName: displayName.trim(),
      aliases: [...new Set([...aliases, ...pendingAlias])],
      identityId
    }
    if (mailbox) await api.invoke('mailboxes:update', mailbox.id, input)
    else await api.invoke('mailboxes:create', { accountId, ...input })
    onSaved()
  })

  const title = mailbox ? t('admin.mailboxes.editTitle') : t('admin.mailboxes.createTitle')
  return (
    <Dialog
      title={title}
      description={t('admin.mailboxes.dialogDescription')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('admin.common.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            aria-busy={save.busy}
            disabled={save.busy || !local.trim() || !accountId}
            onClick={() => void save.run()}
          >
            {mailbox ? t('admin.common.save') : t('admin.mailboxes.create')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="mailbox-domain">{t('admin.mailboxes.domain')}</label>
        <select
          id="mailbox-domain"
          value={accountId}
          disabled={mailbox !== null}
          onChange={(event) => {
            setAccountId(event.target.value)
            setIdentityId(null)
          }}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.email}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="mailbox-local">{t('admin.mailboxes.address')}</label>
        <span className="admin-address">
          <input
            id="mailbox-local"
            value={local}
            placeholder={t('admin.mailboxes.addressPlaceholder')}
            onChange={(event) => setLocal(event.target.value.replace(/@.*/, ''))}
          />
          <span className="admin-address__domain">@{domain}</span>
        </span>
      </div>
      <div className="field">
        <label htmlFor="mailbox-name">{t('admin.mailboxes.displayName')}</label>
        <input
          id="mailbox-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="mailbox-alias">{t('admin.mailboxes.aliases')}</label>
        <span className="admin-tags">
          {aliases.map((alias) => (
            <span key={alias} className="recipient-chip">
              <span className="recipient-chip__label">{alias}</span>
              <button
                type="button"
                className="recipient-chip__remove"
                aria-label={t('admin.mailboxes.removeAlias', { alias })}
                onClick={() => setAliases((current) => current.filter((entry) => entry !== alias))}
              >
                <CloseIcon size={10} />
              </button>
            </span>
          ))}
          <input
            id="mailbox-alias"
            value={aliasDraft}
            placeholder={t('admin.mailboxes.aliasPlaceholder')}
            onChange={(event) => setAliasDraft(event.target.value)}
            onBlur={addAlias}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault()
                addAlias()
              }
            }}
          />
        </span>
      </div>
      <div className="field">
        <label htmlFor="mailbox-identity">{t('admin.mailboxes.identity')}</label>
        <select
          id="mailbox-identity"
          value={identityId ?? ''}
          onChange={(event) => setIdentityId(event.target.value || null)}
        >
          <option value="">{t('admin.mailboxes.identityAuto')}</option>
          {domainIdentities.map((identity) => (
            <option key={identity.id} value={identity.id}>
              {identity.name} ‹{identity.email}›
            </option>
          ))}
        </select>
      </div>
      <InlineError message={save.error} />
    </Dialog>
  )
}

function MailboxRow({
  mailbox,
  first,
  last,
  busy,
  drop,
  onMove,
  onEdit,
  onRemove
}: {
  mailbox: Mailbox
  first: boolean
  last: boolean
  busy: boolean
  /** Native drag and drop within the domain; the buttons stay for the keyboard. */
  drop: {
    target: boolean
    onStart: () => void
    onOver: () => void
    onDrop: () => void
    onEnd: () => void
  }
  onMove: (delta: -1 | 1) => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { identities } = useUnibox()
  const identity = identities.find((entry) => entry.id === mailbox.identityId)
  const name = mailbox.displayName || mailbox.address
  return (
    <li
      className={`admin-row${drop.target ? ' admin-row--drop' : ''}`}
      draggable={!busy}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        drop.onStart()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        drop.onOver()
      }}
      onDrop={(event) => {
        event.preventDefault()
        drop.onDrop()
      }}
      onDragEnd={drop.onEnd}
    >
      <span className="admin-avatar">{name.charAt(0).toUpperCase()}</span>
      <span className="admin-row__main">
        <span className="admin-row__title">{name}</span>
        <span className="admin-row__sub">{mailbox.address}</span>
        {mailbox.aliases.length > 0 ? (
          <span className="admin-chips">
            {mailbox.aliases.map((alias) => (
              <Chip key={alias} tone="info" icon={false}>
                {alias}
              </Chip>
            ))}
          </span>
        ) : null}
      </span>
      <span className="admin-row__meta">
        {identity ? t('admin.mailboxes.sendsAs', { name: identity.email }) : null}
      </span>
      {mailbox.unread > 0 ? (
        <span className="sidebar__count">{mailbox.unread}</span>
      ) : null}
      <MoveButtons name={name} first={first} last={last} disabled={busy} onMove={onMove} />
      <button
        type="button"
        className="icon-button admin-icon-button"
        aria-label={t('admin.common.editName', { name })}
        onClick={onEdit}
      >
        <EditIcon size={15} />
      </button>
      <button
        type="button"
        className="icon-button admin-icon-button admin-icon-button--danger"
        aria-label={t('admin.common.deleteName', { name })}
        disabled={busy}
        onClick={onRemove}
      >
        <DeleteIcon size={15} />
      </button>
    </li>
  )
}

export function MailboxesPage(): React.JSX.Element {
  const { accounts, counts, refresh, select, openAdmin } = useUnibox()
  const mailboxes = useLoaded(() => api.invoke('mailboxes:list'))
  const [dialog, setDialog] = useState<{ mailbox: Mailbox | null } | null>(null)
  const resendAccounts = accounts.filter((account) => account.kind === 'resend')
  const list = mailboxes.data ?? []
  const unassigned = counts.unassigned ?? 0

  const changed = async (): Promise<void> => {
    mailboxes.reload()
    await refresh()
  }

  // The row being dragged and the row it hovers, both within one domain.
  const [drag, setDrag] = useState<{ accountId: string; from: number; over: number } | null>(null)

  const reorder = useAction(async (accountId: string, from: number, to: number) => {
    const group = list.filter((mailbox) => mailbox.accountId === accountId)
    const reordered = movedTo(group, from, to)
    if (reordered === group) return
    // The order is global; the other domains keep their place around this one.
    const ids = resendAccounts.flatMap((account) =>
      account.id === accountId
        ? reordered.map((mailbox) => mailbox.id)
        : list.filter((mailbox) => mailbox.accountId === account.id).map((mailbox) => mailbox.id)
    )
    mailboxes.setData(ids.map((id) => list.find((mailbox) => mailbox.id === id)!))
    await api.invoke('mailboxes:reorder', ids)
    await changed()
  })

  const remove = useAction(async (mailbox: Mailbox) => {
    if (!window.confirm(t('admin.mailboxes.confirmRemove', { address: mailbox.address }))) return
    await api.invoke('mailboxes:remove', mailbox.id)
    await changed()
  })

  return (
    <>
      <PageHeader
        title={t('admin.nav.mailboxes')}
        description={t('admin.mailboxes.description')}
        action={
          <AddButton
            label={t('admin.mailboxes.add')}
            disabled={resendAccounts.length === 0}
            onClick={() => setDialog({ mailbox: null })}
          />
        }
      />
      <InlineError message={mailboxes.error ?? reorder.error ?? remove.error} />
      {unassigned > 0 ? (
        <div className="admin-banner admin-banner--warning">
          <span className="admin-banner__text">
            <strong>{t('admin.mailboxes.unassignedTitle', { count: unassigned })}</strong>
            <span>{t('admin.mailboxes.unassignedHint')}</span>
          </span>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              select({ accountId: null, labelId: null, view: 'unassigned' })
              openAdmin(null)
            }}
          >
            {t('admin.mailboxes.showUnassigned')}
          </button>
        </div>
      ) : null}
      {resendAccounts.length === 0 ? (
        <Card>
          <p className="admin-empty">{t('admin.mailboxes.noDomains')}</p>
        </Card>
      ) : null}
      {resendAccounts.map((account) => {
        const group = list.filter((mailbox) => mailbox.accountId === account.id)
        return (
          <Card key={account.id} title={account.email}>
            {group.length === 0 ? (
              <p className="admin-empty">{t('admin.mailboxes.empty')}</p>
            ) : (
              <ul className="admin-list">
                {group.map((mailbox, index) => (
                  <MailboxRow
                    key={mailbox.id}
                    mailbox={mailbox}
                    first={index === 0}
                    last={index === group.length - 1}
                    busy={reorder.busy || remove.busy}
                    drop={{
                      target:
                        drag !== null &&
                        drag.accountId === account.id &&
                        drag.over === index &&
                        drag.from !== index,
                      onStart: () => setDrag({ accountId: account.id, from: index, over: index }),
                      onOver: () =>
                        setDrag((current) =>
                          current && current.accountId === account.id && current.over !== index
                            ? { ...current, over: index }
                            : current
                        ),
                      onDrop: () => {
                        if (drag && drag.accountId === account.id) {
                          void reorder.run(account.id, drag.from, index)
                        }
                        setDrag(null)
                      },
                      onEnd: () => setDrag(null)
                    }}
                    onMove={(delta) => void reorder.run(account.id, index, index + delta)}
                    onEdit={() => setDialog({ mailbox })}
                    onRemove={() => void remove.run(mailbox)}
                  />
                ))}
              </ul>
            )}
          </Card>
        )
      })}
      {dialog ? (
        <MailboxDialog
          mailbox={dialog.mailbox}
          accounts={resendAccounts}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            void changed()
          }}
        />
      ) : null}
    </>
  )
}
