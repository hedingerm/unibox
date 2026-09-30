import { describe, expect, it, vi } from 'vitest'
import { GoogleAuthClient, ReconnectRequiredError, createPkcePair } from '@main/google/auth'
import { GoogleTokenManager } from '@main/google/tokens'
import { InMemorySecretStore, TokenVault } from '@main/secrets'
import { makeStore, addGoogleAccount } from '../helpers/store'

const config = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  tokenEndpoint: 'https://token.test/token',
  authEndpoint: 'https://auth.test/auth'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('PKCE', () => {
  it('derives an S256 challenge from the verifier', () => {
    const pair = createPkcePair()
    expect(pair.verifier).not.toBe(pair.challenge)
    expect(pair.challenge).toMatch(/^[\w-]+$/)
    expect(createPkcePair().verifier).not.toBe(pair.verifier)
  })
})

describe('GoogleAuthClient', () => {
  it('builds an offline consent URL with the PKCE challenge', () => {
    const client = new GoogleAuthClient(config)
    const url = new URL(
      client.buildAuthUrl({ redirectUri: 'http://127.0.0.1:1/callback', challenge: 'ch', state: 'st' })
    )
    expect(url.origin + url.pathname).toBe('https://auth.test/auth')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('scope')).toContain('gmail.modify')
  })

  it('exchanges an authorization code for tokens', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope: 'gmail.modify',
        token_type: 'Bearer'
      })
    )
    const client = new GoogleAuthClient(config, { fetch: fetchMock, now: () => 1_000 })
    const tokens = await client.exchangeCode({
      code: 'c',
      verifier: 'v',
      redirectUri: 'http://127.0.0.1:1/callback'
    })
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresAt).toBe(1_000 + 3600 * 1000)
    const body = String(fetchMock.mock.calls[0]![1]?.body)
    expect(body).toContain('code_verifier=v')
  })

  it('keeps the previous refresh token when Google omits it', async () => {
    const client = new GoogleAuthClient(config, {
      fetch: async () =>
        jsonResponse({ access_token: 'at2', expires_in: 60, scope: 's', token_type: 'Bearer' }),
      now: () => 0
    })
    const tokens = await client.refresh('old-rt')
    expect(tokens.refreshToken).toBe('old-rt')
    expect(tokens.accessToken).toBe('at2')
  })

  it('turns invalid_grant into a reconnect signal', async () => {
    const client = new GoogleAuthClient(config, {
      fetch: async () => jsonResponse({ error: 'invalid_grant' }, 400)
    })
    await expect(client.refresh('expired', 'acc-1')).rejects.toBeInstanceOf(ReconnectRequiredError)
  })
})

describe('GoogleTokenManager', () => {
  it('reuses a valid access token', async () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const vault = new TokenVault(new InMemorySecretStore())
    vault.setGoogleTokens(account.id, {
      accessToken: 'still-good',
      refreshToken: 'rt',
      expiresAt: 10_000_000,
      scope: 's',
      tokenType: 'Bearer'
    })
    const fetchMock = vi.fn()
    const manager = new GoogleTokenManager(
      new GoogleAuthClient(config, { fetch: fetchMock }),
      vault,
      store.accounts,
      () => 0
    )
    expect(await manager.accessToken(account.id)).toBe('still-good')
    expect(fetchMock).not.toHaveBeenCalled()
    store.close()
  })

  it('refreshes an expired token and persists the result', async () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const vault = new TokenVault(new InMemorySecretStore())
    vault.setGoogleTokens(account.id, {
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: 0,
      scope: 's',
      tokenType: 'Bearer'
    })
    const manager = new GoogleTokenManager(
      new GoogleAuthClient(config, {
        fetch: async () =>
          jsonResponse({ access_token: 'fresh', expires_in: 3600, scope: 's', token_type: 'Bearer' }),
        now: () => 5_000
      }),
      vault,
      store.accounts,
      () => 5_000
    )
    expect(await manager.accessToken(account.id)).toBe('fresh')
    expect(vault.getGoogleTokens(account.id)?.accessToken).toBe('fresh')
    store.close()
  })

  it('flags the account for reconnect when the refresh token expired', async () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const vault = new TokenVault(new InMemorySecretStore())
    vault.setGoogleTokens(account.id, {
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: 0,
      scope: 's',
      tokenType: 'Bearer'
    })
    const manager = new GoogleTokenManager(
      new GoogleAuthClient(config, {
        fetch: async () => jsonResponse({ error: 'invalid_grant' }, 400)
      }),
      vault,
      store.accounts,
      () => 5_000
    )
    await expect(manager.accessToken(account.id)).rejects.toBeInstanceOf(ReconnectRequiredError)
    expect(store.accounts.get(account.id)?.status).toBe('reconnect_required')
    store.close()
  })

  it('reports reconnect when no tokens are stored at all', async () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const manager = new GoogleTokenManager(
      new GoogleAuthClient(config, { fetch: vi.fn() }),
      new TokenVault(new InMemorySecretStore()),
      store.accounts
    )
    await expect(manager.accessToken(account.id)).rejects.toBeInstanceOf(ReconnectRequiredError)
    expect(store.accounts.get(account.id)?.status).toBe('reconnect_required')
    store.close()
  })
})
