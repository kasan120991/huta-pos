import type {
  CatalogPage,
  CatalogProduct,
  CatalogVariant,
  PurchaseOrderRow,
} from '@huta/shared/schemas'
import type { BaseQuantity, TrackingMode } from '@huta/shared'
import { formatGrams } from '@huta/shared'
import { dollars } from '~/lib/money'
import { lineValueCents, parseQty, parseUnitCost } from '~/lib/purchase-order-lines'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * The order being composed, headless.
 *
 * The conceptual flip that makes the two-pane screen cheap: today's composer holds an ARRAY
 * of lines and that array *is* the order. Here the supplier's catalogue is the list, and the
 * order is a sparse overlay on it — two maps keyed by variantId. The shelf and the order pane
 * bind the SAME maps, so there is no "add to order" action, no synchronisation, and no second
 * source of truth. Typing a quantity makes a line exist; clearing it makes it stop existing.
 *
 * The keyed-map shape is the house precedent from `register/transfers.vue` (`approvals` /
 * `counts`), for the same reason: a map over server-supplied rows means nothing has to be
 * pre-created, and an untouched row simply has no entry.
 */

/** One orderable row — a product/variant pair flattened out of the catalog payload. */
export interface ShelfRow {
  readonly variantId: string
  readonly productId: string
  readonly productName: string
  readonly label: string | null
  readonly name: string
  readonly sku: string
  readonly trackingMode: TrackingMode
  readonly categoryName: string
  readonly onHandBase: number
  readonly reorderBase: number | null
  readonly suggestedBase: number
  readonly lastCostCents: number | null
  /** Effective supplier: the variant's own overrides the product's. Null when neither has one. */
  readonly supplierId: string | null
  /**
   * True when this row is on the order but NOT on the chosen supplier's shelf — a draft line
   * whose product changed hands, or one added through the scope escape. Pinned to the top and
   * never silently dropped: PATCH replaces every line, so dropping one deletes it.
   */
  readonly orphan: boolean
}

