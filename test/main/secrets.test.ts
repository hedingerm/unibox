import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Encryptor } from '@main/secrets'
import { EncryptedFileSecretStore, TokenVault } from '@main/secrets'

/** Stand-in for Electron's safeStorage; the real one uses the macOS keychain key. */
const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ 0x5a)).toString('utf8')
}

function tempStore(): { store: EncryptedFileSecretStore; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'unibox-secrets-')), 'secrets.json')
  return { store: new EncryptedFileSecretStore(file, fakeEncryptor), file }
}

describe('secret store', () => {
  it('round-trips values', () => {
    const { store } = tempStore()
    store.set('a', 'geheim')
    expect(store.get('a')).toBe('geheim')
    store.delete('a')
    expect(store.get('a')).toBeNull()
  })

  it('never writes plaintext to disk', () => {
    const { store, file } = tempStore()
    store.set('google:1', JSON.stringify({ refreshToken: 'SUPER_SECRET_REFRESH' }))
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain('SUPER_SECRET_REFRESH')
    expect(onDisk).not.toContain('refreshToken')
  })

  it('refuses to operate without OS encryption', () => {
    expect(
      () =>
        new EncryptedFileSecretStore('/tmp/never-written.json', {
          ...fakeEncryptor,
          isEncryptionAvailable: () => false
        })
    ).toThrow()
  })

  it('stores Google tokens and the Resend key through the vault', () => {
    const { store } = tempStore()
    const vault = new TokenVault(store)
    vault.setGoogleTokens('acc-1', {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 123,
      scope: 'gmail.modify',
      tokenType: 'Bearer'
    })
    expect(vault.getGoogleTokens('acc-1')?.refreshToken).toBe('rt')
    vault.setResendApiKey('re_123')
    expect(vault.getResendApiKey()).toBe('re_123')
    vault.clearGoogleTokens('acc-1')
    expect(vault.getGoogleTokens('acc-1')).toBeNull()
  })
})
