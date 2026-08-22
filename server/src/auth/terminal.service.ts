import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError, UnauthorizedError } from '../errors/index.js'
import { normalizePairingCode, pairingCode, randomToken, sha256 } from '../lib/crypto.js'
import type { TerminalPrincipal } from './principal.js'

/**
 * Terminal enrolment.
 *
 * An admin creates a terminal and generates a short one-time code; staff type that code
 * into the new register, which exchanges it for a long-lived device token. This exists so
 * the long-lived secret never has to be copied through a clipboard or a chat message —
 * the thing that travels is short, expiring and single-use.
 */

export const PAIRING_CODE_TTL_MINUTES = 10

export interface CreatedPairingCode {
  /** Shown ONCE. Never stored — only its hash is. */
  readonly code: string
  readonly expiresAt: Date
}

export async function createPairingCode(
  terminalId: string,
  createdById: string,
): Promise<CreatedPairingCode> {
  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal) throw new NotFoundError('Terminal not found.')
  if (!terminal.active) throw new ConflictError('That terminal is deactivated.')

  const code = pairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60 * 1000)

  // Invalidate any outstanding codes for this terminal — generating a new one should
  // make the old one useless, or a code read aloud yesterday still works today.
  await prisma.terminalPairingCode.updateMany({
    where: { terminalId, usedAt: null },
    data: { usedAt: new Date() },
  })

  await prisma.terminalPairingCode.create({
    data: {
      terminalId,
      codeHash: sha256(normalizePairingCode(code)),
      expiresAt,
      createdById,
    },
  })

  return { code, expiresAt }
}

export interface PairedTerminal {
  /** Returned once; stored only as a SHA-256. */
  readonly deviceToken: string
  readonly terminalId: string
  readonly terminalName: string
  readonly storeId: string
  readonly storeName: string
}

/**
 * Exchange a pairing code for a device token.
 *
 * Single-use is enforced with a conditional update rather than a read-then-write, so two
 * simultaneous redemptions cannot both succeed.
 */
export async function redeemPairingCode(rawCode: string): Promise<PairedTerminal> {
  const codeHash = sha256(normalizePairingCode(rawCode))

  const record = await prisma.terminalPairingCode.findUnique({
    where: { codeHash },
    include: { terminal: { include: { store: true } } },
  })

  // One generic error for every failure mode — unknown, already used, expired, or a
  // deactivated terminal. Telling a caller that a code exists but is expired confirms
  // the code space to someone guessing.
  const INVALID = 'That pairing code is not valid.'

  if (!record || record.usedAt !== null || record.expiresAt <= new Date()) {
    throw new UnauthorizedError(INVALID)
  }
  if (!record.terminal.active) throw new UnauthorizedError(INVALID)

  // Claim it with a conditional update rather than a read-then-write, so two
  // simultaneous redemptions cannot both succeed.
  const claimed = await prisma.terminalPairingCode.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  if (claimed.count !== 1) throw new UnauthorizedError(INVALID)

  const deviceToken = randomToken(48)
  await prisma.terminal.update({
    where: { id: record.terminalId },
    data: { tokenHash: sha256(deviceToken), lastSeenAt: new Date() },
  })

  return {
    deviceToken,
    terminalId: record.terminal.id,
    terminalName: record.terminal.name,
    storeId: record.terminal.storeId,
    storeName: record.terminal.store.name,
  }
}

/** Resolve a device token to a terminal principal. Returns null for any failure. */
export async function principalFromDeviceToken(
  token: string,
): Promise<TerminalPrincipal | null> {
  const terminal = await prisma.terminal.findUnique({
    where: { tokenHash: sha256(token) },
  })
  if (!terminal || !terminal.active) return null

  return {
    kind: 'terminal',
    userId: null,
    role: null,
    storeId: terminal.storeId,
    terminalId: terminal.id,
  }
}

/**
 * Touch `lastSeenAt`, fire-and-forget.
 *
 * Deliberately not awaited by callers and errors are swallowed: a heartbeat write must
 * never be the reason a sale fails.
 */
export function touchTerminal(terminalId: string): void {
  void prisma.terminal
    .update({ where: { id: terminalId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined)
}

// --- terminal administration (the Registers back-office screen) ---------------------------

const terminalSelect = {
  id: true,
  name: true,
  active: true,
  lastSeenAt: true,
  createdAt: true,
  store: { select: { id: true, name: true } },
} as const

export async function listTerminals() {
  return prisma.terminal.findMany({
    select: terminalSelect,
    orderBy: [{ store: { name: 'asc' } }, { name: 'asc' }],
  })
}

/**
 * Create a terminal that has never paired.
 *
 * `tokenHash` is required and unique, so the row is seeded with the hash of a random
 * token that is immediately DISCARDED — nothing can present it, so the terminal is
 * unusable until a pairing code is redeemed (which rotates the hash, same as re-pairing).
 */
export async function createTerminal(name: string, storeId: string, createdById: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { active: true } })
  if (!store || !store.active) throw new NotFoundError('That store does not exist.')

  const terminal = await prisma.terminal.create({
    data: { name, storeId, tokenHash: sha256(randomToken(48)) },
    select: terminalSelect,
  })
  await prisma.auditLog.create({
    data: {
      userId: createdById,
      action: 'auth.terminal.create',
      entityType: 'Terminal',
      entityId: terminal.id,
      before: {},
      after: { name, storeId },
    },
  })
  return terminal
}

export interface TerminalPatch {
  readonly name?: string | undefined
  readonly active?: boolean | undefined
}

/**
 * Rename or (de)activate. Deactivation is the revocation switch — the device token stops
 * authenticating immediately — so it also voids any outstanding pairing codes: a code
 * generated before the deactivation must not quietly resurrect the terminal.
 */
export async function updateTerminal(id: string, patch: TerminalPatch, actorId: string) {
  const existing = await prisma.terminal.findUnique({
    where: { id },
    select: { id: true, name: true, active: true },
  })
  if (!existing) throw new NotFoundError('Terminal not found.')

  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) data['name'] = patch.name
  if (patch.active !== undefined) data['active'] = patch.active

  const updated = await prisma.terminal.update({ where: { id }, data, select: terminalSelect })

  if (patch.active === false) {
    await prisma.terminalPairingCode.updateMany({
      where: { terminalId: id, usedAt: null },
      data: { usedAt: new Date() },
    })
  }

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'auth.terminal.update',
      entityType: 'Terminal',
      entityId: id,
      before: {
        ...(patch.name !== undefined ? { name: existing.name } : {}),
        ...(patch.active !== undefined ? { active: existing.active } : {}),
      },
      after: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      },
    },
  })
  return updated
}
