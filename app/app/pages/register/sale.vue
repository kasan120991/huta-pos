<script setup lang="ts">
import type {
  CatalogPage,
  CatalogProduct,
  CatalogProductDetail,
  CatalogReference,
  CatalogVariant,
  ManualDiscountInput,
  Quote,
  QuotedLine,
  SaleIntentResult,
  SaleReceipt,
  ShiftRow,
  TenderInput,
} from '@huta/shared/schemas'
import type { Stripe, StripeElements } from '@stripe/stripe-js'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import {
  formatCents,
  formatQuantity,
  parseDollarsToCents,
  parseGramsToBase,
} from '@huta/shared'
import { Banknote, CreditCard, LogOut, Minus, Percent, Plus, Search, SearchX, ShoppingCart, X } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Toggle } from '~/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { ApiError, apiFetch } from '~/composables/useApi'
import { getStripe, paymentsConfig } from '~/composables/useStripe'
import { useTimeclock } from '~/composables/useTimeclock'
import { useAuthStore } from '~/stores/auth'

/**
 * The sale workstation.
 *
 * Money on this screen is RENDERED, never computed: every figure in the cart panel comes
 * from the server's quote (which carries checkout's exact tax math), and the charge comes
 * from checkout itself. The one subtraction the client does — the change preview — is
 * display convenience over two server numbers, and the server recomputes it anyway.
 */
definePageMeta({ layout: 'register' })

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

/**
 * Shared with the home tile — one piece of state, so the two cannot disagree.
 *
 * The nudge below is the only clock affordance on this screen: it appears when they are
 * clocked OUT and lets them fix that. There is deliberately no clocked-IN indicator here,
 * because the persistent top-bar pill was removed (Kasan, 2026-08-22) — clocking OUT is done
 * from the register home.
 */
const clock = useTimeclock()

/* ————— guard + shift gate ————— */
const shift = ref<ShiftRow | null>(null)
const booted = ref(false)

onMounted(async () => {
  void clock.refresh()
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) return router.replace('/register/pair')
  if (auth.isUnattendedTerminal) return router.replace('/register/sign-in')
  if (!auth.isAtTerminal) return router.replace('/')

  const data = await apiFetch<{ shift: ShiftRow | null }>('/shifts/current', {
    query: { storeId: auth.terminal?.store.id },
  })
  if (!data.shift) return router.replace('/register/shift')
  shift.value = data.shift
  booted.value = true

  reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  await loadProducts()
  focusSearch()

  // The catalog's Ring-it-up handoff: ?add=<variantId>&product=<productId> drops the
  // variant into the cart on arrival, then the query is cleared so a reload is clean.
  const addVariantId = route.query['add']
  const addProductId = route.query['product']
  if (typeof addVariantId === 'string' && typeof addProductId === 'string') {
    try {
      const product = await apiFetch<CatalogProductDetail>(`/catalog/products/${addProductId}`)
      const variant = product.variants.find((v) => v.id === addVariantId)
      if (variant) addToCart(product, variant)
    } catch {
      // An unknown product just leaves the cart empty — nothing to recover.
    }
    void router.replace({ path: '/register/sale' })
  }

  // A null publishable key means Stripe is not configured — Card stays disabled.
  paymentsConfig()
    .then((config) => (cardAvailable.value = config.publishableKey !== null))
    .catch(() => {})
})

/* ————— clock ————— */
const now = ref(new Date())
let clockTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clockTimer = setInterval(() => (now.value = new Date()), 30_000)
})
onUnmounted(() => clearInterval(clockTimer))
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

async function signOut() {
  await auth.detach()
  await router.replace('/register/sign-in')
}

/* ————— browse: categories + products ————— */
const reference = ref<CatalogReference | null>(null)
const categoryId = ref<string | null>(null)
const parents = computed(() =>
  (reference.value?.categories ?? []).filter((c) => c.parentId === null),
)

interface Card {
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly trackingMode: TrackingMode
  readonly priceText: string
  readonly stockStatus: string
  readonly needsAge: boolean
  readonly imageUrl: string | null
}

const cards = ref<Card[]>([])
const loadingProducts = ref(false)
const term = ref('')
const searchInput = ref<{ focus: () => void } | null>(null)

function focusSearch() {
  void nextTick(() => searchInput.value?.focus())
}

function priceText(variant: CatalogVariant): string {
  if (variant.trackingMode === 'WEIGHT') {
    const rate = variant.priceGroup?.basePricePerGramCents
    return rate != null ? `${formatCents(rate as Cents)}/g` : '—'
  }
  return variant.priceCents != null ? formatCents(variant.priceCents as Cents) : '—'
}

function toCards(products: readonly CatalogProduct[]): Card[] {
  return products.flatMap((product) =>
    product.variants.map((variant) => ({
      variantId: variant.id,
      productName: product.name,
      label: variant.label,
      trackingMode: variant.trackingMode,
      priceText: priceText(variant),
      stockStatus: variant.stock.status,
      needsAge: product.cannabinoids.length > 0,
      imageUrl: product.imageUrl,
    })),
  )
}

/** Selling view: in-stock only by default — an Out card is a dead tap at the counter. */
const showAll = ref(false)

async function loadProducts() {
  loadingProducts.value = true
  try {
    const q = term.value.trim()
    const page = await apiFetch<CatalogPage>('/catalog/products', {
      query: {
        ...(q.length >= 2 ? { search: q } : {}),
        ...(categoryId.value ? { categories: [categoryId.value] } : {}),
        ...(auth.terminal ? { storeId: auth.terminal.store.id } : {}),
        // A SCAN bypasses the stock filter — a barcode must always resolve, and the
        // oversell guard is what protects checkout, not the browse grid.
        ...(showAll.value || looksScanned(q) ? {} : { stock: 'on-hand' }),
        page: 1,
        pageSize: 24,
      },
    })
    const products = page.products as CatalogProduct[]
    // The server's stock filter is PRODUCT-level; the grid is variant cards, so an Out
    // variant of an otherwise-stocked product would still slip through without this.
    const all = toCards(products)
    cards.value =
      showAll.value || looksScanned(q) ? all : all.filter((c) => c.stockStatus !== 'OUT')

    // A scan yields exactly one variant — add it straight to the cart.
    const flat = products.flatMap((p) => p.variants.map((v) => ({ product: p, variant: v })))
    if (flat.length === 1 && looksScanned(q)) {
      addToCart(flat[0]!.product, flat[0]!.variant)
      term.value = ''
      await loadProducts()
    }
  } finally {
    loadingProducts.value = false
  }
}