export function usePurchaseOrderDraft() {
  /* ————— identity ————— */
  const orderId = ref<string | null>(null)
  const storeId = ref('')
  const supplierId = ref('')
  const expected = ref('')
  const notes = ref('')

  /* ————— the only mutable state ————— */
  const qty = ref<Record<string, string>>({})
  const cost = ref<Record<string, string>>({})
  /** Rows whose cost box the user has touched, so lazy prefill never overwrites a clear. */
  const costTouched = ref<Set<string>>(new Set())

  /* ————— the shelf ————— */
  const catalogRows = ref<ShelfRow[]>([])
  const orphanRows = ref<ShelfRow[]>([])
  const shelfLoading = ref(false)
  const loadError = ref<string | null>(null)
  /**
   * Every row ever rendered, by variantId.
   *
   * Load-bearing when the supplier changes: the keyed quantities survive that change (they are
   * still on the order), but the new shelf has no idea what those variants are. Without a
   * record of them they render nowhere, drop out of `lines`, and are silently deleted by the
   * next save — PATCH replaces every line.
   */
  const known = ref<Map<string, ShelfRow>>(new Map())
  /** Set when the supplier's catalogue is larger than one page could carry. */
  const truncated = ref(false)

  /** Orphans first — they are the rows that need a decision. */
  const shelf = computed<ShelfRow[]>(() => [...orphanRows.value, ...catalogRows.value])
  const byVariant = computed(() => new Map(shelf.value.map((row) => [row.variantId, row])))

  /* ————— derived order ————— */

  /**
   * The order: every shelf row carrying a parseable quantity, in shelf order.
   *
   * Shelf order rather than the order things were typed in, so the body is deterministic and
   * a re-save does not reshuffle the lines.
   */
  const lines = computed(() =>
    shelf.value
      .map((row) => ({ row, base: parseQty(qty.value[row.variantId], row.trackingMode) }))
      .filter((entry): entry is { row: ShelfRow, base: number } => entry.base !== null),
  )

  const valueCents = computed(() => {
    let sum = 0
    let any = false
    for (const { row } of lines.value) {
      const value = lineValueCents(row.trackingMode, qty.value[row.variantId], cost.value[row.variantId])
      if (value !== null) {
        sum += value
        any = true
      }
    }
    return any ? sum : null
  })

  /**
   * Rows the user has typed something unusable into.
   *
   * Reported as a count rather than just disabling Save, because with 41 boxes on screen
   * "Save is greyed out and I can't see why" is the actual failure mode.
   */
  const invalidRows = computed(() =>
    shelf.value.filter((row) => {
      const rawQty = (qty.value[row.variantId] ?? '').trim()
      if (rawQty !== '' && parseQty(rawQty, row.trackingMode) === null) return true
      return parseUnitCost(cost.value[row.variantId]) === 'invalid'
    }),
  )

  const valid = computed(
    () =>
      supplierId.value !== '' &&
      storeId.value !== '' &&
      lines.value.length >= 1 &&
      lines.value.length <= 200 &&
      invalidRows.value.length === 0,
  )

  /* ————— dirty tracking ————— */
  const baseline = ref('')
  const snapshot = () =>
    JSON.stringify({
      supplierId: supplierId.value,
      expected: expected.value,
      notes: notes.value,
      qty: qty.value,
      cost: cost.value,
    })
  const markClean = () => {
    baseline.value = snapshot()
  }
  const dirty = computed(() => snapshot() !== baseline.value)

  /* ————— cost prefill, lazily ————— */

  /**
   * Seed a row's cost from the last price paid the first time it is actually being ordered.
   *
   * Lazy rather than eager: 41 pre-filled dollar boxes read as fabricated data, and blank
   * cost is legal. Once a row is genuinely on the order, though, "six of these at the usual
   * price" should need no typing.
   */
  watch(
    () => lines.value.map((l) => l.row.variantId).join('|'),
    () => {
      for (const { row } of lines.value) {
        if (costTouched.value.has(row.variantId)) continue
        if ((cost.value[row.variantId] ?? '') !== '') continue
        if (row.lastCostCents == null) continue
        cost.value[row.variantId] = dollars(row.lastCostCents)
      }
    },
  )

  function touchCost(variantId: string) {
    costTouched.value.add(variantId)
  }

  /* ————— loading the shelf ————— */

  /** The catalog list ships every active variant of a matched product; work out whose it is. */
  function effectiveSupplierId(variant: CatalogVariant, product: CatalogProduct): string | null {
    return variant.supplierId ?? product.primarySupplier?.id ?? null
  }

  function toRow(variant: CatalogVariant, product: CatalogProduct, orphan: boolean): ShelfRow {
    const onHandBase = variant.stock.quantityBase
    const reorderBase = variant.stock.reorderBase
    return {
      variantId: variant.id,
      productId: product.id,
      productName: product.name,
      label: variant.label,
      name: variant.label && variant.label !== product.name ? `${product.name} · ${variant.label}` : product.name,
      sku: variant.sku,
      trackingMode: variant.trackingMode,
      categoryName: product.category.name,
      onHandBase,
      reorderBase,
      // A prompt, never a preselection. `reorderBase` sums the thresholds of the stores in
      // scope, and the seeded category defaults already put a large slice of the catalogue
      // below reorder — so this is worth showing and not worth trusting blindly.
      suggestedBase: reorderBase === null ? 0 : Math.max(0, reorderBase - onHandBase),
      // `costCents` is OMITTED, not nulled, for a principal without cost.view — so `in`,
      // never `!= null`. It is the last cost from whoever delivered last, which is a
      // reference figure and not a per-supplier price.
      lastCostCents: 'costCents' in variant ? (variant.costCents ?? null) : null,
      supplierId: effectiveSupplierId(variant, product),
      orphan,
    }
  }

  let shelfToken = 0

  /**
   * Fetch the chosen supplier's catalogue for the destination store.
   *
   * Store-scoped deliberately: on-hand and the reorder threshold must be the store the order
   * is going TO, not a rollup across every store.
   */
  async function loadShelf() {
    const supplier = supplierId.value
    const store = storeId.value
    if (!supplier || !store) {
      catalogRows.value = []
      return
    }
    const token = ++shelfToken
    shelfLoading.value = true
    loadError.value = null
    try {
      const page = await apiFetch<CatalogPage>('/catalog/products', {
        query: { supplierId: supplier, storeId: store, active: 'all', page: 1, pageSize: 100 },
      })
      if (token !== shelfToken) return
      const products = page.products as CatalogProduct[]
      catalogRows.value = products.flatMap((product) =>
        product.variants.map((variant) => toRow(variant, product, false)),
      )
      for (const row of catalogRows.value) known.value.set(row.variantId, row)
      truncated.value = page.total > products.length
      reconcileOrphans()
    } catch (err) {
      if (token !== shelfToken) return
      catalogRows.value = []
      loadError.value = err instanceof ApiError ? err.message : 'Could not load this supplier.'
    } finally {
      if (token === shelfToken) shelfLoading.value = false
    }
  }

  /**
   * Recompute the orphan band against the shelf that is now loaded.
   *
   * Both directions matter. A row that has drifted ONTO the shelf stops being an orphan; a row
   * that is still ordered but has fallen OFF it becomes one. The second half is what keeps a
   * supplier change from quietly deleting lines.
   */
  function reconcileOrphans() {
    const onShelf = new Set(catalogRows.value.map((r) => r.variantId))
    const keptOrphans = orphanRows.value.filter((row) => !onShelf.has(row.variantId))
    const seen = new Set(keptOrphans.map((r) => r.variantId))
    const stranded: ShelfRow[] = []
    for (const variantId of Object.keys(qty.value)) {
      if (onShelf.has(variantId) || seen.has(variantId)) continue
      if ((qty.value[variantId] ?? '').trim() === '') continue
      const row = known.value.get(variantId)
      // Stock figures came from a different supplier's context; the orphan band renders "—"
      // for them rather than a number that would invite reordering from the wrong supplier.
      if (row) stranded.push({ ...row, orphan: true, onHandBase: 0, reorderBase: null, suggestedBase: 0 })
    }
    orphanRows.value = [...keptOrphans, ...stranded]
  }

  /**
   * Pull one variant in from outside the supplier's shelf — the scope escape.
   *
   * Half the catalogue has no supplier at all, so without this those products could never be
   * ordered from this screen. The server only requires a supplier on the ORDER; its lines may
   * name any variant.
   */
  async function adoptVariant(variantId: string, productId: string) {
    if (byVariant.value.has(variantId)) return
    try {
      const product = await apiFetch<CatalogProduct>(`/catalog/products/${productId}`, {
        query: { storeId: storeId.value },
      })
      const variant = product.variants.find((v) => v.id === variantId)
      if (!variant) return
      const adopted = toRow(variant, product, true)
      known.value.set(adopted.variantId, adopted)
      orphanRows.value = [...orphanRows.value, adopted]
    } catch {
      /* The picker simply does not add it; the shelf is unchanged. */
    }
  }

  function removeRow(variantId: string) {
    delete qty.value[variantId]
    delete cost.value[variantId]
    orphanRows.value = orphanRows.value.filter((row) => row.variantId !== variantId)
  }

  /* ————— seeding from an existing draft ————— */

  /**
   * Rehydrate from a draft, then reconcile it against the shelf.
   *
   * Order matters: the order is authoritative about what was asked for, the shelf only about
   * what this supplier sells. Any line the shelf cannot account for becomes an orphan rather
   * than disappearing — PATCH deletes and recreates every line, so a dropped row is a deleted
   * row, and this is not an edge case (a draft's supplier is editable, and a product's
   * supplier can change under it).
   */
  async function seed(order: PurchaseOrderRow) {
    orderId.value = order.id
    storeId.value = order.storeId
    supplierId.value = order.supplierId
    expected.value = order.expectedAt ? order.expectedAt.slice(0, 10) : ''
    notes.value = order.notes ?? ''

    const nextQty: Record<string, string> = {}
    const nextCost: Record<string, string> = {}
    for (const line of order.lines) {
      nextQty[line.variantId] =
        line.trackingMode === 'WEIGHT'
          ? formatGrams(line.quantityBase as BaseQuantity, { suffix: false })
          : String(line.quantityBase)
      if (line.unitCostCents != null) nextCost[line.variantId] = dollars(line.unitCostCents)
    }
    qty.value = nextQty
    cost.value = nextCost
    // Every seeded cost came off the order itself, so none of them may be overwritten by the
    // lazy prefill.
    costTouched.value = new Set(Object.keys(nextCost))

    await loadShelf()

    // Built straight from the order line rather than refetched. A line carries no productId,
    // and there is no variant-to-product lookup — but the row already holds everything needed
    // to render it and send it back, which is all an orphan has to do. Its stock is left
    // blank on purpose: it is not on this supplier's shelf, so a stock figure here would
    // invite reordering it from the wrong supplier.
    const onShelf = new Set(catalogRows.value.map((r) => r.variantId))
    orphanRows.value = order.lines
      .filter((line) => !onShelf.has(line.variantId))
      .map((line) => ({
        variantId: line.variantId,
        productId: '',
        productName: line.productName,
        label: line.label,
        name:
          line.label && line.label !== line.productName
            ? `${line.productName} · ${line.label}`
            : line.productName,
        sku: line.sku,
        trackingMode: line.trackingMode as TrackingMode,
        categoryName: '',
        onHandBase: 0,
        reorderBase: null,
        suggestedBase: 0,
        lastCostCents: null,
        supplierId: null,
        orphan: true,
      }))
    for (const row of orphanRows.value) known.value.set(row.variantId, row)

    markClean()
  }

  function startNew(defaultStoreId: string) {
    known.value = new Map()
    orderId.value = null
    storeId.value = defaultStoreId
    supplierId.value = ''
    expected.value = ''
    notes.value = ''
    qty.value = {}
    cost.value = {}
    costTouched.value = new Set()
    catalogRows.value = []
    orphanRows.value = []
    markClean()
  }

  /* ————— saving ————— */

  /** Noon UTC dodges the date-boundary drift a bare midnight date invites. */
  const expectedIso = () =>
    expected.value ? new Date(`${expected.value}T12:00:00Z`).toISOString() : null

  function body() {
    // Dedupe defensively: keys are variantIds so a repeat is structurally impossible, but the
    // server THROWS on a duplicate rather than dropping it, and that is a 500-shaped surprise
    // for something the client can simply not send.
    const seen = new Set<string>()
    const out: Array<{ variantId: string, quantityBase: number, unitCostCents?: number }> = []
    for (const { row, base } of lines.value) {
      if (seen.has(row.variantId)) continue
      seen.add(row.variantId)
      const unit = parseUnitCost(cost.value[row.variantId])
      out.push({
        variantId: row.variantId,
        quantityBase: base,
        ...(unit !== null && unit !== 'invalid' ? { unitCostCents: unit } : {}),
      })
    }
    return {
      supplierId: supplierId.value,
      expectedAt: expectedIso(),
      notes: notes.value.trim() || null,
      lines: out,
    }
  }

  const saving = ref(false)
  const actionError = ref<string | null>(null)

  /** Returns the saved order, or null when the save failed. */
  async function save(): Promise<PurchaseOrderRow | null> {
    if (!valid.value || saving.value) return null
    saving.value = true
    actionError.value = null
    try {
      const saved = orderId.value
        ? await apiFetch<PurchaseOrderRow>(`/purchase-orders/${orderId.value}`, {
            method: 'PATCH',
            body: body(),
          })
        : await apiFetch<PurchaseOrderRow>('/purchase-orders', {
            method: 'POST',
            body: { storeId: storeId.value, ...body() },
          })
      orderId.value = saved.id
      markClean()
      return saved
    } catch (err) {
      actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
      return null
    } finally {
      saving.value = false
    }
  }

  /** Save first — placing mints the number against whatever is stored, not what is on screen. */
  async function place(): Promise<PurchaseOrderRow | null> {
    const saved = await save()
    if (!saved) return null
    saving.value = true
    actionError.value = null
    try {
      return await apiFetch<PurchaseOrderRow>(`/purchase-orders/${saved.id}/place`, { method: 'POST' })
    } catch (err) {
      actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
      return null
    } finally {
      saving.value = false
    }
  }

  return {
    orderId,
    storeId,
    supplierId,
    expected,
    notes,
    qty,
    cost,
    touchCost,
    shelf,
    catalogRows,
    orphanRows,
    shelfLoading,
    loadError,
    truncated,
    lines,
    valueCents,
    invalidRows,
    valid,
    dirty,
    saving,
    actionError,
    loadShelf,
    adoptVariant,
    removeRow,
    seed,
    startNew,
    save,
    place,
  }
}
