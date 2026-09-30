import { parseMailto } from '@shared/mailto'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { ContextMenu, MenuItem } from './ContextMenu'
import { CopyIcon, OpenLinkIcon } from './EditorIcons'
import { ReplyIcon } from './Icons'

interface LinkMenuProps {
  href: string
  x: number
  y: number
  /** Follows the link: the browser, or a composer for a `mailto:`. */
  onOpen: (href: string) => void
  onClose: () => void
}

/**
 * What can be done with a link in a message without following it. Reading mail
 * means being sent links by people who want them clicked, so the address is
 * worth having in a form that can be looked at and copied rather than only
 * followed.
 */
export function LinkMenu({ href, x, y, onOpen, onClose }: LinkMenuProps): React.JSX.Element {
  const mailto = parseMailto(href)

  return (
    <ContextMenu x={x} y={y} label={t('reading.linkMenu')} onClose={onClose}>
      {mailto ? (
        <MenuItem
          label={t('reading.writeTo', { address: mailto.to || href })}
          icon={<ReplyIcon size={14} />}
          onClick={() => {
            onClose()
            onOpen(href)
          }}
        />
      ) : (
        <MenuItem
          label={t('reading.openLink')}
          icon={<OpenLinkIcon />}
          onClick={() => {
            onClose()
            onOpen(href)
          }}
        />
      )}
      <MenuItem
        label={mailto ? t('reading.copyAddress') : t('reading.copyLink')}
        icon={<CopyIcon />}
        onClick={() => {
          onClose()
          void api.invoke('clipboard:write', mailto ? mailto.to || href : href)
        }}
      />
    </ContextMenu>
  )
}
