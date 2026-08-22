import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app.js'
import {
  createPairingCode,
  createTerminal,
  listTerminals,
  principalFromDeviceToken,
  redeemPairingCode,
  updateTerminal,
} from '../../src/auth/terminal.service.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, NotFoundError } from '../../src/errors/index.js'
import { makeAdmin, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'

/**
 * Terminal administration — the Registers back-office screen's server half.
 *
 * Deactivation is the revocation switch, so the tests prove revocation both ways: the
 * device token stops authenticating AND an outstanding pairing code dies with it.
 */

let store: { id: string }
let adminUser: { id: string }

beforeEach(async () => {
  await resetDatabase()
  store = await makeStore('Store A', 'store-a')
  adminUser = await makeAdmin()
})

describe('terminal administration', () => {
  it('creates a terminal that cannot authenticate until paired, and lists it', async () => {
    const created = await createTerminal('Register 2', store.id, adminUser.id)
    expect(created).toMatchObject({ name: 'Register 2', active: true, lastSeenAt: null })
    expect(created.store).toMatchObject({ id: store.id })

    const rows = await listTerminals()
    expect(rows.map((t) => t.name)).toContain('Register 2')

    // Born with a discarded token hash — nothing can present it.
    const row = await prisma.terminal.findUnique({ where: { id: created.id } })
    expect(row!.tokenHash).toHaveLength(64)

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.terminal.create', entityId: created.id },
    })
    expect(audit!.after).toMatchObject({ name: 'Register 2', storeId: store.id })

    // Pair it for real: the generated code redeems into a working device token.
    const issued = await createPairingCode(created.id, adminUser.id)
    const paired = await redeemPairingCode(issued.code)
    const principal = await principalFromDeviceToken(paired.deviceToken)
    expect(principal).toMatchObject({ kind: 'terminal', terminalId: created.id, storeId: store.id })
  })

  it('refuses an unknown store and an unknown terminal', async () => {
    await expect(createTerminal('Nope', 'st-missing', adminUser.id)).rejects.toThrow(NotFoundError)
    await expect(updateTerminal('t-missing', { name: 'X' }, adminUser.id)).rejects.toThrow(NotFoundError)
  })

  it('renames with an audit of only the changed keys', async () => {
    const created = await createTerminal('Register 2', store.id, adminUser.id)
    const updated = await updateTerminal(created.id, { name: 'Front Counter' }, adminUser.id)
    expect(updated.name).toBe('Front Counter')

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.terminal.update', entityId: created.id },
    })
    expect(audit!.before).toMatchObject({ name: 'Register 2' })
    expect(audit!.after).toMatchObject({ name: 'Front Counter' })
    expect(audit!.before).not.toHaveProperty('active')
  })

  it('deactivation revokes the device token AND voids outstanding pairing codes', async () => {
    const token = 'terminals-test-device-token'
    const terminal = await makeTerminal(store.id, token)

    // A live code exists when the terminal is pulled from service…
    const issued = await createPairingCode(terminal.id, adminUser.id)

    await updateTerminal(terminal.id, { active: false }, adminUser.id)

    // …the device stops authenticating immediately…
    expect(await principalFromDeviceToken(token)).toBeNull()
    // …and the code must not quietly resurrect it.
    await expect(redeemPairingCode(issued.code)).rejects.toThrow()

    // A deactivated terminal also refuses new codes (existing rule, re-pinned here).
    await expect(createPairingCode(terminal.id, adminUser.id)).rejects.toThrow(ConflictError)

    // Reactivation restores the device token — deactivation is a switch, not a wipe.
    await updateTerminal(terminal.id, { active: true }, adminUser.id)
    expect(await principalFromDeviceToken(token)).toMatchObject({ terminalId: terminal.id })
  })

  it('refuses every terminal-admin endpoint without an admin session', async () => {
    const app = createApp()
    const terminal = await makeTerminal(store.id, 'terminals-test-guard-token')

    const attempts = [
      request(app).get('/api/auth/terminals'),
      request(app).post('/api/auth/terminals').send({ name: 'Nope', storeId: store.id }),
      request(app).patch(`/api/auth/terminals/${terminal.id}`).send({ active: false }),
    ]
    for (const attempt of attempts) {
      const res = await attempt
      expect(res.status).toBe(401)
    }
    const untouched = await prisma.terminal.findUnique({ where: { id: terminal.id } })
    expect(untouched!.active).toBe(true)
  })
})
