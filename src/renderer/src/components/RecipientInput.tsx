import { useEffect, useRef, useState } from 'react'
import type { EmailAddress } from '@shared/types'
import { formatRecipient, parseRecipients } from '../lib/compose'
import { t } from '../i18n'
import { useAddressSuggest } from '../lib/useAddressSuggest'
import { CloseIcon } from './Icons'

/**
 * A recipient field that completes from the addresses the user has actually
 * corresponded with. The value stays a plain comma separated string — the
 * draft is stored as typed, half-written addresses included. Everything before
 * the last separator is settled and shown as a chip; only the entry after it is
 * still being typed, so that is what the input holds and what the list offers
 * to complete.
 *
 * A chip can be reached with the arrow keys or Backspace from the empty input,
 * and is only removed once it is the focused one — the first Backspace picks,
 * the second deletes, so a full address is never lost to one stray keystroke.
 */
export function RecipientInput({
  id,
  value,
  onChange
}: {
  id: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const chipRefs = useRef<Array<HTMLSpanElement | null>>([])
  /** Where the focus goes once the edited value has come back from the parent. */
  const pendingFocus = useRef<number | 'input' | null>(null)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)

  const parts = value.split(/[,;]/)
  const chips = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean)
  const typing = (parts[parts.length - 1] ?? '').replace(/^\s+/, '')
  const typed = typing.trim()

  // An entry that is already complete has nothing left to complete, and an
  // empty one would offer the whole address book at every comma.
  const suggestions = useAddressSuggest(
    typed.length > 0 && !typed.endsWith('>') ? 'recipient' : null,
    typed
  )

  // The list can shrink under the cursor while a request is in flight, so the
  // highlight is clamped at render instead of being reset from an effect.
  const active = Math.min(highlighted, Math.max(suggestions.length - 1, 0))
  const showList = open && suggestions.length > 0

  // A chip that was just removed is gone from the DOM, so the focus can only
  // move on once the new value has been rendered.
  useEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    if (target === 'input') input.current?.focus()
    else chipRefs.current[target]?.focus()
  }, [value])

  const write = (entries: string[], rest: string): void => {
    onChange(entries.length === 0 ? rest : `${entries.join(', ')}, ${rest}`)
  }

  const apply = (address: EmailAddress): void => {
    write([...chips, formatRecipient(address)], '')
    setOpen(false)
    setHighlighted(0)
    input.current?.focus()
  }

  /** Settles what is being typed into a chip — only once it is a full address. */
  const settle = (): boolean => {
    if (parseRecipients(typed).length !== 1) return false
    write([...chips, typed], '')
    return true
  }

  /**
   * Drops a chip and says where the focus lands: Backspace works its way to the
   * left, Delete and the × button stay where they are and let the rest move up.
   */
  const remove = (index: number, land: 'before' | 'after'): void => {
    const rest = chips.filter((_, at) => at !== index)
    write(rest, typing)
    if (land === 'before') pendingFocus.current = index > 0 ? index - 1 : 'input'
    else pendingFocus.current = index < rest.length ? index : 'input'
  }

  /**
   * Puts a chip back into the input to be corrected. It joins the end of the
   * list: the field only ever edits its last entry.
   */
  const edit = (index: number): void => {
    if (typed !== '') return
    write(chips.filter((_, at) => at !== index), chips[index] ?? '')
    pendingFocus.current = 'input'
  }

  const focusChip = (index: number): void => {
    chipRefs.current[index]?.focus()
  }

  const onChipKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>, index: number): void => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      remove(index, event.key === 'Backspace' ? 'before' : 'after')
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (index > 0) focusChip(index - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (index < chips.length - 1) focusChip(index + 1)
      else input.current?.focus()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      edit(index)
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      input.current?.focus()
    } else if (event.key.length === 1) {
      // Typing on a picked chip continues the mail rather than doing nothing.
      input.current?.focus()
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      if (open) {
        // Otherwise the shortcut layer reads this as closing the whole window.
        event.stopPropagation()
        setOpen(false)
      }
      return
    }
    if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && chips.length > 0) {
      const caret = event.currentTarget.selectionStart ?? 0
      if (caret === 0 && event.currentTarget.selectionEnd === caret) {
        event.preventDefault()
        focusChip(chips.length - 1)
        return
      }
    }
    if (!showList) {
      if (event.key === 'Enter' && settle()) event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((index) => (Math.min(index, suggestions.length - 1) + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted(
        (index) =>
          (Math.min(index, suggestions.length - 1) - 1 + suggestions.length) % suggestions.length
      )
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      apply(suggestions[active]!)
    }
  }

  return (
    <>
      <div className="recipient-field">
        {chips.map((chip, index) => {
          const address = parseRecipients(chip)[0]
          return (
            <span
              key={`${chip}-${index}`}
              ref={(node) => {
                chipRefs.current[index] = node
              }}
              className={`recipient-chip${address ? '' : ' is-invalid'}`}
              title={chip}
              tabIndex={-1}
              role="group"
              aria-label={chip}
              onKeyDown={(event) => onChipKeyDown(event, index)}
              onDoubleClick={() => edit(index)}
            >
              <span className="recipient-chip__label">
                {address?.name ?? address?.email ?? chip}
              </span>
              <button
                type="button"
                className="recipient-chip__remove"
                aria-label={t('compose.removeRecipient', { recipient: chip })}
                // The field must not lose focus over a removal.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => remove(index, 'after')}
              >
                <CloseIcon />
              </button>
            </span>
          )
        })}
        <input
          ref={input}
          id={id}
          value={typing}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-suggestions`}
          aria-autocomplete="list"
          autoComplete="off"
          onChange={(event) => {
            write(chips, event.target.value)
            setOpen(true)
            setHighlighted(0)
          }}
          onFocus={() => setOpen(true)}
          // A click on a suggestion blurs the input first, so the list has to
          // outlive the blur by a frame.
          onBlur={() => {
            settle()
            setTimeout(() => setOpen(false), 120)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {showList ? (
        <ul className="compose__suggestions" id={`${id}-suggestions`} role="listbox">
          {suggestions.map((address, index) => (
            <li key={address.email} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                className={`search__suggestion${index === active ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => apply(address)}
              >
                <span className="search__suggestion-label">{address.name ?? address.email}</span>
                {address.name ? (
                  <span className="search__suggestion-hint">{address.email}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