const looksScanned = (q: string) => /^\d{6,}$/.test(q)

/* ————— camera scanning (C: a drop-down panel, CONTINUOUS — hits land as you go) ————— */
const scannerOpen = ref(false)
const scannerFeedback = ref<{ seq: number, text: string } | null>(null)
let feedbackSeq = 0
const toastScanner = (text: string) => (scannerFeedback.value = { seq: ++feedbackSeq, text })

async function onCameraScanned(code: string) {
  try {
    const page = await apiFetch<CatalogPage>('/catalog/products', {
      query: {
        search: code,
        pageSize: 8,
        ...(auth.terminal ? { storeId: auth.terminal.store.id } : {}),
      },
    })
    const flat = (page.products as CatalogProduct[]).flatMap((p) =>
      p.variants.map((v) => ({ product: p, variant: v })),
    )
    if (flat.length === 1) {
      const { product, variant } = flat[0]!
      addToCart(product, variant)
      const line = cart.value.find((l) => l.variantId === variant.id)
      const name =
        variant.label && variant.label !== product.name
          ? `${product.name} · ${variant.label}`
          : product.name
      toastScanner(
        variant.trackingMode === 'EACH'
          ? `✓ ${name} ×${line?.quantity || 1}`
          : `✓ ${name} — key the grams`,
      )
    } else {
      toastScanner(flat.length ? 'Several matches — search by name' : 'No match in the catalog')
    }
  } catch {
    toastScanner('Could not search the catalog')
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(term, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadProducts(), 200)
})
watch([categoryId, showAll], () => void loadProducts())

/** A scanner is a keyboard — keystrokes that land nowhere go to the search bar. */
function onWindowKeydown(event: KeyboardEvent) {
  // NOTE scannerOpen is deliberately absent — the drop-down camera is not modal, and
  // the page (search box included) stays live while it runs.
  if (
    receipt.value ||
    discountOpen.value ||
    customTenderOpen.value ||
    cardStep.value ||
    voidOpen.value ||
    stepUpOpen.value ||
    // The age pad reads the same digits a scanner would type.
    ageDialogOpen.value
  ) {
    return
  }
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    term.value += event.key
    focusSearch()
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))

/* ————— the cart ————— */
interface CartLine {
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly trackingMode: TrackingMode
  readonly needsAge: boolean
  /** Typed grams for WEIGHT, a whole count for EACH — a string, never a float. */
  quantity: string
  manualDiscount: ManualDiscountInput | null
}

const cart = ref<CartLine[]>([])
const orderDiscount = ref<ManualDiscountInput | null>(null)
const ageVerified = ref(false)
/** Shown on the button after a check. Local display only — never sent, never stored. */
const verifiedAge = ref<number | null>(null)
const ageDialogOpen = ref(false)
const ageError = ref(false)
const checkoutError = ref<string | null>(null)

function addToCart(product: CatalogProduct, variant: CatalogVariant) {
  checkoutError.value = null
  const existing = cart.value.find((l) => l.variantId === variant.id)
  if (existing) {
    if (existing.trackingMode === 'EACH') {
      existing.quantity = String((Number(existing.quantity) || 0) + 1)
    }
    return
  }
  cart.value.push({
    variantId: variant.id,
    productName: product.name,
    label: variant.label,
    trackingMode: variant.trackingMode,
    needsAge: product.cannabinoids.length > 0,
    quantity: variant.trackingMode === 'EACH' ? '1' : '',
    manualDiscount: null,
  })
}

function addCard(card: Card) {
  checkoutError.value = null
  const existing = cart.value.find((l) => l.variantId === card.variantId)
  if (existing) {
    if (existing.trackingMode === 'EACH') {
      existing.quantity = String((Number(existing.quantity) || 0) + 1)
    }
    return
  }
  cart.value.push({
    variantId: card.variantId,
    productName: card.productName,
    label: card.label,
    trackingMode: card.trackingMode,
    needsAge: card.needsAge,
    quantity: card.trackingMode === 'EACH' ? '1' : '',
    manualDiscount: null,
  })
}

function removeLine(variantId: string) {
  cart.value = cart.value.filter((l) => l.variantId !== variantId)
}

function clearCart() {
  cart.value = []
  orderDiscount.value = null
  ageVerified.value = false
  verifiedAge.value = null
  ageError.value = false
  checkoutError.value = null
  tenderedCents.value = null
  tenderMethod.value = 'CASH'
  splitCashStr.value = ''
  focusSearch()
}

function bump(line: CartLine, delta: number) {
  const next = (Number(line.quantity) || 0) + delta
  line.quantity = next > 0 ? String(next) : ''
}

