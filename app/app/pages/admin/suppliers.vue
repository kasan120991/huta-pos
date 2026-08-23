<script setup lang="ts">
import type { BaseQuantity, TrackingMode } from '@huta/shared'
import { formatQuantity } from '@huta/shared'
import type {
  CatalogPage,
  CatalogProduct,
  PurchaseOrderRow,
  ReceiptRow,
  SupplierActivity,
  SupplierRow,
} from '@huta/shared/schemas'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { Toggle } from '~/components/ui/toggle'
import { Textarea } from '~/components/ui/textarea'
import { ApiError, apiFetch } from '~/composables/useApi'
import { dollars, parseDollars } from '~/lib/money'

/**
 * Suppliers (Kasan's C pick + tabs, 2026-08-21) — the scorecard.
 *
 * Two views in one page: an index of every supplier, and a workspace for one of them. The
 * workspace leads with the judgement (how many orders, how many still owed, how long they
 * take), keeps identity down the left, and puts the three lists — what we buy, deliveries,
 * orders — behind tabs, because they answer different questions and stacking them buried the
 * last one under two tables.
 *
 * WHAT IS DELIBERATELY ABSENT: money. No spend, no margin, no sell-through, no inventory
 * valuation. Those belong to the Phase 12 supplier health dashboard, and the moment they
 * appear here this stops being a supplier record and becomes the reporting phase — the same
 * line that keeps `/admin/sales` a history rather than a report.
 *
 * ⚠️ The commercial terms are OMITTED from the payload for a principal without `cost.view`,
 * not nulled (see `shared/src/schemas/receiving.ts`). This page is admin-only in practice, so
 * it renders them — but it tests with `in`, never `!= null`, and says on screen that staff
 * never receive them.
 */
useHead({ title: 'Suppliers · Huta' })

const route = useRoute()
const router = useRouter()

/* ————— the supplier list ————— */

const suppliers = ref<SupplierRow[]>([])
const loading = ref(false)
const pageError = ref<string | null>(null)

/**
 * ONE fetch, inactive included, with the split derived client-side — the rule both admin
 * desks follow, so a count can never disagree with the list beneath it.
 */
async function fetchSuppliers() {
  loading.value = true
  pageError.value = null
  try {
    const data = await apiFetch<{ suppliers: SupplierRow[] }>('/suppliers', {
      query: { includeInactive: 'true' },
    })
    suppliers.value = [...data.suppliers]
  } catch (err) {
    pageError.value = err instanceof ApiError ? err.message : 'Could not load suppliers.'
  } finally {
    loading.value = false
  }
}

const term = ref('')
const showInactive = ref(false)

/**
 * Searched client-side, unlike the server-side `?search=`: six suppliers all arrive in the
 * one fetch the counts are derived from, so a round trip per keystroke would buy nothing —
 * and it lets the search reach contact names and emails, which the server's name-only
 * `contains` cannot.
 */
const visible = computed(() => {
  const q = term.value.trim().toLowerCase()
  return suppliers.value.filter((s) => {
    if (!showInactive.value && !s.active) return false
    if (!q) return true
    return [s.name, s.contactName, s.email, s.city].some((f) => f?.toLowerCase().includes(q))
  })
})

const activeCount = computed(() => suppliers.value.filter((s) => s.active).length)
const inactiveCount = computed(() => suppliers.value.length - activeCount.value)

/* ————— selection, in the URL so a supplier is linkable ————— */

const selectedId = ref<string | null>(
  typeof route.query['supplier'] === 'string' ? route.query['supplier'] : null,
)

function open(id: string | null) {
  selectedId.value = id
  void router.replace({ query: { ...route.query, supplier: id ?? undefined } })
}

const selected = computed(() => suppliers.value.find((s) => s.id === selectedId.value) ?? null)

/* ————— the workspace's data, refetched whenever the supplier changes ————— */

