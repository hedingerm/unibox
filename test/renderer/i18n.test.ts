import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { de } from '@renderer/i18n/de'
import { labelName, t } from '@renderer/i18n'
import { findHardcodedAttributes, findHardcodedText } from '../helpers/i18n-scan'

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

describe('translation lookup', () => {
  it('resolves nested keys and interpolates parameters', () => {
    expect(t('toolbar.newMail')).toBe('Neue E-Mail')
    expect(t('list.messageCount', { count: 3 })).toBe('3 Nachrichten')
  })

  it('falls back to the key so typos stay visible', () => {
    expect(t('does.not.exist')).toBe('does.not.exist')
  })

  it('translates Gmail system labels and keeps user labels untouched', () => {
    expect(labelName('INBOX', 'INBOX')).toBe('Eingang')
    expect(labelName('Label_7', 'Kunden/Aktiv')).toBe('Kunden/Aktiv')
  })

  it('ships a German dictionary', () => {
    expect(de.sidebar.allInboxes).toBe('Alle Eingänge')
  })
})

describe('hard coded string scanner', () => {
  it('flags literal JSX text', () => {
    expect(findHardcodedText('<span>Neue E-Mail</span>')).toEqual(['Neue E-Mail'])
  })

  it('accepts translated text', () => {
    expect(findHardcodedText("<span>{t('toolbar.newMail')}</span>")).toEqual([])
  })

  it('ignores TypeScript generics and arrow functions', () => {
    expect(findHardcodedText('const f = (): Promise<void> => undefined')).toEqual([])
    expect(findHardcodedText('counts: Record<string, number>')).toEqual([])
  })

  it('flags literal text attributes', () => {
    expect(findHardcodedAttributes('<input placeholder="Suchen" />')).toEqual([
      'placeholder="Suchen"'
    ])
    expect(findHardcodedAttributes('<input placeholder={t("x")} />')).toEqual([])
  })
})

describe('i18n lint', () => {
  const files = walk(join(process.cwd(), 'src/renderer/src')).filter((path) => path.endsWith('.tsx'))

  it('finds renderer components to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('has no hard coded UI strings in components', () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return [...findHardcodedText(source), ...findHardcodedAttributes(source)].map(
        (text) => `${file}: ${text}`
      )
    })
    expect(offenders).toEqual([])
  })
})
