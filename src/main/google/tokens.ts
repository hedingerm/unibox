import type { AccountRepo } from '../db/repos/accounts'
import type { TokenVault } from '../secrets'
import { GoogleAuthClient, ReconnectRequiredError } from './auth'

/** Refresh a little early so a long request cannot straddle the expiry. */
const EXPIRY_SKEW_MS = 60_000

export class GoogleTokenManager {
  private inFlight = new Map<string, Promise<string>>()

  constructor(
    private readonly auth: GoogleAuthClient,
    private readonly vault: TokenVault,
    private readonly accounts: AccountRepo,
    private readonly now: () => number = Date.now
  ) {}

  async accessToken(accountId: string): Promise<string> {
    const pending = this.inFlight.get(accountId)
    if (pending) return pending
    const promise = this.resolve(accountId).finally(() => this.inFlight.delete(accountId))
    this.inFlight.set(accountId, promise)
    return promise
  }

  private async resolve(accountId: string): Promise<string> {
    const tokens = this.vault.getGoogleTokens(accountId)
    if (!tokens) {
      const message = 'Keine Google-Tokens hinterlegt'
      this.accounts.update(accountId, { status: 'reconnect_required', lastError: message })
      throw new ReconnectRequiredError(accountId, message)
    }
    if (tokens.expiresAt - EXPIRY_SKEW_MS > this.now()) return tokens.accessToken
    try {
      const refreshed = await this.auth.refresh(tokens.refreshToken, accountId)
      this.vault.setGoogleTokens(accountId, refreshed)
      if (this.accounts.get(accountId)?.status !== 'ok') {
        this.accounts.update(accountId, { status: 'ok', lastError: null })
      }
      return refreshed.accessToken
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        this.accounts.update(accountId, { status: 'reconnect_required', lastError: error.message })
      }
      throw error
    }
  }
}