const activity = ref<SupplierActivity | null>(null)
const products = ref<CatalogProduct[]>([])
const productTotal = ref(0)
const receipts = ref<ReceiptRow[]>([])
const orders = ref<PurchaseOrderRow[]>([])
const detailLoading = ref(false)

/**
 * Every panel is fetched on open rather than per tab. Four small reads against six suppliers
 * is cheaper than the flicker of a tab that loads when tapped, and the KPI strip needs the
 * activity read anyway. Each degrades on its own — a failed orders read must not blank the
 * contact details someone opened the page to find.
 */
async function loadWorkspace(id: string) {
  detailLoading.value = true
  activity.value = null
  products.value = []
  productTotal.value = 0
  receipts.value = []
  orders.value = []
  try {
    const [act, cat, rec, ord] = await Promise.all([
      apiFetch<SupplierActivity>(`/suppliers/${id}/activity`).catch(() => null),
      apiFetch<CatalogPage>('/catalog/products', {
        query: { supplierId: id, active: 'all', page: 1, pageSize: 100 },
      }).catch(() => null),
      apiFetch<{ receipts: ReceiptRow[] }>('/receiving/receipts', {
        query: { supplierId: id },
      }).catch(() => null),
      apiFetch<{ orders: PurchaseOrderRow[] }>('/purchase-orders', {
        query: { supplierId: id },
      }).catch(() => null),
    ])
    // Guard a slow answer for a supplier that has since been closed.
    if (selectedId.value !== id) return
    activity.value = act
    products.value = cat ? [...(cat.products as CatalogProduct[])] : []
    productTotal.value = cat?.total ?? 0
    receipts.value = rec ? [...rec.receipts] : []
    orders.value = ord ? [...ord.orders] : []
  } finally {
    detailLoading.value = false
  }
}

watch(selectedId, (id) => {
  tab.value = 'products'
  if (id) void loadWorkspace(id)
})

onMounted(async () => {
  await fetchSuppliers()
  if (selectedId.value) void loadWorkspace(selectedId.value)
})

/* ————— tabs ————— */

type Tab = 'products' | 'deliveries' | 'orders'
const tab = ref<Tab>('products')

const TABS = computed<ReadonlyArray<{ key: Tab, label: string, count: number }>>(() => [
  { key: 'products', label: 'What we buy', count: productTotal.value },
  { key: 'deliveries', label: 'Deliveries', count: receipts.value.length },
  { key: 'orders', label: 'Orders', count: orders.value.length },
])

/* ————— display ————— */

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const when = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—')

