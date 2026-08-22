import type { ApiErrorBody, ErrorCode } from '@huta/shared/schemas'

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
  readonly issues: ReadonlyArray<{ path: string; message: string }>
  readonly requestId: string | undefined

  constructor(init: {
    status: number
    code: ErrorCode
    message: string
    retryAfterSeconds?: number | undefined
    issues?: ReadonlyArray<{ path: string; message: string }>
    requestId?: string | undefined
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.retryAfterSeconds = init.retryAfterSeconds
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

export async function apiFetch<T>(path: string, options: ApiRequest = {}): Promise<T> {
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

  if (!response.ok) throw toApiError(response.status, payload, requestId)

  return payload as T
}
