import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'

import { prisma } from '../db/client.js'
import { UnauthorizedError } from '../errors/index.js'
import {
  COOKIE,
  clearSessionCookies,
  setAccessCookie,
  setDeviceCookie,
  setRefreshCookie,
  setStaffSessionCookie,
} from '../lib/cookies.js'
import { DEVICE_SESSION_TTL_SECONDS, signAccessToken } from '../lib/tokens.js'
import { requireAdmin, requirePrincipal } from '../middleware/authenticate.js'
import { issueCsrfToken } from '../middleware/csrf.js'
import { validateBody, validateParams } from '../middleware/validate.js'
import {
  attachByPin,
  authenticateAdmin,
  issueRefreshToken,
  revokeRefreshToken,
  roster,
  rotateRefreshToken,
} from './auth.service.js'
import { CAPABILITIES } from './permissions.js'
import { actingUserId } from './principal.js'
import { authorize } from './stepup.service.js'
import {
  createPairingCode,
  createTerminal,
  listTerminals,
  redeemPairingCode,
  updateTerminal,
} from './terminal.service.js'

/**
 * Auth routes. HTTP translation only — all logic lives in the services.
 *
 * Rate limits sit on top of the per-account lockout: the lockout protects one account
 * from being ground down, the limiter protects the endpoint from being hammered with
 * guesses spread across many accounts.
 */

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

const pinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  // Higher than the 5-attempt account lockout because one terminal is shared by a whole
  // shift — several people legitimately punch PINs in quick succession.
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

const pairingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

export const authRouter: Router = Router()

// --- admin session ---------------------------------------------------------------------

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})

authRouter.post('/login', loginLimiter, validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>

  const principal = await authenticateAdmin(email, password)
  const accessToken = await signAccessToken({
    sub: principal.userId,
    kind: 'admin',
    storeId: null,
    terminalId: null,
  })
  const refresh = await issueRefreshToken(principal.userId)

  setAccessCookie(res, accessToken)
  setRefreshCookie(res, refresh.token)
  const csrfToken = issueCsrfToken(res)

  res.json({ user: { id: principal.userId, role: principal.role }, csrfToken })
})

authRouter.post('/refresh', async (req, res) => {
  const cookies = req.cookies as Record<string, string | undefined>
  const token = cookies[COOKIE.REFRESH]
  if (!token) throw new UnauthorizedError('Session expired. Please sign in again.')

  const { userId, next } = await rotateRefreshToken(token)
  const accessToken = await signAccessToken({
    sub: userId,
    kind: 'admin',
    storeId: null,
    terminalId: null,
  })

  setAccessCookie(res, accessToken)
  setRefreshCookie(res, next.token)
  const csrfToken = issueCsrfToken(res)

  res.json({ csrfToken })
})

authRouter.post('/logout', async (req, res) => {
  const cookies = req.cookies as Record<string, string | undefined>
  const token = cookies[COOKIE.REFRESH]
  if (token) await revokeRefreshToken(token)
  clearSessionCookies(res)
  res.status(204).end()
})

// --- terminal enrolment ----------------------------------------------------------------

const pairSchema = z.object({ code: z.string().min(4).max(32) })

authRouter.post(
  '/terminal/pair',
  pairingLimiter,
  validateBody(pairSchema),
  async (req, res) => {
    const { code } = req.body as z.infer<typeof pairSchema>
    const paired = await redeemPairingCode(code)

    setDeviceCookie(res, paired.deviceToken)

    res.json({
      // Returned once so a non-browser client can persist it. The cookie covers browsers.
      deviceToken: paired.deviceToken,
      terminal: { id: paired.terminalId, name: paired.terminalName },
      store: { id: paired.storeId, name: paired.storeName },
    })
  },
)

const pairingCodeSchema = z.object({ terminalId: z.cuid() })

authRouter.post(
  '/terminal/pairing-code',
  requireAdmin,
  validateBody(pairingCodeSchema),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const { terminalId } = req.body as z.infer<typeof pairingCodeSchema>
    if (principal.userId === null) throw new UnauthorizedError()

    const created = await createPairingCode(terminalId, principal.userId)
    res.json({ code: created.code, expiresAt: created.expiresAt.toISOString() })
  },
)

// --- terminal administration (the Registers back-office screen) -------------------------

authRouter.get('/terminals', requireAdmin, async (_req, res) => {
  res.json({ terminals: await listTerminals() })
})

const terminalCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  storeId: z.cuid(),
})

authRouter.post('/terminals', requireAdmin, validateBody(terminalCreateSchema), async (req, res) => {
  const principal = requirePrincipal(req)
  if (principal.userId === null) throw new UnauthorizedError()
  const body = req.body as z.infer<typeof terminalCreateSchema>
  res.status(201).json(await createTerminal(body.name, body.storeId, principal.userId))
})

const terminalIdParam = z.object({ id: z.cuid() })
const terminalPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
})

