import type { ApiErrorBody, ErrorCode, PaymentFailureReason } from '@huta/shared/schemas'

/**
 * The only place HTTP happens.
 *
 * Everything the API expects is handled here once — credentials, the CSRF header, the
 * error envelope — so no call site can forget a piece and produce a failure that looks
 * like something else.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly retryAfterSeconds: number | undefined
  /** PAYMENT_FAILED only — which way the card interaction went wrong. */
  readonly reason: PaymentFailureReason | undefined
  readonly issues: ReadonlyArray<{ path: string; message: string }>
  readonly requestId: string | undefined

  constructor(init: {
    status: number
    code: ErrorCode
    message: string
    retryAfterSeconds?: number | undefined
    reason?: PaymentFailureReason | undefined
    issues?: ReadonlyArray<{ path: string; message: string }>
    requestId?: string | undefined
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.retryAfterSeconds = init.retryAfterSeconds
    this.reason = init.reason
    this.issues = init.issues ?? []
    this.requestId = init.requestId
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Read the CSRF token the server planted.
 *
 * `huta_csrf` is deliberately NOT httpOnly — that is the whole double-submit mechanism.
 * The session cookies are httpOnly and unreadable here, which is the point.
 */
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'huta_csrf') return decodeURIComponent(rest.join('='))
  }
  return null
}

/**
 * Turn any failure into an ApiError.
 *
 * Must tolerate a non-JSON body: the rate limiters set no custom handler, so a 429 comes
 * back as plain text rather than the error envelope. Assuming JSON there would turn
 * "you're rate limited" into an unhandled parse error.
 */
function toApiError(status: number, body: unknown, requestId: string | undefined): ApiError {
  if (status === 429) {
    return new ApiError({
      status,
      code: 'RATE_LIMITED',
      message: 'Too many attempts. Wait a few minutes and try again.',
      requestId,
    })
  }

  const envelope = body as Partial<ApiErrorBody> | undefined
  const error = envelope?.error

  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return new ApiError({
      status,
      code: error.code,
      message: error.message,
      retryAfterSeconds: error.details?.retryAfterSeconds,
      reason: error.details?.reason,
      issues: error.details?.issues?.map((i) => ({ path: i.path, message: i.message })) ?? [],
      requestId,
    })
  }

  return new ApiError({
    status,
    code: 'INTERNAL',
    message: 'Something went wrong. Please try again.',
    requestId,
  })
}

/**
 * Query values. An array becomes a repeated key (`?c=a&c=b`), which is what the multi-
 * select filters need; `undefined` and empty arrays are dropped so callers can pass
 * optional filters without building the string themselves.
 */
export type QueryValue = string | number | boolean | undefined | readonly string[]

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
}

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item)
    } else {
      params.set(key, String(value))
    }
  }
  const serialised = params.toString()
  return serialised ? `?${serialised}` : ''
}

/**
 * Endpoints where a 401 is the answer, not a renewable failure.
 *
 * `/auth/me` is here for the REGISTER recovery below (it is the question being asked, so it
 * must not trigger its own recovery) while still being refresh-eligible in the back office —
 * see `shouldAttemptRefresh`, which excludes it from this list deliberately.
 */
const NO_RETRY = ['/auth/refresh', '/auth/login', '/auth/logout']
const NO_RECOVER = [...NO_RETRY, '/auth/me', '/auth/staff/attach', '/auth/terminal/pair']

/**
 * Whether a 401 on this request is worth spending a refresh on.
 *
 * `/auth/me` IS included, deliberately, and it is the case that matters most: on a cold page
 * load an expired 15-minute access token makes `/auth/me` 401, the guard reads that as
 * signed-out and shows the login form — even though the seven-day refresh cookie beside it
 * is perfectly good. That is the "I have to hit reload" symptom.
 *
 * The REGISTER is excluded outright. Staff and terminal sessions are never issued a refresh
 * token (only admin login mints one), so an attempt there is a guaranteed 401 on every
 * unauthenticated register boot — a wasted round trip for an answer we already know.
 */
function shouldAttemptRefresh(path: string): boolean {
  if (NO_RETRY.includes(path)) return false
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/register')) {
    return false
  }
  return true
}

/**
 * The in-flight refresh, shared by every request that 401s at once.
 *
 * This single-flight is NOT an optimisation, it is a correctness requirement. Refresh
 * tokens ROTATE, and presenting an already-rotated one is treated as a replay: the server
 * revokes the whole token family and both parties have to sign in again (Auth).
 * A page that fires five parallel requests would, without this, send five refreshes with
 * the same cookie and hard-log the admin out — the exact opposite of the fix.
 */
let refreshInFlight: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const csrf = readCsrfToken()
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
      })
      return response.ok
    } catch {
      return false
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see the same answer
      // before a later 401 is allowed to start a fresh attempt.
      queueMicrotask(() => (refreshInFlight = null))
    }
  })()
  return refreshInFlight
}

