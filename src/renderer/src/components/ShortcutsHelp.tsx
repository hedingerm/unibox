import { Fragment, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { t } from '../i18n'
import { SHORTCUTS, SHORTCUT_GROUPS, bindingCaps } from '../lib/shortcuts'
import { CloseIcon, KeyboardIcon } from './Icons'

function Binding({ binding }: { binding: string }): React.JSX.Element {
  const caps = bindingCaps(binding)
  return (
    <span className="shortcuts__binding">
      {caps.map((cap, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="shortcuts__then">{t('shortcuts.then')}</span> : null}
          <kbd className="kbd">{cap}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

/**
 * The overview behind `?` and the sidebar's "Tastenkürzel" row, read straight
 * from the registry so it lists exactly what the keys do.
 */
export function ShortcutsHelp({
  onClose,
  disabled
}: {
  onClose: () => void
  /** Single-key shortcuts are switched off in the settings. */
  disabled: boolean
}): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  useFocusTrap(dialog)
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        className="shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' || event.key === '?') {
            event.preventDefault()
            onClose()
          }
        }}
      >
        <header className="shortcuts__head">
          <span className="shortcuts__icon">
            <KeyboardIcon size={18} color="var(--accent)" />
          </span>
          <div className="shortcuts__heading">
            <h2 className="shortcuts__title">{t('shortcuts.title')}</h2>
            <p className="shortcuts__subtitle">
              {disabled ? t('shortcuts.disabledHint') : t('shortcuts.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="shortcuts__close"
            aria-label={t('shortcuts.close')}
            autoFocus
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="shortcuts__grid">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group} className="shortcuts__group">
              <h3 className="shortcuts__group-title">{t(`shortcuts.groups.${group}`)}</h3>
              <table className="shortcuts__table">
                <tbody>
                  {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                    <tr key={shortcut.id}>
                      <td className="shortcuts__label">{t(shortcut.label)}</td>
                      <td className="shortcuts__keys">
                        {shortcut.keys.map((binding, index) => (
                          <Fragment key={binding}>
                            {index > 0 ? (
                              <span className="shortcuts__then">{t('shortcuts.or')}</span>
                            ) : null}
                            <Binding binding={binding} />
                          </Fragment>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <footer className="shortcuts__foot">{t('shortcuts.toggleHint')}</footer>
      </div>
    </div>,
    document.body
  )
}

/** The small chip that says a `g` is waiting for its second key. */
export function SequenceHint({ prefix }: { prefix: string }): React.JSX.Element {
  return (
    <div className="sequence-hint" role="status">
      <kbd className="kbd">{prefix}</kbd>
      <span>{t('shortcuts.pending')}</span>
    </div>
  )
}
