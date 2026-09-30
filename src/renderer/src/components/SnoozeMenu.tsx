import { useState } from 'react'
import { t } from '../i18n'
import { formatSnoozeUntil } from '../lib/format'
import { customSnoozeDefault, parseCustomSnooze, snoozePresets } from '../lib/snooze'
import { ClockIcon } from './Icons'
import { MenuDivider, MenuItem } from './ContextMenu'

interface SnoozeOptionsProps {
  /** Called with the chosen moment; the caller closes whatever holds this. */
  onPick: (wakeAt: number) => void
}

/**
 * The list of moments a conversation can be put aside until. It lives in its
 * own component because both the toolbar button and the right-click menu open
 * exactly this — a second, drifting copy of the offers would be worse than the
 * small indirection.
 *
 * Every row names its actual date next to the offer: "Nächste Woche" without a
 * date is a promise nobody can check.
 */
export function SnoozeOptions({ onPick }: SnoozeOptionsProps): React.JSX.Element {
  const [custom, setCustom] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const presets = snoozePresets()

  const submitCustom = (): void => {
    const at = custom === null ? null : parseCustomSnooze(custom)
    if (at === null || at <= Date.now()) {
      setInvalid(true)
      return
    }
    onPick(at)
  }

  return (
    <>
      {presets.map((preset) => (
        <MenuItem
          key={preset.key}
          label={`${t(`snooze.${preset.key}`)} · ${formatSnoozeUntil(preset.at)}`}
          icon={<ClockIcon size={13} />}
          onClick={() => onPick(preset.at)}
        />
      ))}
      <MenuDivider />
      {custom === null ? (
        <MenuItem
          label={t('snooze.custom')}
          icon={<ClockIcon size={13} />}
          onClick={() => setCustom(customSnoozeDefault())}
        />
      ) : (
        <div className="snooze__custom">
          <input
            type="datetime-local"
            className="snooze__custom-input"
            aria-label={t('snooze.custom')}
            aria-invalid={invalid}
            value={custom}
            autoFocus
            onChange={(event) => {
              setInvalid(false)
              setCustom(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              submitCustom()
            }}
          />
          <button type="button" className="snooze__custom-confirm" onClick={submitCustom}>
            {t('snooze.customConfirm')}
          </button>
          {invalid ? (
            <span className="snooze__custom-error" role="alert">
              {t('snooze.past')}
            </span>
          ) : null}
        </div>
      )}
      {/* The two things that are not obvious: it archives, and it needs the app
          running. Said here, where the choice is actually made. */}
      <p className="snooze__hint">{t('snooze.hint')}</p>
    </>
  )
}
