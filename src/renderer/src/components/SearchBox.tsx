import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IN_VALUES, filterToText } from '@shared/search-query'
import { t } from '../i18n'
import { useAddressSuggest } from '../lib/useAddressSuggest'
import { useUnibox } from '../state'
import { SearchIcon } from './Icons'
import { usePrompt } from './PromptDialog'

/** Operators offered while typing, in the order they are worth reaching for. */
const OPERATORS = [
  'from:',
  'to:',
  'cc:',
  'subject:',
  'is:',
  'in:',
  'label:',
  'has:',
  'filename:',
  'account:',
  'after:',
  'before:',
  'newer_than:',
  'older_than:'
]

const IS_VALUES = ['unread', 'read', 'starred']
const HAS_VALUES = ['attachment']

interface Suggestion {
  /** What replaces the token being typed. */
  insert: string
  label: string
  hint?: string
}

/** The word the caret sits in — everything back to the last unquoted space. */
function activeToken(text: string, caret: number): { start: number; value: string } {
  const before = text.slice(0, caret)
  const quotes = (before.match(/"/g) ?? []).length
  // An odd number of quotes means the caret is inside one, where spaces belong
  // to the token rather than separating it.
  const start = quotes % 2 === 1 ? before.lastIndexOf('"') : before.search(/\S*$/)
  return { start, value: before.slice(start) }
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

/** The shortcut `/` focuses the field through this id. */
export const SEARCH_INPUT_ID = 'search-input'

export function SearchBox(): React.JSX.Element {
  const { searchText, setSearchText, searchFilters, accounts, labels, saveSearch } = useUnibox()
  const input = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const [caret, setCaret] = useState(0)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const token = useMemo(() => activeToken(searchText, caret), [searchText, caret])
  const colon = token.value.indexOf(':')
  const negated = token.value.startsWith('-')
  const field = colon > 0 ? token.value.slice(negated ? 1 : 0, colon).toLowerCase() : null
  const typed = colon > 0 ? token.value.slice(colon + 1).replace(/"/g, '') : token.value
  // Address completions come from the main process; everything else is already
  // in renderer state.
  const addresses = useAddressSuggest(
    field === 'from' || field === 'to' || field === 'cc' ? field : null,
    typed
  )

  const suggestions = useMemo<Suggestion[]>(() => {
    const prefix = negated ? '-' : ''
    if (field === null) {
      if (token.value.length === 0) return []
      const bare = token.value.replace(/^-/, '').toLowerCase()
      return OPERATORS.filter((operator) => operator.startsWith(bare)).map((operator) => ({
        insert: `${prefix}${operator}`,
        label: operator
      }))
    }
    const value = typed.toLowerCase()
    const wrap = (values: string[], hint?: (value: string) => string | undefined): Suggestion[] =>
      values
        .filter((candidate) => candidate.toLowerCase().includes(value))
        .slice(0, 8)
        .map((candidate) => ({
          insert: `${prefix}${field}:${quoteIfNeeded(candidate)}`,
          label: candidate,
          hint: hint?.(candidate)
        }))

    switch (field) {
      case 'from':
      case 'to':
      case 'cc': {
        const me: Suggestion[] = 'me'.startsWith(value)
          ? [{ insert: `${prefix}${field}:me`, label: 'me', hint: t('search.meHint') }]
          : []
        return [
          ...me,
          ...addresses.map((address) => ({
            insert: `${prefix}${field}:${address.email}`,
            label: address.name ?? address.email,
            hint: address.name ? address.email : undefined
          }))
        ]
      }
      case 'is':
        return wrap(IS_VALUES)
      case 'has':
        return wrap(HAS_VALUES)
      case 'in':
        return wrap(Object.keys(IN_VALUES).filter((key) => key !== 'draft'))
      case 'label': {
        // Label names repeat across accounts on purpose, and the operator
        // matches all of them — so the list shows each name once.
        const names = [
          ...new Set(
            Object.values(labels)
              .flat()
              .filter((label) => label.type === 'user')
              .map((label) => label.name)
          )
        ]
        return wrap(names)
      }
      case 'account':
        return wrap(
          accounts.map((account) => account.email),
          (email) => accounts.find((account) => account.email === email)?.displayName
        )
      default:
        return []
    }
  }, [field, typed, token.value, negated, addresses, labels, accounts])

  const apply = useCallback(
    (suggestion: Suggestion) => {
      const rest = searchText.slice(caret)
      // An operator stays open for its value; a completed value gets a space so
      // the next token starts clean.
      const trailing = suggestion.insert.endsWith(':') ? '' : ' '
      const next = `${searchText.slice(0, token.start)}${suggestion.insert}${trailing}${rest}`
      const position = token.start + suggestion.insert.length + trailing.length
      setSearchText(next)
      setCaret(position)
      setOpen(suggestion.insert.endsWith(':'))
      setHighlighted(0)
      // The DOM caret can only move once the controlled value has been
      // committed; a timer here would race the next keystroke instead.
      pendingCaret.current = position
    },
    [searchText, caret, token.start, setSearchText]
  )

  // The async address list can shrink under the cursor, so the highlight is
  // clamped at render instead of being reset from an effect.
  const active = Math.min(highlighted, Math.max(suggestions.length - 1, 0))

  useEffect(() => {
    const position = pendingCaret.current
    if (position === null) return
    pendingCaret.current = null
    input.current?.focus()
    input.current?.setSelectionRange(position, position)
  }, [searchText])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      if (open) {
        event.stopPropagation()
        setOpen(false)
      }
      return
    }
    if (!open || suggestions.length === 0) return
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

  const sync = (event: React.SyntheticEvent<HTMLInputElement>): void => {
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
  }

  const { ask, dialog } = usePrompt()
  const showList = open && suggestions.length > 0

  return (
    <div className="search-box">
      <div className="search">
        <SearchIcon size={18} color="var(--text-muted)" />
        <input
          ref={input}
          id={SEARCH_INPUT_ID}
          type="search"
          value={searchText}
          placeholder={t('toolbar.searchPlaceholder')}
          aria-label={t('toolbar.searchPlaceholder')}
          title={t('search.hint')}
          role="combobox"
          aria-expanded={showList}
          aria-controls="search-suggestions"
          aria-autocomplete="list"
          autoComplete="off"
          onChange={(event) => {
            setSearchText(event.target.value)
            setOpen(true)
            setHighlighted(0)
            sync(event)
          }}
          onKeyUp={sync}
          onClick={sync}
          onFocus={() => setOpen(true)}
          // A click on a suggestion blurs the input first, so the list has to
          // outlive the blur by a frame.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {searchText.length > 0 ? (
          <button
            type="button"
            className="search__save"
            title={t('search.save')}
            aria-label={t('search.save')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={async () => {
              const name = await ask({
                label: t('search.savePrompt'),
                initial: searchText,
                confirmLabel: t('search.save')
              })
              if (name && name.trim().length > 0) await saveSearch(name.trim(), searchText)
            }}
          >
            +
          </button>
        ) : (
          <kbd className="search__kbd" aria-hidden="true">
            /
          </kbd>
        )}
      </div>
      {showList ? (
        <ul className="search__suggestions" id="search-suggestions" role="listbox">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.insert} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                className={`search__suggestion${index === active ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => apply(suggestion)}
              >
                <span className="search__suggestion-label">{suggestion.label}</span>
                {suggestion.hint ? (
                  <span className="search__suggestion-hint">{suggestion.hint}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {searchFilters.length > 0 ? (
        <div className="search__filters" role="status" aria-label={t('search.activeFilters')}>
          {searchFilters.map((filter, index) => (
            <span key={`${filter.field}-${index}`} className="search__chip">
              {filterToText(filter)}
            </span>
          ))}
        </div>
      ) : null}
      {dialog}
    </div>
  )
}