/** Base units for one line, or null when what was typed is not usable yet. */
function baseOf(line: CartLine): number | null {
  const raw = line.quantity.trim()
  if (raw === '') return null
  if (line.trackingMode === 'WEIGHT') {
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

const cartComplete = computed(
  () => cart.value.length > 0 && cart.value.every((l) => baseOf(l) !== null),
)
const needsAge = computed(() => cart.value.some((l) => l.needsAge))

function openAgeDialog() {
  ageError.value = false
  ageDialogOpen.value = true
}

/**
 * The pad refuses to emit this for anyone under 21, so reaching here IS the attestation.
 * The date of birth stays in the dialog — only the flag and the cashier reach the server,
 * exactly as the old checkbox did.
 */
function onAgeConfirmed(age: number) {
  ageVerified.value = true
  verifiedAge.value = age
  ageError.value = false
  ageDialogOpen.value = false
}

const lineName = (l: { productName: string; label: string | null }) =>
  l.label && l.label !== l.productName ? `${l.productName} · ${l.label}` : l.productName

/* ————— the quote: every money figure on screen ————— */
const quote = ref<Quote | null>(null)
const quotePending = ref(false)
const quoteError = ref<string | null>(null)
let quoteTimer: ReturnType<typeof setTimeout> | undefined
let quoteSeq = 0

async function requestQuote() {
  const lines = cart.value
    .filter((l) => baseOf(l) !== null)
    .map((l) => ({
      variantId: l.variantId,
      quantityBase: baseOf(l)!,
      ...(l.manualDiscount ? { manualDiscount: l.manualDiscount } : {}),
    }))
  if (lines.length === 0) {
    quote.value = null
    quoteError.value = null
    quotePending.value = false
    return
  }
  const seq = ++quoteSeq
  quotePending.value = true
  try {
    const result = await apiFetch<Quote>('/pricing/quote', {
      method: 'POST',
      body: {
        lines,
        ...(orderDiscount.value ? { orderDiscount: orderDiscount.value } : {}),
        // An admin covering the counter has no store on their principal.
        ...(auth.principal?.kind === 'admin' && auth.terminal
          ? { storeId: auth.terminal.store.id }
          : {}),
      },
    })
    if (seq !== quoteSeq) return // a newer cart superseded this answer
    quote.value = result
    quoteError.value = null
  } catch (err) {
    if (seq !== quoteSeq) return
    quote.value = null
    quoteError.value = err instanceof ApiError ? err.message : 'Could not price the cart.'
  } finally {
    if (seq === quoteSeq) quotePending.value = false
  }
}

watch(
  [cart, orderDiscount],
  () => {
    // A checkout error describes the cart as it was — editing the cart retires it.
    checkoutError.value = null
    clearTimeout(quoteTimer)
    quoteTimer = setTimeout(() => void requestQuote(), 250)
  },
  { deep: true },
)

/** The quoted figures for one cart line. One line per variant, so the id is the key. */
const quotedByVariant = computed(() => {
  const map = new Map<string, QuotedLine>()
  for (const line of quote.value?.lines ?? []) map.set(line.variantId, line)
  return map
})

const fmt = (cents: number) => formatCents(cents as Cents)

/* ————— discounts ————— */
const discountOpen = ref(false)
/** 'order', or the variantId of the line being discounted. */
const discountTarget = ref<string>('order')
const discountType = ref<'PERCENT_OFF' | 'AMOUNT_OFF'>('PERCENT_OFF')
const discountValue = ref('')

const discountTargetLine = computed(() =>
  discountTarget.value === 'order'
    ? null
    : cart.value.find((l) => l.variantId === discountTarget.value) ?? null,
)

function openDiscount(target: string) {
  discountTarget.value = target
  const existing =
    target === 'order' ? orderDiscount.value : discountTargetLine.value?.manualDiscount
  discountType.value = existing?.discountType ?? 'PERCENT_OFF'
  discountValue.value = existing
    ? existing.discountType === 'PERCENT_OFF'
      ? String(existing.value / 100)
      : (existing.value / 100).toFixed(2)
    : ''
  discountOpen.value = true
}

function parsedDiscount(): ManualDiscountInput | null {
  const raw = discountValue.value.trim()
  if (raw === '') return null
  if (discountType.value === 'PERCENT_OFF') {
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
    const pct = Number(raw)
    if (pct <= 0 || pct > 100) return null
    return { discountType: 'PERCENT_OFF', value: Math.round(pct * 100) }
  }
  const parsed = parseDollarsToCents(raw)
  if (!parsed.ok || parsed.value <= 0) return null
  return { discountType: 'AMOUNT_OFF', value: parsed.value }
}

function applyDiscount() {
  const discount = parsedDiscount()
  if (!discount) return
  if (discountTarget.value === 'order') orderDiscount.value = discount
  else if (discountTargetLine.value) discountTargetLine.value.manualDiscount = discount
  discountOpen.value = false
}

function removeDiscount() {
  if (discountTarget.value === 'order') orderDiscount.value = null
  else if (discountTargetLine.value) discountTargetLine.value.manualDiscount = null
  discountOpen.value = false
}

/* ————— tender ————— */
/** How this sale gets paid. Cash is the everyday default; Card and Split need Stripe. */
const tenderMethod = ref<'CASH' | 'CARD' | 'SPLIT'>('CASH')
const cardAvailable = ref(false)
const tenderedCents = ref<number | null>(null)
const customTenderOpen = ref(false)
const customTenderStr = ref('')

/** The cash portion of a split, typed as dollars — the card takes the rest. */
const splitCashStr = ref('')
const splitCashCents = computed(() => {
  const parsed = parseDollarsToCents(splitCashStr.value.trim())
  return parsed.ok ? parsed.value : null
})
const splitValid = computed(() => {
  const total = quote.value?.totalCents
  return (
    total != null &&
    splitCashCents.value !== null &&
    splitCashCents.value > 0 &&
    splitCashCents.value < total
  )
})
/** What the card will be charged in the current mode, or null while it can't be known. */
const cardRestCents = computed(() => {
  const total = quote.value?.totalCents
  if (total == null || total <= 0) return null
  if (tenderMethod.value === 'CARD') return total
  if (tenderMethod.value === 'SPLIT' && splitValid.value) return total - splitCashCents.value!
  return null
})

/** Round `total` up to the next multiple of a bill, in cents. */
const nextBill = (total: number, bill: number) => Math.ceil(total / bill) * bill

const quickTenders = computed(() => {
  const total = quote.value?.totalCents
  if (total == null || total <= 0) return []
  const options = [
    { label: 'Exact', cents: total },
    { label: fmt(nextBill(total, 500)), cents: nextBill(total, 500) },
    { label: fmt(nextBill(total, 2000)), cents: nextBill(total, 2000) },
  ]
  // Collapse duplicates — an exact-multiple total makes "Exact" and a bill the same.
  const seen = new Set<number>()
  return options.filter((o) => !seen.has(o.cents) && seen.add(o.cents))
})

function applyCustomTender() {
  const parsed = parseDollarsToCents(customTenderStr.value.trim())
  if (!parsed.ok || parsed.value <= 0) return
  tenderedCents.value = parsed.value
  customTenderOpen.value = false
  customTenderStr.value = ''
}

const changeCents = computed(() => {
  const total = quote.value?.totalCents
  if (total == null || tenderedCents.value == null) return null
  return tenderedCents.value - total
})

/* ————— the card step: Stripe Elements takeover ————— */
const cardStep = ref(false)
const staging = ref(false)
const charging = ref(false)
const cardError = ref<string | null>(null)
const stagedIntent = ref<SaleIntentResult | null>(null)
const payElementHost = ref<HTMLElement | null>(null)
// Deliberately non-reactive: Stripe's objects are stateful class instances, and Vue
// proxying them breaks their internal identity checks.
let stripeInstance: Stripe | null = null
let stripeElements: StripeElements | null = null

/** Ready to hand the panel to the card — cart priced, age attested, nothing in flight. */
const cardBaseReady = computed(
  () =>
    cartComplete.value &&
    quote.value !== null &&
    !quotePending.value &&
    quoteError.value === null &&
    (!needsAge.value || ageVerified.value) &&
    !completing.value &&
    !staging.value,
)

async function enterCardStep() {
  if (!cardBaseReady.value || cardRestCents.value === null) return
  staging.value = true
  checkoutError.value = null
  cardError.value = null
  try {
    const stripe = await getStripe()
    if (!stripe) {
      checkoutError.value = 'Card payments are not configured on this register.'
      return
    }
    // The intent's amount comes from the SERVER's quote of this exact cart — the button
    // label was a preview of the same number, never its source.
    const staged = await apiFetch<SaleIntentResult>('/sales/intent', {
      method: 'POST',
      body: {
        lines: checkoutLines(),
        ...(orderDiscount.value ? { orderDiscount: orderDiscount.value } : {}),
        cashCents: tenderMethod.value === 'SPLIT' ? splitCashCents.value! : 0,
      },
    })
    stripeInstance = stripe
    stagedIntent.value = staged
    cardStep.value = true
    await nextTick()
    stripeElements = stripe.elements({
      clientSecret: staged.clientSecret,
      appearance: {
        theme: 'night',
        variables: { colorPrimary: '#22c55e', borderRadius: '10px' },
      },
    })
    stripeElements.create('payment', { layout: 'tabs' }).mount(payElementHost.value!)
  } catch (err) {
    checkoutError.value =
      err instanceof ApiError ? err.message : 'Could not start the card payment.'
  } finally {
    staging.value = false
  }
}

/** Back out of the card step. `cancelIntent: false` when the intent is already spent. */
function leaveCardStep(cancelIntent = true) {
  const staged = stagedIntent.value
  if (cancelIntent && staged) {
    void apiFetch(`/sales/intent/${staged.paymentIntentId}/cancel`, { method: 'POST' }).catch(
      () => {},
    )
  }
  stripeElements = null
  stripeInstance = null
  stagedIntent.value = null
  cardStep.value = false
  cardError.value = null
  charging.value = false
}

// Belt and braces: the takeover blocks cart edits, but if the total moves anyway the
// staged intent describes a sale that no longer exists.
watch(
  () => quote.value?.totalCents,
  (total) => {
    if (cardStep.value && stagedIntent.value && total !== stagedIntent.value.totalCents) {
      leaveCardStep(true)
      checkoutError.value = 'The cart changed — take the card again.'
    }
  },
)

async function chargeCard() {
  const staged = stagedIntent.value
  if (!stripeInstance || !stripeElements || !staged || charging.value) return
  charging.value = true
  cardError.value = null
  try {
    const result = await stripeInstance.confirmPayment({
      elements: stripeElements,
      redirect: 'if_required',
    })
    if (result.error) {
      // A decline stays IN the card step — staff retry or back out (which cancels).
      cardError.value = result.error.message ?? 'The card was declined.'
      return
    }
    const cashCents = staged.totalCents - staged.cardAmountCents
    await submitCheckout([
      ...(cashCents > 0 ? [{ method: 'CASH', tenderedCents: cashCents } as const] : []),
      { method: 'CARD', paymentIntentId: staged.paymentIntentId },
    ])
  } finally {
    charging.value = false
  }
}

/* ————— checkout ————— */
const completing = ref(false)
const receipt = ref<SaleReceipt | null>(null)

const canComplete = computed(
  () =>
    cartComplete.value &&
    quote.value !== null &&
    !quotePending.value &&
    quoteError.value === null &&
    tenderedCents.value !== null &&
    changeCents.value !== null &&
    changeCents.value >= 0 &&
    (!needsAge.value || ageVerified.value) &&
    !completing.value,
)

function checkoutLines() {
  return cart.value.map((l) => ({
    variantId: l.variantId,
    quantityBase: baseOf(l)!,
    ...(l.manualDiscount ? { manualDiscount: l.manualDiscount } : {}),
  }))
}

async function submitCheckout(tenders: TenderInput[]) {
  completing.value = true
  checkoutError.value = null
  ageError.value = false
  try {
    receipt.value = await apiFetch<SaleReceipt>('/sales', {
      method: 'POST',
      body: {
        lines: checkoutLines(),
        ...(orderDiscount.value ? { orderDiscount: orderDiscount.value } : {}),
        ageVerified: ageVerified.value,
        tenders,
      },
    })
    if (cardStep.value) leaveCardStep(false) // the intent is spent — nothing to cancel
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === 'AGE_VERIFICATION_REQUIRED') {
        ageError.value = true
        checkoutError.value = err.message
      } else if (err.code === 'INSUFFICIENT_STOCK') {
        checkoutError.value = err.message
        void requestQuote()
      } else if (err.code === 'PAYMENT_FAILED') {
        checkoutError.value =
          err.reason === 'amount_mismatch'
            ? 'The card was charged for a different total — the charge was reversed. Take the card again.'
            : err.message
        void requestQuote()
      } else {
        checkoutError.value = err.message
      }
    } else {
      checkoutError.value = 'Something went wrong. The sale was not completed.'
    }
    // Any post-charge failure was auto-reversed server-side; the staged intent cannot
    // be reused either way, so the card step ends here.
    if (cardStep.value) leaveCardStep(false)
  } finally {
    completing.value = false
  }
}