/** One decimal, because whole days round a 1.5-day supplier to either 1 or 2. */
const days = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}`)

const qty = (base: number, mode: TrackingMode) => formatQuantity(base as BaseQuantity, mode)

/** On hand across every store, for one product — what the workspace's product list shows. */
function onHand(product: CatalogProduct): string {
  const first = product.variants[0]
  if (!first) return '—'
  // Never sum across tracking modes: three gummies and three milligrams are not six of
  // anything. A mixed product reports only its count of variants.
  const modes = new Set(product.variants.map((v) => v.trackingMode))
  if (modes.size > 1) return '—'
  const total = product.variants.reduce((sum, v) => sum + v.stock.quantityBase, 0)
  return qty(total, first.trackingMode)
}

const PO_STATUS: Record<string, { label: string, class: string }> = {
  DRAFT: { label: 'Draft', class: 'bg-accent text-muted-foreground' },
  ORDERED: { label: 'Ordered', class: 'bg-sky-400/10 text-sky-400' },
  PARTIALLY_RECEIVED: { label: 'Part received', class: 'bg-amber-500/15 text-amber-500' },
  RECEIVED: { label: 'Received', class: 'bg-primary/10 text-primary' },
  CANCELLED: { label: 'Cancelled', class: 'bg-accent text-muted-foreground' },
}

/* ————— the editor ————— */

interface Draft {
  name: string
  contactName: string
  phone: string
  email: string
  website: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
  licenseNumber: string
  accountNumber: string
  paymentTerms: string
  minimumOrder: string
  notes: string
}

const BLANK: Draft = {
  name: '', contactName: '', phone: '', email: '', website: '',
  addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '',
  licenseNumber: '', accountNumber: '', paymentTerms: '', minimumOrder: '', notes: '',
}

const editOpen = ref(false)
const editing = ref<SupplierRow | null>(null)
const draft = ref<Draft>({ ...BLANK })
const original = ref<Draft>({ ...BLANK })
const saving = ref(false)
const editError = ref<string | null>(null)
const nameError = ref<string | null>(null)

function toDraft(row: SupplierRow | null): Draft {
  if (!row) return { ...BLANK }
  return {
    name: row.name,
    contactName: row.contactName ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    website: row.website ?? '',
    addressLine1: row.addressLine1 ?? '',
    addressLine2: row.addressLine2 ?? '',
    city: row.city ?? '',
    state: row.state ?? '',
    postalCode: row.postalCode ?? '',
    licenseNumber: row.licenseNumber ?? '',
    accountNumber: row.accountNumber ?? '',
    paymentTerms: row.paymentTerms ?? '',
    minimumOrder:
      row.minimumOrderCents === null || row.minimumOrderCents === undefined
        ? ''
        : dollars(row.minimumOrderCents),
    notes: row.notes ?? '',
  }
}

/** State resets on OPEN, never on close — the house rule. */
function startEdit(row: SupplierRow | null) {
  editing.value = row
  draft.value = toDraft(row)
  original.value = toDraft(row)
  editError.value = null
  nameError.value = null
  editOpen.value = true
}

const minimumValid = computed(
  () => draft.value.minimumOrder.trim() === '' || parseDollars(draft.value.minimumOrder) !== null,
)
const editValid = computed(() => draft.value.name.trim() !== '' && minimumValid.value)

/**
 * Only what changed, matching the audit's changed-keys rows — the house rule since the
 * product editor. The archive's page sent all fifteen fields on every save, so an audit
 * entry named columns nobody had touched.
 *
 * A cleared field sends `null`, not `''`: the server normalises empty strings to null anyway,
 * and sending the intent explicitly means the diff is readable.
 */
function buildPatch(): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const before = original.value
  const now = draft.value

  const text = (key: Exclude<keyof Draft, 'minimumOrder'>) => {
    if (now[key].trim() === before[key].trim()) return
    patch[key] = now[key].trim() === '' ? null : now[key].trim()
  }
  ;(Object.keys(BLANK) as Array<keyof Draft>).forEach((key) => {
    if (key === 'minimumOrder') return
    text(key)
  })

  if (now.minimumOrder.trim() !== before.minimumOrder.trim()) {
    patch['minimumOrderCents'] =
      now.minimumOrder.trim() === '' ? null : parseDollars(now.minimumOrder)
  }
  return patch
}

async function saveSupplier() {
  if (!editValid.value || saving.value) return
  saving.value = true
  editError.value = null
  nameError.value = null
  try {
    if (editing.value) {
      const patch = buildPatch()
      // An untouched form just closes. No request, no audit row.
      if (Object.keys(patch).length > 0) {
        await apiFetch(`/suppliers/${editing.value.id}`, { method: 'PATCH', body: patch })
      }
    } else {
      const body = { ...buildPatch(), name: draft.value.name.trim() }
      const created = await apiFetch<SupplierRow>('/suppliers', { method: 'POST', body })
      await fetchSuppliers()
      editOpen.value = false
      open(created.id)
      return
    }
    await fetchSuppliers()
    editOpen.value = false
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Something went wrong.'
    // A slug clash is a NAME problem, and saying so under the field keeps the form — and
    // everything else typed into it — intact.
    if (err instanceof ApiError && /similar name|needs a name/i.test(message)) {
      nameError.value = message
    } else {
      editError.value = message
    }
  } finally {
    saving.value = false
  }
}

/* ————— active / inactive ————— */

/**
 * ⚠️ Open state is a SEPARATE ref from the row. reka's `AlertDialogAction` closes the dialog
 * on click, and that close fires `@update:open` before the fallthrough `@click` — so one ref
 * doing both jobs was nulled first and the action silently short-circuited. See registers.vue.
 */
const deactivateTarget = ref<SupplierRow | null>(null)
const deactivateOpen = ref(false)
const toggling = ref(false)

async function setActive(row: SupplierRow, active: boolean) {
  if (toggling.value) return
  toggling.value = true
  pageError.value = null
  try {
    await apiFetch(`/suppliers/${row.id}`, { method: 'PATCH', body: { active } })
    await fetchSuppliers()
    deactivateOpen.value = false
  } catch (err) {
    pageError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    toggling.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <FieldError v-if="pageError">{{ pageError }}</FieldError>

    <!-- ═══════════════ the index ═══════════════ -->
    <template v-if="!selected">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold tracking-tight">Suppliers</h1>
          <p class="mt-0.5 text-sm text-muted-foreground">
            {{ activeCount }} active<span v-if="inactiveCount"> · {{ inactiveCount }} inactive</span>
          </p>
        </div>
        <Button @click="startEdit(null)">＋ New supplier</Button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <SearchInput
          v-model="term"
          placeholder="Find a supplier, contact or town…"
          aria-label="Search suppliers"
          class="h-9 w-72"
        />
        <Toggle
          v-model="showInactive"
          aria-label="Show inactive suppliers"
          class="h-9 rounded-lg border border-dashed border-input px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground"
        >
          Show inactive
        </Toggle>
      </div>

      <div class="relative rounded-xl border bg-card">
        <!-- A veil, never a content swap: replacing the table collapses the page height and
             takes the scroll position with it. -->
        <div v-if="loading" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true"></div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Reach them</TableHead>
              <TableHead class="text-right">Products</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="row in visible"
              :key="row.id"
              :class="row.active ? '' : 'opacity-60'"
            >
              <TableCell>
                <button
                  type="button"
                  class="text-left font-semibold hover:underline"
                  @click="open(row.id)"
                >
                  {{ row.name }}
                </button>
                <Badge v-if="!row.active" variant="secondary" class="ml-2 align-middle text-[10px]">
                  Inactive
                </Badge>
              </TableCell>
              <TableCell>
                <span v-if="row.contactName">{{ row.contactName }}</span>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ row.phone || row.email || '—' }}
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ row.productCount }}</TableCell>
            </TableRow>
            <TableEmpty v-if="!visible.length && !loading" :colspan="4" class="text-muted-foreground">
              {{ term.trim() ? 'Nothing matches that.' : 'No suppliers yet.' }}
            </TableEmpty>
          </TableBody>
        </Table>
      </div>
    </template>

    <!-- ═══════════════ the workspace ═══════════════ -->
    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <h1 class="text-xl font-semibold tracking-tight">{{ selected.name }}</h1>
          <Badge v-if="!selected.active" variant="secondary">Inactive</Badge>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="ghost" @click="open(null)">All suppliers</Button>
          <Button
            v-if="selected.active"
            variant="outline"
            class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
            @click="deactivateTarget = selected; deactivateOpen = true"
          >
            Deactivate
          </Button>
          <Button v-else variant="outline" :disabled="toggling" @click="setActive(selected, true)">
            Reactivate
          </Button>
          <Button @click="startEdit(selected)">Edit record</Button>
        </div>
      </div>

      <!-- the judgement, before the fold -->
      <div class="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <div class="rounded-xl border bg-card px-4 py-3">
          <div class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Products</div>
          <div class="text-2xl font-bold tabular-nums">{{ selected.productCount }}</div>
        </div>
        <div class="rounded-xl border bg-card px-4 py-3">
          <div class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Orders placed</div>
          <div class="text-2xl font-bold tabular-nums">{{ activity?.ordersPlaced ?? '—' }}</div>
        </div>
        <div class="rounded-xl border bg-card px-4 py-3">
          <div class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Outstanding</div>
          <div
            class="text-2xl font-bold tabular-nums"
            :class="(activity?.outstandingCount ?? 0) > 0 ? 'text-amber-500' : 'text-muted-foreground'"
          >
            {{ activity?.outstandingCount ?? '—' }}
          </div>
        </div>
        <div class="rounded-xl border bg-card px-4 py-3">
          <div class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Last delivery</div>
          <div class="text-2xl font-bold">{{ when(activity?.lastReceivedAt ?? null) }}</div>
        </div>
        <div class="rounded-xl border bg-card px-4 py-3">
          <div class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Avg lead time</div>
          <div class="text-2xl font-bold tabular-nums">
            {{ days(activity?.avgDaysToFirstReceipt ?? null)
            }}<span
              v-if="activity?.avgDaysToFirstReceipt !== null && activity?.avgDaysToFirstReceipt !== undefined"
              class="text-sm font-normal text-muted-foreground"
            > d</span>
          </div>
        </div>
      </div>

      <div class="grid items-start gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
        <!-- ————— identity ————— -->
        <div class="flex flex-col gap-3">
          <div class="rounded-xl border bg-card p-4">
            <div class="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Contact
            </div>
            <p v-if="selected.contactName" class="font-medium">{{ selected.contactName }}</p>
            <p v-if="selected.phone" class="text-sm text-muted-foreground">{{ selected.phone }}</p>
            <p v-if="selected.email" class="break-all text-sm text-muted-foreground">{{ selected.email }}</p>
            <a
              v-if="selected.website"
              :href="selected.website"
              target="_blank"
              rel="noopener noreferrer"
              class="break-all text-sm text-primary hover:underline"
            >{{ selected.website }}</a>
            <p v-if="selected.addressLine1" class="mt-2 text-sm text-muted-foreground">
              {{ selected.addressLine1 }}<template v-if="selected.addressLine2"><br />{{ selected.addressLine2 }}</template>
              <template v-if="selected.city"><br />{{ selected.city }}<template v-if="selected.state">, {{ selected.state }}</template>
                <template v-if="selected.postalCode"> {{ selected.postalCode }}</template></template>
            </p>
            <p
              v-if="!selected.contactName && !selected.phone && !selected.email"
              class="text-sm text-muted-foreground"
            >
              Nobody recorded.
            </p>
          </div>

          <!--
            Fenced and labelled, as the archived page did. The page is admin-only in practice,
            but the fence tells whoever is typing which half of the record is confidential —
            and the server decides it at the `select`, so the label describes a real boundary
            rather than a UI convention.
          -->
          <div class="rounded-xl border border-amber-500/35 bg-amber-500/[0.04] p-4">
            <div class="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-600 dark:text-amber-500">
              ⚠ Commercial terms · admin only
            </div>
            <dl class="flex flex-col gap-1 text-sm">
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">Payment terms</dt>
                <dd :class="selected.paymentTerms ? 'font-medium' : 'text-muted-foreground/60'">
                  {{ selected.paymentTerms || 'not set' }}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">Minimum order</dt>
                <dd
                  class="tabular-nums"
                  :class="selected.minimumOrderCents ? 'font-medium' : 'text-muted-foreground/60'"
                >
                  {{ selected.minimumOrderCents ? `$${dollars(selected.minimumOrderCents)}` : 'not set' }}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">Account no.</dt>
                <dd :class="selected.accountNumber ? 'font-medium' : 'text-muted-foreground/60'">
                  {{ selected.accountNumber || 'not set' }}
                </dd>
              </div>
            </dl>
            <p v-if="selected.notes" class="mt-3 border-t border-amber-500/25 pt-2 text-sm text-muted-foreground">
              {{ selected.notes }}
            </p>
          </div>

          <div class="rounded-xl border bg-card p-4">
            <div class="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Lead time
            </div>
            <dl class="flex flex-col gap-1 text-sm">
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">To first delivery</dt>
                <dd class="tabular-nums">{{ days(activity?.avgDaysToFirstReceipt ?? null) }} d</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">To complete</dt>
                <dd class="tabular-nums">{{ days(activity?.avgDaysToFullReceipt ?? null) }} d</dd>
              </div>
            </dl>
            <!--
              The sample size is part of the answer. An average over two orders and an average
              over two hundred are different claims, and a bare number cannot tell them apart.
            -->
            <p class="mt-2 text-xs text-muted-foreground">
              <template v-if="(activity?.firstReceiptSample ?? 0) === 0">
                Nothing delivered against an order yet.
              </template>
              <template v-else>
                Over {{ activity!.firstReceiptSample }}
                order{{ activity!.firstReceiptSample === 1 ? '' : 's' }}.
                <template v-if="activity!.outstandingCount">
                  {{ activity!.outstandingCount }} still outstanding, counted separately.
                </template>
                <template v-if="activity!.cancelledCount">
                  {{ activity!.cancelledCount }} cancelled, excluded.
                </template>
              </template>
            </p>
            <p v-if="selected.licenseNumber" class="mt-3 border-t pt-2 text-sm">
              <span class="text-muted-foreground">Licence </span>{{ selected.licenseNumber }}
            </p>
          </div>
        </div>

        <!--
          ————— operations, behind tabs —————
          The tab strip sits ABOVE the card rather than inside its border (Kasan, 2026-08-21):
          the tabs choose which table the box shows, so they belong outside the thing they are
          switching, not welded to its top edge.
        -->
        <Tabs v-model="tab" class="gap-3">
          <TabsList variant="line" class="w-full justify-start">
            <TabsTrigger v-for="t in TABS" :key="t.key" :value="t.key" class="flex-none px-3">
              {{ t.label }}
              <span class="rounded-full bg-accent px-1.5 text-[11px] tabular-nums text-muted-foreground">
                {{ t.count }}
              </span>
            </TabsTrigger>
          </TabsList>

          <div class="relative min-h-[220px] rounded-xl border bg-card">
            <div v-if="detailLoading" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true"></div>

            <!-- what we buy -->
            <TabsContent value="products">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead class="text-right">Variants</TableHead>
                    <TableHead class="text-right">On hand</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="product in products" :key="product.id">
                    <TableCell>
                      <NuxtLink :to="`/catalog/products/${product.id}`" class="font-medium hover:underline">
                        {{ product.name }}
                      </NuxtLink>
                      <span v-if="!product.active" class="ml-2 text-xs text-muted-foreground">inactive</span>
                    </TableCell>
                    <TableCell class="text-muted-foreground">{{ product.category.name }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ product.variants.length }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ onHand(product) }}</TableCell>
                  </TableRow>
                  <TableEmpty
                    v-if="!products.length && !detailLoading"
                    :colspan="4"
                    class="text-muted-foreground"
                  >
                    Nothing in the catalog names them as its supplier.
                  </TableEmpty>
                </TableBody>
              </Table>
            </TabsContent>

            <!-- deliveries -->
            <TabsContent value="deliveries">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Against</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead class="text-right">Lines</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="receipt in receipts" :key="receipt.id">
                    <TableCell>
                      <NuxtLink
                        :to="`/admin/receiving?supplier=${selected.id}`"
                        class="font-medium hover:underline"
                      >
                        {{ when(receipt.receivedAt) }}
                      </NuxtLink>
                      <span v-if="receipt.hasVariance" class="ml-2 text-xs font-semibold text-amber-500">
                        variance
                      </span>
                    </TableCell>
                    <TableCell class="text-muted-foreground">{{ receipt.storeName }}</TableCell>
                    <TableCell class="text-muted-foreground">
                      {{ receipt.purchaseOrderReference ?? 'walk-in' }}
                    </TableCell>
                    <TableCell class="text-muted-foreground">{{ receipt.invoiceNumber ?? '—' }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ receipt.lines.length }}</TableCell>
                  </TableRow>
                  <TableEmpty
                    v-if="!receipts.length && !detailLoading"
                    :colspan="5"
                    class="text-muted-foreground"
                  >
                    Nothing has arrived from them yet.
                  </TableEmpty>
                </TableBody>
              </Table>
            </TabsContent>

            <!-- orders -->
            <TabsContent value="orders">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Placed</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead class="text-right">Lead</TableHead>
                    <TableHead class="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="order in orders" :key="order.id">
                    <TableCell>
                      <NuxtLink
                        :to="`/admin/purchase-orders?queue=all&order=${order.id}`"
                        class="font-medium hover:underline"
                      >
                        {{ order.reference }}
                      </NuxtLink>
                    </TableCell>
                    <TableCell class="text-muted-foreground">{{ when(order.orderedAt) }}</TableCell>
                    <TableCell class="text-muted-foreground">{{ order.storeName }}</TableCell>
                    <TableCell class="text-right tabular-nums text-muted-foreground">
                      <template v-if="order.daysToFirstReceipt === null">—</template>
                      <template v-else-if="order.daysToFirstReceipt === 0">same day</template>
                      <template v-else>{{ order.daysToFirstReceipt }} d</template>
                    </TableCell>
                    <TableCell class="text-right">
                      <span
                        class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        :class="PO_STATUS[order.status]?.class"
                      >
                        {{ PO_STATUS[order.status]?.label ?? order.status }}
                      </span>
                    </TableCell>
                  </TableRow>
                  <TableEmpty
                    v-if="!orders.length && !detailLoading"
                    :colspan="5"
                    class="text-muted-foreground"
                  >
                    No orders logged with them.
                  </TableEmpty>
                </TableBody>
              </Table>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </template>

    <!-- ═══════════════ the editor ═══════════════ -->
    <Dialog :open="editOpen" @update:open="(o: boolean) => !o && (editOpen = false)">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? editing.name : 'New supplier' }}</DialogTitle>
          <DialogDescription>
            Contact details are visible to staff. The commercial terms are not.
          </DialogDescription>
        </DialogHeader>

        <form class="flex flex-col gap-4" novalidate @submit.prevent="saveSupplier">
          <!--
            Only the FIELDS scroll — the footer sits outside this wrapper so Save is always
            reachable. Capping the form itself clipped the buttons on a short viewport.
          -->
          <FieldGroup class="max-h-[58vh] gap-4 overflow-y-auto pr-1">
            <Field :data-invalid="!!nameError">
              <FieldLabel for="sup-name">Name</FieldLabel>
              <Input
                id="sup-name"
                v-model="draft.name"
                maxlength="160"
                autocomplete="off"
                autofocus
                :aria-invalid="!!nameError"
              />
              <FieldError v-if="nameError">{{ nameError }}</FieldError>
            </Field>

            <div class="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel for="sup-contact">
                  Contact <span class="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Input id="sup-contact" v-model="draft.contactName" maxlength="120" autocomplete="off" />
              </Field>
              <Field>
                <FieldLabel for="sup-phone">
                  Phone <span class="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Input id="sup-phone" v-model="draft.phone" maxlength="40" inputmode="tel" autocomplete="off" />
              </Field>
              <Field>
                <FieldLabel for="sup-email">
                  Email <span class="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Input id="sup-email" v-model="draft.email" maxlength="160" inputmode="email" autocomplete="off" />
              </Field>
              <Field>
                <FieldLabel for="sup-web">
                  Website <span class="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Input id="sup-web" v-model="draft.website" maxlength="200" autocomplete="off" />
              </Field>
            </div>

            <Field>
              <FieldLabel for="sup-addr1">
                Address <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input id="sup-addr1" v-model="draft.addressLine1" maxlength="160" autocomplete="off" />
              <Input
                v-model="draft.addressLine2"
                maxlength="160"
                autocomplete="off"
                aria-label="Address line 2"
              />
            </Field>

            <div class="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel for="sup-city">City</FieldLabel>
                <Input id="sup-city" v-model="draft.city" maxlength="80" autocomplete="off" />
              </Field>
              <Field>
                <FieldLabel for="sup-state">State</FieldLabel>
                <Input id="sup-state" v-model="draft.state" maxlength="40" autocomplete="off" />
              </Field>
              <Field>
                <FieldLabel for="sup-zip">ZIP</FieldLabel>
                <Input id="sup-zip" v-model="draft.postalCode" maxlength="20" autocomplete="off" />
              </Field>
            </div>

            <Field>
              <FieldLabel for="sup-licence">
                Licence number <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input id="sup-licence" v-model="draft.licenseNumber" maxlength="80" autocomplete="off" />
            </Field>

            <!--
              A real FieldSet, which is what the hand-rolled fence was imitating: the legend
              names the group for a screen reader instead of being a decorative heading.
            -->
            <FieldSet class="gap-4 rounded-xl border border-dashed border-amber-500/45 bg-amber-500/[0.04] p-3">
              <FieldLegend class="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-600 dark:text-amber-500">
                ⚠ Commercial terms — never sent to staff
              </FieldLegend>
              <FieldGroup class="gap-4">
                <div class="grid gap-4 sm:grid-cols-3">
                  <Field>
                    <FieldLabel for="sup-account">Account no.</FieldLabel>
                    <Input id="sup-account" v-model="draft.accountNumber" maxlength="80" autocomplete="off" />
                  </Field>
                  <Field>
                    <FieldLabel for="sup-terms">Payment terms</FieldLabel>
                    <Input id="sup-terms" v-model="draft.paymentTerms" maxlength="80" placeholder="Net 30" autocomplete="off" />
                  </Field>
                  <Field :data-invalid="!minimumValid">
                    <FieldLabel for="sup-min">Minimum order</FieldLabel>
                    <!-- The height goes on InputGroup, not the inner control: the group owns
                         the border and defaults to h-8, so sizing the Input does nothing. -->
                    <InputGroup class="h-8">
                      <InputGroupAddon>$</InputGroupAddon>
                      <InputGroupInput
                        id="sup-min"
                        v-model="draft.minimumOrder"
                        class="text-right tabular-nums"
                        :aria-invalid="!minimumValid"
                        inputmode="decimal"
                        placeholder="0.00"
                        autocomplete="off"
                      />
                    </InputGroup>
                    <FieldError v-if="!minimumValid">A dollar amount, like 500.00.</FieldError>
                  </Field>
                </div>
                <Field>
                  <FieldLabel for="sup-notes">Internal notes</FieldLabel>
                  <Textarea id="sup-notes" v-model="draft.notes" rows="3" maxlength="2000" />
                </Field>
              </FieldGroup>
            </FieldSet>
          </FieldGroup>

          <FieldError v-if="editError">{{ editError }}</FieldError>

          <DialogFooter>
            <Button type="button" variant="ghost" @click="editOpen = false">Cancel</Button>
            <Button type="submit" :disabled="saving || !editValid">
              {{ saving ? 'Saving…' : editing ? 'Save changes' : 'Create supplier' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- deactivate: confirmed, because it drops them from every picker -->
    <!--
      An AlertDialog, not a Dialog: role="alertdialog", focus lands on the safe choice, and
      it will not dismiss on a stray click outside or on Escape. The action closes it on
      click, so a failure surfaces on the page behind rather than behind a stuck dialog —
      which is what used to happen.
    -->
    <AlertDialog v-model:open="deactivateOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate {{ deactivateTarget?.name }}?</AlertDialogTitle>
          <AlertDialogDescription>
            They drop out of the order and delivery pickers straight away. Every order, delivery
            and sale that already names them keeps doing so — suppliers are never deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
            :disabled="toggling"
            @click="deactivateTarget && setActive(deactivateTarget, false)"
          >
            Deactivate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
