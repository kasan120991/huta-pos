import { AsyncLocalStorage } from 'node:async_hooks'

import type { NextFunction, Request, Response } from 'express'

import { emitToAdmin, emitToStore } from './emitter.js'

/**
 * Where `stock.changed` is emitted from, and why it is not emitted where the stock changes.
 *
 * Every stock change funnels through `applyMovement`, so that is the only place the emit can
 * be complete BY CONSTRUCTION. Hand-placing it per call site is what the system did before,
 * and it produced exactly the gaps you would predict: sales, refunds and transfers emitted,
 * while **receiving, adjustments and reconcile emitted nothing at all** — a delivery posted
 * stock and no screen ever heard about it.
 *
 * ⚠️ The obstacle is that `applyMovement` ENLISTS in a caller's transaction (`tx?: Db`), so
 * it cannot know when that transaction commits — and the house rules are explicit that an emit
 * happens after the commit, never inside it. Announcing a change a rollback erased is the
 * failure mode that rule exists to prevent.
 *
 * So the movement RECORDS its change into an ambient collector, and the collector is scoped
 * to the REQUEST rather than to any one transaction: `stockEventScope` flushes once the
 * response has been sent, by which point every transaction the request opened has resolved.
 * Scoping it to the request rather than wrapping nine call sites is the whole point — a
 * service added later is live without anyone remembering to opt it in, which is the class of
 * bug this module exists to end. A few milliseconds' delay past the commit costs nothing,
 * because the payload is only ever a hint to refetch.
 *
 * Events are collected as a SET, so a nine-line delivery touching one variant emits once
 * rather than nine times.
 */

/** `${storeId} ${variantId}` — a Set of these dedupes a multi-line movement. */
type ChangeKey = string

const collector = new AsyncLocalStorage<Set<ChangeKey>>()

const keyOf = (storeId: string, variantId: string): ChangeKey => `${storeId} ${variantId}`

/**
 * Express middleware: give the request a collector, and flush it once the response is out.
 *
 * Mount it ABOVE the routers and below nothing that matters — it only needs to wrap the
 * handlers that can move stock, and wrapping all of them is simpler than deciding which.
 *
 * ⚠️ Flushes on SUCCESS ONLY. A 4xx/5xx means the service threw, which means its transaction
 * rolled back, so anything sitting in the bag describes a change that no longer exists.
 * Staying silent there is the conservative half of the trade: the cost of a missed event is
 * one stale screen until the next refetch, and every consumer refetches on reconnect anyway.
 */
export function stockEventScope(req: Request, res: Response, next: NextFunction): void {
  const bag = new Set<ChangeKey>()

  res.on('finish', () => {
    if (res.statusCode >= 400) return
    flush(bag)
  })

  collector.run(bag, () => {
    next()
  })
}

/**
 * Run `fn` with a collector in scope and flush after it resolves.
 *
 * The non-HTTP entry point — scripts, and any future job runner. Nesting joins the outer
 * collector rather than flushing early, so this is safe to use inside a request too.
 */
export async function withStockEvents<T>(fn: () => Promise<T>): Promise<T> {
  if (collector.getStore()) return fn()

  const bag = new Set<ChangeKey>()
  const result = await collector.run(bag, fn)
  flush(bag)
  return result
}

/**
 * Record one variant's stock as changed at one store. Called by `applyMovement` only.
 *
 * With a collector in scope the event is buffered until the flush. Without one it goes out
 * immediately — which is the correct and only behaviour outside a request, and is what the
 * integration suites exercise (where the emitter is a no-op because no io was ever injected).
 */
export function recordStockChange(storeId: string, variantId: string): void {
  const bag = collector.getStore()
  if (bag) {
    bag.add(keyOf(storeId, variantId))
    return
  }
  emitStockChanged(storeId, variantId)
}

function flush(bag: Set<ChangeKey>): void {
  for (const key of bag) {
    const [storeId, variantId] = key.split(' ')
    if (storeId === undefined || variantId === undefined) continue
    emitStockChanged(storeId, variantId)
  }
  bag.clear()
}

/**
 * BOTH rooms, always.
 *
 * The store room is the counter, whose catalog badges mean "out HERE". The admin room is the
 * back office, whose catalog and product workspace render the same quantities across every
 * store. Sales and refunds used to emit to the store only, so the back office could not go
 * live even in principle; transfers already emitted to both. That asymmetry was invisible
 * until something tried to consume it.
 */
function emitStockChanged(storeId: string, variantId: string): void {
  const event = { name: 'stock.changed', payload: { storeId, variantId } } as const
  emitToStore(storeId, event)
  emitToAdmin(event)
}

/** Test hook — how many changes the current scope has buffered. */
export function bufferedStockChanges(): number {
  return collector.getStore()?.size ?? 0
}