async function complete() {
  if (!canComplete.value || tenderedCents.value === null) return
  await submitCheckout([{ method: 'CASH', tenderedCents: tenderedCents.value }])
}

/* ————— voiding the just-rung sale (admin step-up, always) ————— */
const voidOpen = ref(false)
const voidReason = ref('')
const voidError = ref<string | null>(null)
const voiding = ref(false)
const stepUpOpen = ref(false)

const stepUpTitle = computed(() =>
  receipt.value
    ? `Void sale ${saleNumber(receipt.value.number)} — ${fmt(receipt.value.totalCents)} back`
    : '',
)

function startVoid() {
  voidReason.value = ''
  voidError.value = null
  voidOpen.value = true
}

function voidContinue() {
  if (!voidReason.value.trim()) return
  voidOpen.value = false
  stepUpOpen.value = true
}

async function onVoidApproved(grantId: string) {
  stepUpOpen.value = false
  if (!receipt.value || voiding.value) return
  voiding.value = true
  voidError.value = null
  try {
    receipt.value = await apiFetch<SaleReceipt>(`/sales/${receipt.value.id}/void`, {
      method: 'POST',
      body: { reason: voidReason.value.trim(), stepUpGrantId: grantId },
    })
    await loadProducts() // the stock just came back
  } catch (err) {
    voidError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    voiding.value = false
  }
}

