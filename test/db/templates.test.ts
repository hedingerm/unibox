import { describe, expect, it } from 'vitest'
import { ShortcutTakenError, normalizeShortcut } from '@main/db/repos/templates'
import { makeStore } from '../helpers/store'

describe('template repo', () => {
  it('derives the placeholders from the text rather than storing them', () => {
    const store = makeStore()
    const created = store.templates.create({
      name: 'Offerte',
      shortcut: 'offerte',
      subject: 'Offerte {{Projekt}}',
      html: '<p>Hallo {{empfaenger.vorname}}</p>'
    })
    expect(created.variables).toEqual(['Projekt', 'empfaenger.vorname'])
    // A body that loses a placeholder loses it in the listing too — a stored
    // copy would still be claiming it.
    const edited = store.templates.update(created.id, { html: '<p>Hallo</p>' })
    expect(edited.variables).toEqual(['Projekt'])
    store.close()
  })

  it('strips the slash off a shortcut and matches it without regard to case', () => {
    const store = makeStore()
    store.templates.create({ name: 'Offerte', shortcut: '/Offerte', subject: '', html: '<p>x</p>' })
    expect(store.templates.byShortcut('offerte')?.name).toBe('Offerte')
    expect(store.templates.byShortcut('OFFERTE')?.name).toBe('Offerte')
    expect(store.templates.list()[0]?.shortcut).toBe('Offerte')
    store.close()
  })

  it('refuses a second template on the same shortcut, by name', () => {
    const store = makeStore()
    store.templates.create({ name: 'Offerte', shortcut: 'offerte', subject: '', html: '' })
    expect(() =>
      store.templates.create({ name: 'Zweite', shortcut: 'Offerte', subject: '', html: '' })
    ).toThrow(ShortcutTakenError)
    // Saving a template over itself is not a clash.
    const first = store.templates.list()[0]!
    expect(() => store.templates.update(first.id, { shortcut: 'offerte' })).not.toThrow()
    store.close()
  })

  it('lets any number of templates go without a shortcut', () => {
    const store = makeStore()
    store.templates.create({ name: 'Eins', shortcut: null, subject: '', html: '' })
    store.templates.create({ name: 'Zwei', shortcut: '   ', subject: '', html: '' })
    expect(store.templates.list().map((entry) => entry.shortcut)).toEqual([null, null])
    expect(normalizeShortcut('  /  ')).toBeNull()
    store.close()
  })
})
