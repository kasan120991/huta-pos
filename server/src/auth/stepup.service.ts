import { Role } from '@huta/shared'

import { prisma } from '../db/client.js'
import { ForbiddenError, UnauthorizedError } from '../errors/index.js'
import { pinLookup } from '../lib/crypto.js'
import { verifySecret } from '../lib/password.js'
import { STEP_UP_TTL_SECONDS } from '../lib/tokens.js'
import type { Capability } from './permissions.js'

/**
 * Step-up authorisation — the "manager comes over and approves it" gesture.
 *
 * Generic on purpose: refunds, price overrides and stock adjustments all consume the
 * same mechanism. A grant authorises ONE action once, within two minutes; it is not a
 * general elevation, so an admin approving a refund cannot be replayed to adjust stock.
 *
 * The record is also the audit trail — who approved what, where, and when — which is the
 * actual reason step-up exists rather than simply letting staff proceed.
 */

export interface StepUpRequest {
  readonly action: Capability
  readonly terminalId: string | null
  /** An admin may authorise with either a PIN (fast at the counter) or a password. */
  readonly pin?: string
  readonly email?: string
  readonly password?: string
}

export async function authorize(request: StepUpRequest): Promise<{ grantId: string }> {
  const admin = request.pin
    ? await findAdminByPin(request.pin)
    : await findAdminByPassword(request.email, request.password)

  if (!admin) throw new UnauthorizedError('Those credentials were not recognised.')

  const grant = await prisma.stepUpGrant.create({
    data: {
      adminUserId: admin.id,
      action: request.action,
      expiresAt: new Date(Date.now() + STEP_UP_TTL_SECONDS * 1000),
      ...(request.terminalId === null ? {} : { terminalId: request.terminalId }),
    },
  })

  return { grantId: grant.id }
}

async function findAdminByPin(pin: string): Promise<{ id: string } | null> {
  const user = await prisma.user.findUnique({ where: { pinLookup: pinLookup(pin) } })
  if (!user || user.role !== Role.ADMIN || !user.active || !user.pinHash) return null
  if (user.lockedUntil && user.lockedUntil > new Date()) return null
  return (await verifySecret(user.pinHash, pin)) ? { id: user.id } : null
}

async function findAdminByPassword(
  email: string | undefined,
  password: string | undefined,
): Promise<{ id: string } | null> {
  if (!email || !password) return null
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || user.role !== Role.ADMIN || !user.active || !user.passwordHash) return null
  return (await verifySecret(user.passwordHash, password)) ? { id: user.id } : null
}

/**
 * Consume a grant for a specific action.
 *
 * Single-use is enforced by a conditional update, so two concurrent requests cannot both
 * spend the same approval. Returns the approving admin's id so the caller can record who
 * authorised the operation on the resulting sale, refund or movement.
 */
export async function consume(
  grantId: string,
  action: Capability,
): Promise<{ approvedByUserId: string }> {
  const grant = await prisma.stepUpGrant.findUnique({ where: { id: grantId } })

  if (
    !grant ||
    grant.consumedAt !== null ||
    grant.expiresAt <= new Date() ||
    grant.action !== action
  ) {
    throw new ForbiddenError('That authorisation is no longer valid.')
  }

  const claimed = await prisma.stepUpGrant.updateMany({
    where: { id: grantId, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (claimed.count !== 1) {
    throw new ForbiddenError('That authorisation is no longer valid.')
  }

  return { approvedByUserId: grant.adminUserId }
}