async function newSale() {
  receipt.value = null
  clearCart()
  quote.value = null
  // The stock badges on the cards just changed — refresh them.
  await loadProducts()
}

const receiptDateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const saleNumber = (n: number) => `#${String(n).padStart(4, '0')}`
const qtyLabel = (base: number, mode: TrackingMode) =>
  formatQuantity(base as BaseQuantity, mode)
const taxRateLabel = computed(() => {
  const bps = quote.value?.taxRateBps
  return bps == null ? '' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`
})

const STATUS_BADGE: Record<string, { label: string; class: string }> = {
  OUT: { label: 'Out', class: 'bg-destructive/15 text-destructive' },
  LOW: { label: 'Low', class: 'bg-amber-500/15 text-amber-500' },
}
</script>

<template>
  <div class="flex h-dvh flex-col">
    <RegisterBar>
      <span
        v-if="shift"
        class="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary"
      >
        Shift open · {{ timeFmt.format(new Date(shift.openedAt)) }}
      </span>
      <span class="text-xs tabular-nums">{{ timeFmt.format(now) }}</span>
      <button
        v-if="auth.user"
        type="button"
        class="flex items-center gap-2 rounded-full bg-accent py-1 pl-1.5 pr-2.5 text-xs text-foreground transition-colors hover:bg-accent/70"
        @click="signOut"
      >
        <span class="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
          {{ auth.initials }}
        </span>
        {{ auth.displayName }}
        <LogOut class="size-3 text-muted-foreground" />
      </button>
    </RegisterBar>

    <div v-if="booted" class="flex min-h-0 flex-1">
      <RegisterRail active="/register/sale" />

      <!-- browse -->
      <main class="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <!--
          WARN, NEVER BLOCK (Kasan, 2026-08-22). A line, not a dialog: nothing here is
          disabled and the sale rings exactly as it would otherwise. A timeclock bug must
          never be the reason a customer cannot be served, so this can only ever nag.
          Staff only — an admin has no clock, so `applies` hides it entirely.
        -->
        <button
          v-if="clock.applies.value && !clock.clockedIn.value"
          type="button"
          class="flex min-h-11 items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 text-left text-sm font-semibold text-amber-600 transition-colors hover:bg-amber-500/14 dark:text-amber-400"
          :disabled="clock.busy.value"
          @click="clock.toggle()"
        >
          You're not clocked in.
          <span class="ml-auto rounded-lg border border-amber-500/50 px-3 py-1 text-xs">
            {{ clock.busy.value ? 'Working…' : 'Clock in' }}
          </span>
        </button>

        <div class="relative">
          <Search class="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-primary" />
          <SearchInput
            ref="searchInput"
            v-model="term"
            scanner
            placeholder="Scan a barcode or search the catalog…"
            autocomplete="off"
            spellcheck="false"
            class="h-12 border-primary/60 pl-10 text-base shadow-[0_0_0_3px_rgba(34,197,94,0.10)]"
            aria-label="Scan or search"
            @scan="scannerOpen = !scannerOpen"
          />
          <RegisterCameraScanner
            :open="scannerOpen"
            :feedback="scannerFeedback"
            @scanned="onCameraScanned"
            @close="scannerOpen = false"
          />
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <!--
            "Show all" used to sit inside this radiogroup, but it toggles the stock filter,
            not the category — a different axis. It is its own Toggle now.
            Every control here stays h-9: these are touch targets.
          -->
          <ToggleGroup
            :model-value="categoryId ?? '__all'"
            type="single"
            :spacing="1.5"
            aria-label="Category"
            class="flex-wrap"
            @update:model-value="(v) => categoryId = !v || v === '__all' ? null : (v as string)"
          >
            <ToggleGroupItem value="__all" class="h-9 rounded-full border border-input px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/50 data-[state=on]:bg-primary/12 data-[state=on]:text-primary">
              All
            </ToggleGroupItem>
            <ToggleGroupItem
              v-for="cat in parents"
              :key="cat.id"
              :value="cat.id"
              class="h-9 rounded-full border border-input px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/50 data-[state=on]:bg-primary/12 data-[state=on]:text-primary"
            >
              {{ cat.name }}
            </ToggleGroupItem>
          </ToggleGroup>
          <Toggle
            v-model="showAll"
            aria-label="Show out-of-stock products too"
            class="ml-auto h-9 rounded-full border border-dashed border-input px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-primary/12 data-[state=on]:text-primary"
          >
            Show all
          </Toggle>
        </div>

        <div class="relative min-h-0 flex-1 overflow-y-auto">
          <div v-if="loadingProducts" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true" />
          <Empty v-if="!cards.length && !loadingProducts" class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><SearchX /></EmptyMedia>
              <EmptyTitle>Nothing matches</EmptyTitle>
              <EmptyDescription>Try another search or category.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div class="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-4">
            <button
              v-for="card in cards"
              :key="card.variantId"
              type="button"
              class="flex flex-col gap-1 rounded-2xl border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
              @click="addCard(card)"
            >
              <span class="flex items-start justify-between gap-2">
                <span class="line-clamp-2 text-sm font-semibold leading-snug">{{ card.productName }}</span>
                <span
                  v-if="STATUS_BADGE[card.stockStatus]"
                  class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  :class="STATUS_BADGE[card.stockStatus]!.class"
                >
                  {{ STATUS_BADGE[card.stockStatus]!.label }}
                </span>
              </span>
              <span v-if="card.label && card.label !== card.productName" class="truncate text-xs text-muted-foreground">
                {{ card.label }}
              </span>
              <span class="mt-auto flex items-center justify-between pt-1.5">
                <span class="text-sm font-bold tabular-nums text-primary">{{ card.priceText }}</span>
                <span class="flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Plus class="size-4" />
                </span>
              </span>
            </button>
          </div>
        </div>
      </main>

      <!-- cart panel -->
      <aside class="flex w-[400px] shrink-0 flex-col border-l bg-card" aria-label="Current sale">
        <!-- card step: the panel becomes the payment screen (the customer looks at this) -->
        <template v-if="cardStep && stagedIntent">
          <div class="flex items-center gap-2 border-b px-4 py-2.5">
            <span class="text-sm font-bold">Card payment</span>
            <span class="ml-auto text-[11px] text-muted-foreground">step 2 of 2</span>
          </div>
          <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <div class="pt-2 text-center">
              <p class="text-[11px] uppercase tracking-widest text-muted-foreground">Amount to charge</p>
              <p class="text-4xl font-extrabold tabular-nums text-primary">{{ fmt(stagedIntent.cardAmountCents) }}</p>
              <p v-if="stagedIntent.totalCents !== stagedIntent.cardAmountCents" class="mt-1 text-xs text-muted-foreground">
                + {{ fmt(stagedIntent.totalCents - stagedIntent.cardAmountCents) }} cash alongside
              </p>
            </div>
            <div ref="payElementHost" />
            <FieldError v-if="cardError" class="text-xs">{{ cardError }}</FieldError>
          </div>
          <div class="flex flex-col gap-1.5 border-t p-3">
            <Button
              class="h-13 py-3 text-base font-bold"
              :disabled="charging || completing"
              @click="chargeCard"
            >
              {{ charging || completing ? 'Charging…' : `Charge ${fmt(stagedIntent.cardAmountCents)}` }}
            </Button>
            <button
              type="button"
              class="py-1 text-sm text-muted-foreground hover:text-foreground"
              :disabled="charging || completing"
              @click="leaveCardStep()"
            >
              ← Back to tender
            </button>
          </div>
        </template>

        <template v-else>
        <div class="flex items-center gap-2 border-b px-4 py-2.5">
          <span class="text-sm font-bold">Sale</span>
          <NuxtLink
            to="/register/return"
            class="rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Return
          </NuxtLink>
          <button
            v-if="cart.length"
            type="button"
            class="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            @click="clearCart"
          >
            Clear
          </button>
        </div>

        <!-- lines -->
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          <Empty v-if="!cart.length" class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ShoppingCart /></EmptyMedia>
              <EmptyTitle>Cart is empty</EmptyTitle>
              <EmptyDescription>Scan an item or tap a product to start.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div
            v-for="line in cart"
            :key="line.variantId"
            class="flex flex-col gap-1.5 rounded-xl border bg-background/60 p-2.5"
          >
            <div class="flex items-start gap-2">
              <span class="min-w-0 flex-1 text-sm font-semibold leading-snug">{{ lineName(line) }}</span>
              <span class="shrink-0 text-sm font-bold tabular-nums">
                {{ quotedByVariant.get(line.variantId) ? fmt(quotedByVariant.get(line.variantId)!.netCents) : '—' }}
              </span>
              <button
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                :aria-label="`Remove ${lineName(line)}`"
                @click="removeLine(line.variantId)"
              >
                <X class="size-3.5" />
              </button>
            </div>

            <div class="flex items-center gap-1.5">
              <template v-if="line.trackingMode === 'EACH'">
                <button
                  type="button"
                  class="flex size-9 items-center justify-center rounded-lg bg-accent hover:bg-accent/70"
                  :aria-label="`One fewer ${lineName(line)}`"
                  @click="bump(line, -1)"
                >
                  <Minus class="size-3.5" />
                </button>
                <Input
                  v-model="line.quantity"
                  inputmode="numeric"
                  autocomplete="off"
                  class="h-9 w-14 text-center font-semibold tabular-nums"
                  :aria-label="`Quantity of ${lineName(line)}`"
                />
                <button
                  type="button"
                  class="flex size-9 items-center justify-center rounded-lg bg-accent hover:bg-accent/70"
                  :aria-label="`One more ${lineName(line)}`"
                  @click="bump(line, 1)"
                >
                  <Plus class="size-3.5" />
                </button>
              </template>
              <InputGroup
                v-else
                class="h-9 w-24"
                :class="baseOf(line) === null ? 'border-amber-500/60' : ''"
              >
                <InputGroupInput
                  v-model="line.quantity"
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder="0.0"
                  class="text-right font-semibold tabular-nums"
                  :aria-label="`Grams of ${lineName(line)}`"
                />
                <InputGroupAddon align="inline-end" class="text-xs">g</InputGroupAddon>
              </InputGroup>

              <!-- what the server says about this line -->
              <div class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
                <span
                  v-if="quotedByVariant.get(line.variantId)?.appliedTierLabel"
                  class="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {{ quotedByVariant.get(line.variantId)!.appliedTierLabel }}
                </span>
                <span
                  v-for="promo in quotedByVariant.get(line.variantId)?.appliedPromotions ?? []"
                  :key="promo.promotionId"
                  class="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-medium text-primary"
                >
                  {{ promo.name }} −{{ fmt(promo.discountCents) }}
                </span>
                <button
                  type="button"
                  class="flex h-6 items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-colors"
                  :class="line.manualDiscount ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
                  :aria-label="`Discount ${lineName(line)}`"
                  @click="openDiscount(line.variantId)"
                >
                  <Percent class="size-3" />
                  {{ line.manualDiscount ? (quotedByVariant.get(line.variantId) ? `−${fmt(quotedByVariant.get(line.variantId)!.manualDiscountCents)}` : 'discount') : 'Discount' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- totals + tender -->
        <div class="flex flex-col gap-2.5 border-t p-3">
          <FieldError v-if="quoteError" class="text-xs">{{ quoteError }}</FieldError>

          <div class="flex flex-col gap-1 text-sm" :class="quotePending ? 'opacity-50' : ''">
            <div class="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span class="tabular-nums">{{ quote ? fmt(quote.subtotalCents) : '—' }}</span>
            </div>
            <div class="flex justify-between text-muted-foreground">
              <button type="button" class="underline decoration-dotted underline-offset-2 hover:text-foreground" @click="openDiscount('order')">
                {{ orderDiscount ? 'Sale discount' : 'Add a discount' }}
              </button>
              <span class="tabular-nums">{{ quote && quote.discountCents > 0 ? `−${fmt(quote.discountCents)}` : '' }}</span>
            </div>
            <div class="flex justify-between text-muted-foreground">
              <span>Tax {{ taxRateLabel }}</span>
              <span class="tabular-nums">{{ quote ? fmt(quote.taxCents) : '—' }}</span>
            </div>
          </div>

          <div class="flex items-center justify-between rounded-xl bg-primary px-3.5 py-2.5 text-primary-foreground">
            <span class="text-sm font-bold">Total</span>
            <span class="text-xl font-extrabold tabular-nums">{{ quote ? fmt(quote.totalCents) : '—' }}</span>
          </div>

          <button
            v-if="needsAge"
            type="button"
            class="flex w-full items-center justify-between gap-2.5 rounded-xl border p-3 text-left transition-colors"
            :class="ageVerified
              ? 'border-primary/45 bg-primary/10 hover:bg-primary/15'
              : ageError
                ? 'border-destructive bg-destructive/10'
                : 'border-amber-500/45 bg-amber-500/10 hover:bg-amber-500/15'"
            @click="openAgeDialog"
          >
            <span>
              <span class="block text-sm font-bold" :class="ageVerified ? 'text-primary' : ''">
                <template v-if="ageVerified">✓ Age verified<template v-if="verifiedAge !== null"> — {{ verifiedAge }}</template></template>
                <template v-else>Verify age</template>
              </span>
              <span class="block text-xs text-muted-foreground">
                <template v-if="ageVerified">Recorded with this sale · tap to redo</template>
                <template v-else>Required — this cart contains cannabinoids</template>
              </span>
            </span>
            <span class="text-lg text-muted-foreground" aria-hidden="true">›</span>
          </button>

          <!--
            h-11 stays on every item: this is the tender control on a touchscreen. Card and
            Split are disabled with their reason in a title when Stripe is unconfigured.
          -->
          <ToggleGroup
            :model-value="tenderMethod"
            type="single"
            :spacing="2"
            aria-label="Payment method"
            class="w-full"
            @update:model-value="(v) => v && (tenderMethod = v as typeof tenderMethod)"
          >
            <ToggleGroupItem
              value="CASH"
              class="h-11 flex-1 gap-1.5 rounded-xl border border-input text-sm font-bold text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
            >
              <Banknote class="size-4" /> Cash
            </ToggleGroupItem>
            <ToggleGroupItem
              value="CARD"
              :disabled="!cardAvailable"
              :title="cardAvailable ? undefined : 'Stripe is not configured on this server'"
              class="h-11 flex-1 gap-1.5 rounded-xl border border-input text-sm font-bold text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
            >
              <CreditCard class="size-4" /> Card
            </ToggleGroupItem>
            <ToggleGroupItem
              value="SPLIT"
              :disabled="!cardAvailable"
              :title="cardAvailable ? undefined : 'Stripe is not configured on this server'"
              class="h-11 flex-1 rounded-xl border border-input text-sm font-bold text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
            >
              Split
            </ToggleGroupItem>
          </ToggleGroup>

          <!-- cash: quick tenders, unchanged from Phase 8 -->
          <!-- Custom opens a dialog rather than choosing a value, so it is a Button beside
               the group, not a member of it. -->
          <div v-if="tenderMethod === 'CASH'" class="flex gap-1.5">
            <ToggleGroup
              :model-value="String(tenderedCents ?? '')"
              type="single"
              :spacing="1.5"
              aria-label="Cash tendered"
              class="flex-1"
              @update:model-value="(v) => v && (tenderedCents = Number(v))"
            >
              <ToggleGroupItem
                v-for="option in quickTenders"
                :key="option.cents"
                :value="String(option.cents)"
                class="h-10 flex-1 rounded-lg border border-input text-sm font-semibold tabular-nums transition-colors hover:bg-accent data-[state=on]:border-primary/60 data-[state=on]:bg-primary/12 data-[state=on]:text-primary"
              >
                {{ option.label }}
              </ToggleGroupItem>
            </ToggleGroup>
            <button
              type="button"
              class="h-10 flex-1 rounded-lg border text-sm font-semibold transition-colors"
              :class="tenderedCents !== null && !quickTenders.some((o) => o.cents === tenderedCents) ? 'border-primary/60 bg-primary/12 text-primary' : 'hover:bg-accent'"
              :disabled="!quote"
              @click="customTenderOpen = true; customTenderStr = ''"
            >
              {{ tenderedCents !== null && !quickTenders.some((o) => o.cents === tenderedCents) ? fmt(tenderedCents) : 'Custom' }}
            </button>
          </div>

          <!-- split: the cash figure fixes the card amount, so it comes first -->
          <div v-else-if="tenderMethod === 'SPLIT'" class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm text-muted-foreground">Cash portion</span>
              <InputGroup class="h-10 w-28">
                <InputGroupAddon>$</InputGroupAddon>
                <InputGroupInput
                  v-model="splitCashStr"
                  inputmode="decimal"
                  autocomplete="off"
                  class="text-right font-semibold tabular-nums"
                  aria-label="Cash portion in dollars"
                />
              </InputGroup>
            </div>
            <p class="text-right text-xs text-muted-foreground">
              Exact cash, no change — the card takes the rest{{ cardRestCents !== null ? `: ${fmt(cardRestCents)}` : '' }}.
            </p>
          </div>

          <FieldError v-if="checkoutError" class="text-xs">{{ checkoutError }}</FieldError>

          <Button
            v-if="tenderMethod === 'CASH'"
            class="h-13 py-3 text-base font-bold"
            :disabled="!canComplete"
            @click="complete"
          >
            <template v-if="completing">Completing…</template>
            <template v-else-if="changeCents !== null && changeCents >= 0">
              Complete — change {{ fmt(changeCents) }}
            </template>
            <template v-else>Complete sale</template>
          </Button>
          <Button
            v-else
            class="h-13 py-3 text-base font-bold"
            :disabled="!cardBaseReady || cardRestCents === null"
            @click="enterCardStep"
          >
            {{ staging ? 'Starting…' : `Take card${cardRestCents !== null ? ` — ${fmt(cardRestCents)}` : ''}` }}
          </Button>
        </div>
        </template>
      </aside>
    </div>

    <!-- discount dialog -->
    <Dialog :open="discountOpen" @update:open="(o: boolean) => !o && (discountOpen = false)">
      <DialogContent class="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>
            {{ discountTarget === 'order' ? 'Discount the sale' : 'Discount this line' }}
          </DialogTitle>
          <DialogDescription>
            {{ discountTargetLine ? lineName(discountTargetLine) : 'Applies to the whole sale, spread across the lines.' }}
          </DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="applyDiscount">
          <ToggleGroup
            :model-value="discountType"
            type="single"
            :spacing="1.5"
            aria-label="Discount type"
            class="w-full"
            @update:model-value="(v) => v && (discountType = v as typeof discountType)"
          >
            <ToggleGroupItem
              value="PERCENT_OFF"
              class="h-10 flex-1 rounded-lg border border-input text-sm font-semibold transition-colors hover:bg-accent data-[state=on]:border-primary/60 data-[state=on]:bg-primary/12 data-[state=on]:text-primary"
            >
              % off
            </ToggleGroupItem>
            <ToggleGroupItem
              value="AMOUNT_OFF"
              class="h-10 flex-1 rounded-lg border border-input text-sm font-semibold transition-colors hover:bg-accent data-[state=on]:border-primary/60 data-[state=on]:bg-primary/12 data-[state=on]:text-primary"
            >
              $ off
            </ToggleGroupItem>
          </ToggleGroup>
          <InputGroup class="h-8">
            <InputGroupAddon>{{ discountType === 'AMOUNT_OFF' ? '$' : '%' }}</InputGroupAddon>
            <InputGroupInput
              v-model="discountValue"
              inputmode="decimal"
              autocomplete="off"
              autofocus
              class="text-lg font-semibold tabular-nums"
              aria-label="Discount value"
            />
          </InputGroup>
          <DialogFooter class="gap-2">
            <Button type="button" variant="ghost" @click="removeDiscount">Remove</Button>
            <Button type="submit" :disabled="parsedDiscount() === null">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- custom tender dialog -->
    <Dialog :open="customTenderOpen" @update:open="(o: boolean) => !o && (customTenderOpen = false)">
      <DialogContent class="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Cash presented</DialogTitle>
          <DialogDescription v-if="quote">Total is {{ fmt(quote.totalCents) }}.</DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="applyCustomTender">
          <InputGroup class="h-14">
            <InputGroupAddon class="text-lg">$</InputGroupAddon>
            <InputGroupInput
              v-model="customTenderStr"
              inputmode="decimal"
              autocomplete="off"
              autofocus
              class="text-center text-2xl font-bold tabular-nums"
              aria-label="Cash presented in dollars"
            />
          </InputGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="customTenderOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!parseDollarsToCents(customTenderStr.trim()).ok">Set</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- the sales receipt: on-screen only, by decision. Hidden (not closed) while the
         void flow's overlays are up — an open reka Dialog pointer-locks everything
         outside its own content, which would make the PIN pad untappable. -->
    <Dialog
      :open="receipt !== null && !voidOpen && !stepUpOpen"
      @update:open="(o: boolean) => !o && newSale()"
    >
      <DialogContent v-if="receipt" class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sale {{ saleNumber(receipt.number) }} complete</DialogTitle>
          <DialogDescription>
            {{ receipt.storeName }} · {{ receipt.cashierName }} · {{ receiptDateFmt.format(new Date(receipt.createdAt)) }}
          </DialogDescription>
        </DialogHeader>
        <!-- The receipt block is shared with /register/history and /admin/sales — one
             renderer, so the same sale cannot read three different ways. -->
        <SalesReceipt :receipt="receipt" />
        <div>
          <FieldError v-if="voidError" class="text-xs">{{ voidError }}</FieldError>
        </div>
        <!-- The vendored footer goes sm:flex-row — pin the column at EVERY breakpoint,
             or "Void this sale…" gets crushed beside the full-width New sale button. -->
        <DialogFooter class="flex-col gap-1 sm:flex-col sm:justify-start">
          <Button class="h-11 w-full text-base font-bold" @click="newSale">New sale</Button>
          <button
            v-if="receipt.status === 'COMPLETED'"
            type="button"
            class="w-full py-1.5 text-sm text-destructive/80 transition-colors hover:text-destructive"
            :disabled="voiding"
            @click="startVoid"
          >
            {{ voiding ? 'Voiding…' : 'Void this sale…' }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- void: reason first, then the manager's PIN -->
    <Dialog :open="voidOpen" @update:open="(o: boolean) => !o && (voidOpen = false)">
      <DialogContent class="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Void sale {{ receipt ? saleNumber(receipt.number) : '' }}</DialogTitle>
          <DialogDescription>
            Everything restocks and the money goes back. A manager approves it.
          </DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="voidContinue">
          <Field>
            <FieldLabel for="void-reason">Reason</FieldLabel>
            <Input id="void-reason" v-model="voidReason" autocomplete="off" maxlength="200" autofocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="voidOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!voidReason.trim()">Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <RegisterAgeVerifyDialog
      :open="ageDialogOpen"
      :cashier-name="auth.displayName ?? undefined"
      @confirm="onAgeConfirmed"
      @close="ageDialogOpen = false"
    />

    <RegisterStepUpDialog
      :open="stepUpOpen"
      :title="stepUpTitle"
      detail="Every void is recorded with who asked and who approved."
      @approved="onVoidApproved"
      @close="stepUpOpen = false"
    />

  </div>
</template>