/**
 * Send a dead back-office session to the login screen instead of leaving an error on a page
 * that can no longer load anything.
 *
 * A HARD navigation, deliberately. It resets all client state, so there is no stale
 * `principal` left in Pinia for the route guard to read — with one, the guard's
 * "already signed in" rule bounces straight back off /login and the app loops. It also
 * re-plants the CSRF cookie on the way in.
 *
 * The REGISTER is left alone: the house rules are explicit that an unpaired or signed-out device's
 * remedy is /register/pair, never the back-office login, and each register page already
 * routes itself on boot.
 */
/**
 * A register whose session has ended goes back to the right door, never the back-office one.
 *
 * Two different endings, and they need different doors: if the DEVICE is still paired but
 * nobody is attached, the remedy is the roster (`/register/sign-in`); if the device token
 * itself is gone, it is `/register/pair`. The house rules are explicit that a signed-out device's
 * remedy is pairing and never `/login`.
 *
 * Called only after re-asking the server who we are, because the page's cached principal is
 * exactly what went stale.
 */
async function recoverRegisterSession(status: number): Promise<void> {
  if (typeof window === 'undefined') return
  if (!window.location.pathname.startsWith('/register')) return

  let kind: string | null = null
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' })
    if (res.ok) {
      const body = (await res.json()) as { principal?: { kind?: string } }
      kind = body.principal?.kind ?? null
    }
  } catch {
    return // offline: the page's own error state is more honest than a redirect
  }

  // Still somebody? Then this was a genuine refusal, not a lapsed session — a cashier
  // asking for something they may not have must see the error, not be signed out.
  if (kind === 'staff' || kind === 'admin') return

  const target = kind === 'terminal' ? '/register/sign-in' : '/register/pair'
  if (window.location.pathname === target) return
  // Hard navigation: it clears the stale principal that Pinia is still holding, which is
  // the thing that made the page keep rendering as if someone were attached.
  window.location.assign(target)
  // A 403 that survives to the caller after this would flash an error mid-navigation.
  void status
}

function redirectToLogin(): void {
  if (typeof window === 'undefined') return
  const { pathname, search } = window.location
  if (pathname.startsWith('/register') || pathname === '/login') return
  const next = encodeURIComponent(`${pathname}${search}`)
  window.location.assign(`/login?expired=1&next=${next}`)
}

export async function apiFetch<T>(path: string, options: ApiRequest = {}): Promise<T> {
  return request<T>(path, options, true)
}

async function request<T>(
  path: string,
  options: ApiRequest,
  mayRetry: boolean,
): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }

  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  if (!SAFE_METHODS.has(method)) {
    const csrf = readCsrfToken()
    // Omitting this yields a 403 that reads like a failed login, which is a genuinely
    // confusing bug to chase.
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  let response: Response
  try {
    response = await fetch(`/api${path}${buildQuery(options.query)}`, {
      method,
      headers,
      // Session lives in cookies; without this they are simply not sent.
      credentials: 'include',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  } catch {
    throw new ApiError({
      status: 0,
      code: 'INTERNAL',
      message: 'Cannot reach the server. Check that the API is running.',
    })
  }

  // Correlates what the user saw with a line in the server log, without logging anything
  // sensitive to get there.
  const requestId = response.headers.get('x-request-id') ?? undefined

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  const payload: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => undefined)
    : await response.text().catch(() => undefined)

  if (!response.ok) {
    /**
     * A 401 mid-page is the NORMAL end of a 15-minute access token, not a signed-out user —
     * the refresh cookie is good for seven days. So try to renew once and replay the
     * request; only a refresh that genuinely fails means the session is over.
     *
     * Bouncing straight to /login here instead would sign an admin out every 15 minutes,
     * which would be a regression wearing the costume of a fix.
     */
    if (response.status === 401 && mayRetry && shouldAttemptRefresh(path)) {
      if (await refreshSession()) return request<T>(path, options, false)
      redirectToLogin()
    }

    /**
     * The register's own recovery. A staff PIN attach can lapse while the page stays open,
     * and the page keeps rendering from a cached principal — so calls start failing with
     * "You do not have permission to …" on a screen that still looks signed in.
     *
     * 403 is included, and that is why the check re-asks the server rather than trusting the
     * status: a 403 is usually a legitimate refusal (staff naming another store's data) and
     * must NOT sign anyone out. Only a principal that has actually degraded to a bare
     * terminal — or to nothing — sends them back to a door.
     */
    if ((response.status === 401 || response.status === 403) && !NO_RECOVER.includes(path)) {
      await recoverRegisterSession(response.status)
    }

    throw toApiError(response.status, payload, requestId)
  }

  return payload as T
}
