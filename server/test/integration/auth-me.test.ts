import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { createApp } from '../../src/app.js'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEVICE_SESSION_TTL_SECONDS,
} from '../../src/lib/tokens.js'
import { makeAdmin, makeStaff, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'

/**
 * `/auth/me` — who is calling, and who they are.
 *
 * The first test in this suite to go over HTTP rather than calling a service directly. It has
 * to: the thing under test is the route and the authenticate middleware behind it, and the
 * two objects the endpoint returns exist precisely so the shell can name a person without the
 * authorization type learning what a name is.
 *
 * `createApp()` never listens, which is what makes mounting it here free.
 */

const app = createApp()

const DEVICE_TOKEN = 'test-device-token-for-me-endpoint'

let storeId: string

beforeEach(async () => {
  await resetDatabase()
  storeId = (await makeStore('Store A', 'store-a')).id
})

/** Sign in and keep the cookies, the way a browser would. */
async function adminCookies(): Promise<string[]> {
  await makeAdmin('admin@test.local', 'test-password')

  const agent = request(app)
  const primed = await agent.get('/api/auth/me')
  const csrf = readCookie(primed.headers['set-cookie'] as unknown as string[], 'huta_csrf')

  const login = await agent
    .post('/api/auth/login')
    .set('Cookie', (primed.headers['set-cookie'] as unknown as string[]) ?? [])
    .set('X-CSRF-Token', csrf ?? '')
    .send({ email: 'admin@test.local', password: 'test-password' })

  expect(login.status).toBe(200)
  return login.headers['set-cookie'] as unknown as string[]
}

function readCookie(setCookie: string[] | undefined, name: string): string | null {
  for (const raw of setCookie ?? []) {
    const [pair] = raw.split(';')
    const [key, ...rest] = (pair ?? '').split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

describe('GET /auth/me', () => {
  it('returns the principal and the person for an admin', async () => {
    const cookies = await adminCookies()

    const res = await request(app).get('/api/auth/me').set('Cookie', cookies)

    expect(res.status).toBe(200)
    expect(res.body.principal).toMatchObject({ kind: 'admin', role: 'ADMIN', storeId: null })
    expect(res.body.user).toMatchObject({
      firstName: 'Test',
      lastName: 'Admin',
      email: 'admin@test.local',
      role: 'ADMIN',
    })
    // A desk session is nowhere in particular.
    expect(res.body.terminal).toBeNull()
  })

  it('returns the person for a PIN-attached staff principal', async () => {
    const staff = await makeStaff(storeId, '4321')
    await makeTerminal(storeId, DEVICE_TOKEN)

    const agent = request(app)
    const primed = await agent.get('/api/auth/me').set('X-Device-Token', DEVICE_TOKEN)
    const jar = (primed.headers['set-cookie'] as unknown as string[]) ?? []
    const csrf = readCookie(jar, 'huta_csrf')

    const attach = await agent
      .post('/api/auth/staff/attach')
      .set('X-Device-Token', DEVICE_TOKEN)
      .set('Cookie', jar)
      .set('X-CSRF-Token', csrf ?? '')
      .send({ userId: staff.id, pin: '4321' })

    expect(attach.status).toBe(200)

    const res = await request(app)
      .get('/api/auth/me')
      .set('X-Device-Token', DEVICE_TOKEN)
      .set('Cookie', attach.headers['set-cookie'] as unknown as string[])

    expect(res.body.principal.kind).toBe('staff')
    expect(res.body.user).toMatchObject({ firstName: 'Test', lastName: 'Staff', role: 'STAFF' })
    // Attached staff are still AT the register — the label survives the sign-in.
    expect(res.body.terminal).toMatchObject({
      name: 'Register 1',
      store: { name: 'Store A' },
    })
  })

  it('returns a null person for a bare terminal', async () => {
    await makeTerminal(storeId, DEVICE_TOKEN)

    const res = await request(app).get('/api/auth/me').set('X-Device-Token', DEVICE_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.principal.kind).toBe('terminal')
    // A register with nobody attached has no person to name — null, not an empty object.
    expect(res.body.user).toBeNull()
    // But it knows WHERE it is — that is how a mis-paired machine gets noticed.
    expect(res.body.terminal).toMatchObject({
      name: 'Register 1',
      store: { id: storeId, name: 'Store A' },
    })
  })

  it('never returns credential material', async () => {
    const cookies = await adminCookies()
    const res = await request(app).get('/api/auth/me').set('Cookie', cookies)

    // The select is explicit for this reason: a bare findUnique would have returned
    // passwordHash, pinHash and pinLookup, and a PIN lookup is an HMAC that would let an
    // attacker confirm a guessed PIN offline.
    const serialised = JSON.stringify(res.body)
    for (const secret of ['passwordHash', 'pinHash', 'pinLookup', 'password']) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('401s with no session at all', async () => {
    const res = await request(app).get('/api/auth/me')
    expect(res.status).toBe(401)
  })
})

describe('the staff session lifetime', () => {
  /**
   * The attach token must live as long as the cookie it is stored in.
   *
   * It did not: `setStaffSessionCookie` uses a 12-hour cookie but `signAccessToken` was
   * called without a TTL, so the JWT inside expired after 15 minutes. `authenticate` then
   * fell back to the device token and the cashier silently became a bare TERMINAL — whose
   * capabilities are own-store reads only — on a screen that still looked signed in. The
   * observed symptom was a catalog search failing with "You do not have permission to
   * inventory.view.other" mid-shift.
   */
  it('signs the attach token for the whole device session, not 15 minutes', async () => {
    const staff = await makeStaff(storeId, '4321')
    await makeTerminal(storeId, DEVICE_TOKEN)

    const agent = request(app)
    const primed = await agent.get('/api/auth/me').set('X-Device-Token', DEVICE_TOKEN)
    const jar = (primed.headers['set-cookie'] as unknown as string[]) ?? []
    const csrf = readCookie(jar, 'huta_csrf')

    const attach = await agent
      .post('/api/auth/staff/attach')
      .set('X-Device-Token', DEVICE_TOKEN)
      .set('Cookie', jar)
      .set('X-CSRF-Token', csrf ?? '')
      .send({ userId: staff.id, pin: '4321' })
    expect(attach.status).toBe(200)

    const token = readCookie(attach.headers['set-cookie'] as unknown as string[], 'huta_at')
    expect(token).toBeTruthy()

    // Read the claims straight off the JWT — the point is the expiry it was signed with.
    const [, payload] = (token as string).split('.')
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as {
      iat: number
      exp: number
    }
    expect(claims.exp - claims.iat).toBe(DEVICE_SESSION_TTL_SECONDS)
    expect(claims.exp - claims.iat).not.toBe(ACCESS_TOKEN_TTL_SECONDS)
  })
})