authRouter.patch(
  '/terminals/:id',
  requireAdmin,
  validateParams(terminalIdParam),
  validateBody(terminalPatchSchema),
  async (req, res) => {
    const principal = requirePrincipal(req)
    if (principal.userId === null) throw new UnauthorizedError()
    res.json(
      await updateTerminal(
        req.params['id'] as string,
        req.body as z.infer<typeof terminalPatchSchema>,
        principal.userId,
      ),
    )
  },
)

// --- staff attach / detach -------------------------------------------------------------

/**
 * Who may attach at this register. Store scope comes from the DEVICE, never from the
 * client — an unattended terminal must not be able to enumerate another store's staff.
 */
authRouter.get('/staff/roster', async (req, res) => {
  const principal = requirePrincipal(req)
  if (principal.storeId === null) {
    throw new UnauthorizedError('This register is not paired to a store.')
  }
  res.json({ staff: await roster(principal.storeId) })
})

const pinSchema = z.object({
  userId: z.cuid(),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits.'),
})

authRouter.post('/staff/attach', pinLimiter, validateBody(pinSchema), async (req, res) => {
  const principal = requirePrincipal(req)
  if (principal.kind !== 'terminal') {
    throw new UnauthorizedError('This register is not paired to a store.')
  }

  const { userId, pin } = req.body as z.infer<typeof pinSchema>
  const result = await attachByPin(userId, pin, principal.terminalId, principal.storeId)

  /**
   * Signed for the DEVICE SESSION lifetime, not the 15-minute default.
   *
   * `setStaffSessionCookie` stores this under a 12-hour cookie because an attach is meant to
   * last a shift — staff have no refresh token, and re-keying a PIN every quarter of an hour
   * at a counter is not the design. Leaving the default here made the cookie outlive the
   * token inside it: after 15 minutes `authenticate` fell back to the device token and the
   * cashier silently became a bare TERMINAL, whose capabilities are read-own-store only. The
   * symptom was a catalog search suddenly failing with "You do not have permission to
   * inventory.view.other" on a screen that still looked signed in.
   */
  const token = await signAccessToken(
    {
      sub: result.principal.userId,
      kind: result.principal.kind,
      storeId: result.principal.storeId,
      terminalId: principal.terminalId,
    },
    DEVICE_SESSION_TTL_SECONDS,
  )
  setStaffSessionCookie(res, token)

  // Attaching plants a session cookie, so every later state-changing call from this
  // register goes through csrfProtection. Without issuing a CSRF token here, detach and
  // step-up would arrive with a session cookie and no CSRF cookie and be rejected — only
  // admin login and refresh planted one, which a register never performs.
  const csrfToken = issueCsrfToken(res)

  res.json({
    user: {
      id: result.principal.userId,
      firstName: result.firstName,
      lastName: result.lastName,
      role: result.principal.role,
    },
    csrfToken,
  })
})

authRouter.post('/staff/detach', (_req, res) => {
  // Clears the person, leaves the device paired — the register returns to its
  // between-shifts state rather than needing to be re-enrolled.
  res.clearCookie(COOKIE.ACCESS, { path: '/' })
  res.status(204).end()
})

// --- step-up ---------------------------------------------------------------------------

const stepUpSchema = z
  .object({
    action: z.enum(CAPABILITIES),
    pin: z.string().regex(/^\d{4,6}$/).optional(),
    email: z.email().optional(),
    password: z.string().min(1).optional(),
  })
  .refine((v) => v.pin !== undefined || (v.email !== undefined && v.password !== undefined), {
    message: 'Provide either a PIN or an email and password.',
  })

authRouter.post('/step-up', loginLimiter, validateBody(stepUpSchema), async (req, res) => {
  const body = req.body as z.infer<typeof stepUpSchema>
  const principal = req.principal

  const grant = await authorize({
    action: body.action,
    terminalId: principal?.terminalId ?? null,
    ...(body.pin === undefined ? {} : { pin: body.pin }),
    ...(body.email === undefined ? {} : { email: body.email }),
    ...(body.password === undefined ? {} : { password: body.password }),
  })

  res.json(grant)
})

// --- who am I --------------------------------------------------------------------------

/**
 * Who is calling, and who they are.
 *
 * Two objects, not one. `principal` answers "what may this request do" and stays an
 * id-only authorization type; `user` answers "whose name goes in the corner of the screen"
 * and is null for a bare terminal, which has nobody attached. Merging them would put
 * presentation data on the type every service authorises against.
 *
 * The select is explicit and narrow: no `passwordHash`, no `pinHash`, no `pinLookup`. A
 * bare `findUnique` without a select would return all three.
 */
authRouter.get('/me', async (req, res) => {
  const principal = requirePrincipal(req)
  const userId = actingUserId(principal)

  const [user, terminal] = await Promise.all([
    userId === null
      ? null
      : prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, firstName: true, lastName: true, email: true, role: true },
        }),
    // WHERE the session is, by name. Null for a desk session — the register surfaces
    // render this so a mis-paired machine is visible at a glance, not just at pairing.
    principal.terminalId === null
      ? null
      : prisma.terminal.findUnique({
          where: { id: principal.terminalId },
          select: { id: true, name: true, store: { select: { id: true, name: true } } },
        }),
  ])

  res.json({ principal, user, terminal })
})
