import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The subset of Electron's `safeStorage` we depend on. Keeping it as an
 * interface lets the secret store be exercised without an Electron runtime.
 */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  keys(): string[]
}

interface SecretFile {
  version: 1
  entries: Record<string, string>
}

/**
 * Secrets are encrypted with the OS-backed key that macOS keeps in the login
 * keychain; only the ciphertext ever touches the disk. Refusing to run without
 * encryption is deliberate — we never want a plaintext fallback for tokens.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private cache: SecretFile | null = null

  constructor(
    private readonly filePath: string,
    private readonly encryptor: Encryptor
  ) {
    if (!encryptor.isEncryptionAvailable()) {
      throw new Error('OS-Verschlüsselung nicht verfügbar — Secrets können nicht sicher abgelegt werden.')
    }
  }

  private read(): SecretFile {
    if (this.cache) return this.cache
    if (!existsSync(this.filePath)) {
      this.cache = { version: 1, entries: {} }
      return this.cache
    }
    const raw = readFileSync(this.filePath, 'utf8')
    try {
      const parsed = JSON.parse(raw) as SecretFile
      this.cache = { version: 1, entries: parsed.entries ?? {} }
    } catch {
      this.cache = { version: 1, entries: {} }
    }
    return this.cache
  }

  private write(file: SecretFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(file), { mode: 0o600 })
    this.cache = file
  }

  get(key: string): string | null {
    const entry = this.read().entries[key]
    if (!entry) return null
    try {
      return this.encryptor.decryptString(Buffer.from(entry, 'base64'))
    } catch {
      return null
    }
  }

  set(key: string, value: string): void {
    const file = this.read()
    file.entries[key] = this.encryptor.encryptString(value).toString('base64')
    this.write(file)
  }

  delete(key: string): void {
    const file = this.read()
    delete file.entries[key]
    this.write(file)
  }

  keys(): string[] {
    return Object.keys(this.read().entries)
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly entries = new Map<string, string>()

  get(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  set(key: string, value: string): void {
    this.entries.set(key, value)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }
}

export const secretKeys = {
  googleTokens: (accountId: string): string => `google:${accountId}`,
  resendApiKey: (): string => 'resend:apiKey'
}

export interface GoogleTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
  tokenType: string
}

export class TokenVault {
  constructor(private readonly secrets: SecretStore) {}

  getGoogleTokens(accountId: string): GoogleTokenSet | null {
    const raw = this.secrets.get(secretKeys.googleTokens(accountId))
    if (!raw) return null
    try {
      return JSON.parse(raw) as GoogleTokenSet
    } catch {
      return null
    }
  }

  setGoogleTokens(accountId: string, tokens: GoogleTokenSet): void {
    this.secrets.set(secretKeys.googleTokens(accountId), JSON.stringify(tokens))
  }

  clearGoogleTokens(accountId: string): void {
    this.secrets.delete(secretKeys.googleTokens(accountId))
  }

  getResendApiKey(): string | null {
    return this.secrets.get(secretKeys.resendApiKey())
  }

  setResendApiKey(key: string): void {
    this.secrets.set(secretKeys.resendApiKey(), key)
  }

  clearResendApiKey(): void {
    this.secrets.delete(secretKeys.resendApiKey())
  }
}
