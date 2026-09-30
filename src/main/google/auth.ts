import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GoogleTokenSet } from '../secrets'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic'
]

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  authEndpoint?: string
  tokenEndpoint?: string
  scopes?: string[]
}

export type FetchLike = typeof globalThis.fetch

export interface GoogleAuthDeps {
  fetch?: FetchLike
  now?: () => number
}

/**
 * Raised when Google refuses a refresh token. With an OAuth client in testing
 * mode this happens every seven days, so it is a normal operating state that
 * the UI turns into a "reconnect" prompt rather than a silent failure.
 */
export class ReconnectRequiredError extends Error {
  constructor(readonly accountId: string | null, message = 'Google-Verbindung abgelaufen') {
    super(message)
    this.name = 'ReconnectRequiredError'
  }
}

export interface PkcePair {
  verifier: string
  challenge: string
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  token_type: string
}

interface TokenErrorResponse {
  error?: string
  error_description?: string
}

export class GoogleAuthClient {
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  constructor(
    private readonly config: GoogleOAuthConfig,
    deps: GoogleAuthDeps = {}
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch
    this.now = deps.now ?? Date.now
  }

  buildAuthUrl(args: { redirectUri: string; challenge: string; state: string; loginHint?: string }): string {
    const url = new URL(this.config.authEndpoint ?? GOOGLE_AUTH_ENDPOINT)
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', args.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', (this.config.scopes ?? GOOGLE_SCOPES).join(' '))
    url.searchParams.set('code_challenge', args.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', args.state)
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    if (args.loginHint) url.searchParams.set('login_hint', args.loginHint)
    return url.toString()
  }

  private async postToken(body: URLSearchParams, accountId: string | null): Promise<TokenResponse> {
    const response = await this.fetchImpl(this.config.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    const text = await response.text()
    let payload: TokenResponse & TokenErrorResponse
    try {
      payload = JSON.parse(text) as TokenResponse & TokenErrorResponse
    } catch {
      throw new Error(`Ungültige Antwort vom Token-Endpunkt: ${text.slice(0, 200)}`)
    }
    if (!response.ok) {
      if (payload.error === 'invalid_grant') throw new ReconnectRequiredError(accountId)
      throw new Error(payload.error_description ?? payload.error ?? `HTTP ${response.status}`)
    }
    return payload
  }

  private toTokenSet(payload: TokenResponse, fallbackRefreshToken?: string): GoogleTokenSet {
    const refreshToken = payload.refresh_token ?? fallbackRefreshToken
    if (!refreshToken) throw new Error('Google lieferte keinen Refresh-Token zurück.')
    return {
      accessToken: payload.access_token,
      refreshToken,
      expiresAt: this.now() + payload.expires_in * 1000,
      scope: payload.scope,
      tokenType: payload.token_type
    }
  }

  async exchangeCode(args: {
    code: string
    verifier: string
    redirectUri: string
  }): Promise<GoogleTokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: args.code,
      code_verifier: args.verifier,
      grant_type: 'authorization_code',
      redirect_uri: args.redirectUri
    })
    return this.toTokenSet(await this.postToken(body, null))
  }

  async refresh(refreshToken: string, accountId: string | null = null): Promise<GoogleTokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
    return this.toTokenSet(await this.postToken(body, accountId), refreshToken)
  }
}

export interface LoopbackResult {
  code: string
  state: string
}

export interface LoopbackHandle {
  redirectUri: string
  /** Resolves once Google redirects the browser back to us. */
  waitForCode: () => Promise<LoopbackResult>
  close: () => void
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Unibox</title>
<body style="font-family:-apple-system,system-ui,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;background:#f0f0f3;color:#1d1d1f">
<div style="text-align:center"><h1 style="font-size:20px">Konto verbunden</h1>
<p style="color:#6e6e73;font-size:14px">Du kannst dieses Fenster schliessen und zu Unibox zurückkehren.</p></div>`

/** Starts a one-shot loopback listener for the OAuth redirect. */
export async function startLoopbackServer(timeoutMs = 5 * 60_000): Promise<LoopbackHandle> {
  let resolveCode: (value: LoopbackResult) => void
  let rejectCode: (error: Error) => void
  const promise = new Promise<LoopbackResult>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_PAGE)
    if (error) {
      rejectCode(new Error(`OAuth abgebrochen: ${error}`))
      return
    }
    resolveCode({
      code: url.searchParams.get('code') ?? '',
      state: url.searchParams.get('state') ?? ''
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const timer = setTimeout(() => rejectCode(new Error('Zeitüberschreitung beim Verbinden')), timeoutMs)
  timer.unref?.()

  const close = (): void => {
    clearTimeout(timer)
    server.close()
  }
  void promise.finally(close).catch(() => undefined)

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    waitForCode: () => promise,
    close
  }
}
