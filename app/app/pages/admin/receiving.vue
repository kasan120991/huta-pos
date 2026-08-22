<script setup lang="ts">
import { Inbox } from '@lucide/vue'
import type { CatalogReference, ReceiptLineRow, ReceiptRow, SupplierRow, VarianceLine } from '@huta/shared/schemas'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { formatCents, formatQuantity } from '@huta/shared'
import RecordDeliveryDialog from '~/components/receiving/RecordDeliveryDialog.vue'
import { Spinner } from '~/components/ui/spinner'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { FieldError } from '~/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { parseDollars } from '~/lib/money'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * The admin receiving desk: the costing queue, the variance review queue, and the
 * admin-posted Record-delivery composer. The two queue chips are ALTERNATIVE queues and
 * never AND together — selecting one clears the other.
 */

type Queue = 'costing' | 'review' | 'all'

const route = useRoute()
const router = useRouter()

const queue = ref<Queue>('costing')
const storeId = ref<string | undefined>(undefined)
const supplierId = ref<string | undefined>(undefined)

{
  const q = route.query
  if (q['queue'] === 'review' || q['queue'] === 'all') queue.value = q['queue']
  if (typeof q['store'] === 'string') storeId.value = q['store']
  if (typeof q['supplier'] === 'string') supplierId.value = q['supplier']
}

function writeQuery() {
  void router.replace({
    query: {
      queue: queue.value !== 'costing' ? queue.value : undefined,
      store: storeId.value,
      supplier: supplierId.value,
    },
  })
}

/* ————— data ————— */
const receipts = ref<ReceiptRow[]>([])
const reference = ref<CatalogReference | null>(null)
const suppliers = ref<SupplierRow[]>([])
const loading = ref(false)
const selectedId = ref<string | null>(null)
const composerOpen = ref(false)

async function fetchReceipts() {
  loading.value = true
  try {
    const data = await apiFetch<{ receipts: ReceiptRow[] }>('/receiving/receipts', {
      query: { storeId: storeId.value, supplierId: supplierId.value },
    })
    receipts.value = data.receipts
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  const supplierData = await apiFetch<{ suppliers: SupplierRow[] }>('/suppliers')
  suppliers.value = supplierData.suppliers
})
watch([storeId, supplierId], fetchReceipts, { immediate: true })

/* ————— queues, derived client-side from one fetch so the chip counts always agree ————— */
const isUncosted = (r: ReceiptRow) => (r.uncostedLineCount ?? 0) > 0
const needsReview = (r: ReceiptRow) => r.hasVariance && r.reviewedAt === null

const costingCount = computed(() => receipts.value.filter(isUncosted).length)
const reviewCount = computed(() => receipts.value.filter(needsReview).length)

const visible = computed(() => {
  if (queue.value === 'costing') return receipts.value.filter(isUncosted)
  if (queue.value === 'review') return receipts.value.filter(needsReview)
  return receipts.value
})

function setQueue(next: Queue) {
  queue.value = queue.value === next && next !== 'all' ? 'all' : next
  writeQuery()
}

const selected = computed(() => receipts.value.find((r) => r.id === selectedId.value) ?? null)

/* Keep a sane selection as the visible queue changes. */
watch(visible, (list) => {
  if (!list.some((r) => r.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null
  }
})

/* ————— costing ————— */
const costDrafts = ref<Record<string, string>>({})
const savingCosts = ref(false)
const actionError = ref<string | null>(null)

watch(selected, (receipt) => {
  costDrafts.value = {}
  actionError.value = null
  varianceRows.value = null
  if (receipt?.hasVariance) void fetchVariance(receipt.id)
})

const draftedCosts = computed(() =>
  Object.entries(costDrafts.value)
    .map(([lineId, raw]) => ({ lineId, raw, cents: parseDollars(raw) }))
    .filter((d) => d.raw.trim() !== ''),
)

const canSaveCosts = computed(
  () =>
    !savingCosts.value
    && draftedCosts.value.length > 0
    && draftedCosts.value.every((d) => d.cents !== null),
)

async function saveCosts() {
  if (!canSaveCosts.value || !selected.value) return
  savingCosts.value = true
  actionError.value = null
  try {
    await apiFetch(`/receiving/receipts/${selected.value.id}/costs`, {
      method: 'PATCH',
      body: { costs: draftedCosts.value.map((d) => ({ lineId: d.lineId, unitCostCents: d.cents })) },
    })
    const keep = selected.value.id
    await fetchReceipts()
    selectedId.value = keep
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    savingCosts.value = false
  }
}

/* ————— variance ————— */
const varianceRows = ref<VarianceLine[] | null>(null)
const reviewing = ref(false)

async function fetchVariance(receiptId: string) {
  const data = await apiFetch<{ variance: VarianceLine[] }>(`/receiving/receipts/${receiptId}/variance`)
  if (selectedId.value === receiptId) varianceRows.value = data.variance
}

async function markReviewed() {
  if (!selected.value || reviewing.value) return
  reviewing.value = true
  actionError.value = null
  try {
    await apiFetch(`/receiving/receipts/${selected.value.id}/review`, { method: 'POST' })
    const keep = selected.value.id
    await fetchReceipts()
    selectedId.value = keep
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    reviewing.value = false
  }
}

async function onPosted(receiptId: string) {
  queue.value = 'all'
  writeQuery()
  await fetchReceipts()
  selectedId.value = receiptId
}

/* ————— display helpers ————— */
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const when = (iso: string) => {
  const d = new Date(iso)
  return `${dateFmt.format(d)} · ${timeFmt.format(d)}`
}

const qty = (line: ReceiptLineRow) =>
  formatQuantity(line.quantityBase as BaseQuantity, line.trackingMode as TrackingMode)

const unit = (line: ReceiptLineRow) => (line.trackingMode === 'WEIGHT' ? '/g' : '/ct')

function costLabel(line: ReceiptLineRow): string | null {
  if (line.unitCostCents == null) return null
  return `${formatCents(line.unitCostCents as Cents)}${unit(line)}`
}

function lineValue(line: ReceiptLineRow): string | null {
  if (line.unitCostCents == null) return null
  const cents =
    line.trackingMode === 'WEIGHT'
      ? Math.round((line.unitCostCents * line.quantityBase) / 1000)
      : line.unitCostCents * line.quantityBase
  return formatCents(cents as Cents)
}

function refLabel(r: ReceiptRow): string {
  if (r.purchaseOrderReference) return r.purchaseOrderReference
  if (r.invoiceNumber) return `#${r.invoiceNumber}`
  return 'standalone'
}

const varianceTone: Record<VarianceLine['kind'], string> = {
  OVER: 'bg-red-400/10 text-red-400',
  UNEXPECTED: 'bg-red-400/10 text-red-400',
  SHORT: 'bg-amber-500/10 text-amber-500',
}

function varianceDiff(line: VarianceLine): string {
  const magnitude = formatQuantity(
    Math.abs(line.differenceBase) as BaseQuantity,
    line.trackingMode as TrackingMode,
  )
  return `${line.differenceBase >= 0 ? '+' : '−'}${magnitude}`
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <div class="flex items-center gap-2">
      <h1 class="text-xl font-semibold tracking-tight">Receiving</h1>
      <span class="text-sm text-muted-foreground">{{ receipts.length }} deliveries</span>
      <Button class="ml-auto" size="sm" @click="composerOpen = true">＋ Record delivery</Button>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <!--
        Alternative queues, never ANDed — re-selecting the active chip falls back to All,
        which is what setQueue() already did. The dashed border is the house "unset filter"
        affordance and is kept.
      -->
      <ToggleGroup
        :model-value="queue"
        type="single"
        :spacing="2"
        aria-label="Queue"
        @update:model-value="(v) => setQueue((v as Queue) || 'all')"
      >
        <ToggleGroupItem value="costing" class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground">
          Needs costing
          <Badge variant="secondary" class="h-5 min-w-5 justify-center px-1 text-xs">{{ costingCount }}</Badge>
        </ToggleGroupItem>
        <ToggleGroupItem value="review" class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground">
          Needs review
          <Badge variant="secondary" class="h-5 min-w-5 justify-center px-1 text-xs">{{ reviewCount }}</Badge>
        </ToggleGroupItem>
        <ToggleGroupItem value="all" class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground">All</ToggleGroupItem>
      </ToggleGroup>
      <div class="ml-auto flex items-center gap-2">
        <Select
          :model-value="storeId ?? 'all'"
          @update:model-value="(v) => { storeId = v === 'all' ? undefined : (v as string); writeQuery() }"
        >
          <SelectTrigger class="h-8 w-40" aria-label="Store filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stores</SelectItem>
            <SelectItem v-for="store in reference?.stores ?? []" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          :model-value="supplierId ?? 'all'"
          @update:model-value="(v) => { supplierId = v === 'all' ? undefined : (v as string); writeQuery() }"
        >
          <SelectTrigger class="h-8 w-44" aria-label="Supplier filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any supplier</SelectItem>
            <SelectItem v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 items-start gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
      <!-- delivery list -->
      <div class="flex flex-col gap-2" :class="loading ? 'pointer-events-none opacity-50' : ''">
        <button
          v-for="receipt in visible"
          :key="receipt.id"
          type="button"
          class="rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
          :class="receipt.id === selectedId ? 'border-primary/50 bg-primary/5' : ''"
          @click="selectedId = receipt.id"
        >
          <div class="flex items-center gap-2 text-sm font-semibold">
            <span class="truncate">{{ receipt.supplierName ?? 'No supplier' }}</span>
            <Badge v-if="(receipt.uncostedLineCount ?? 0) > 0" class="border-transparent bg-amber-500/10 text-amber-500">
              {{ receipt.uncostedLineCount }} uncosted
            </Badge>
            <Badge v-if="needsReview(receipt)" class="border-transparent bg-red-400/10 text-red-400">Variance</Badge>
          </div>
          <div class="mt-0.5 text-xs text-muted-foreground">
            {{ receipt.storeName }} · {{ when(receipt.receivedAt) }} · by {{ receipt.receivedByName }} · {{ refLabel(receipt) }}
          </div>
        </button>
        <Empty v-if="!visible.length && !loading" class="flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
            <EmptyTitle>{{ queue === 'costing' ? 'Nothing needs costing' : queue === 'review' ? 'Nothing needs review' : 'No deliveries match' }}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>

      <!-- working panel -->
      <div v-if="selected" class="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-sm font-semibold">
            {{ selected.supplierName ?? 'No supplier' }} — {{ selected.storeName }}, {{ when(selected.receivedAt) }}
          </h2>
          <Badge v-if="(selected.uncostedLineCount ?? 0) > 0" class="border-transparent bg-amber-500/10 text-amber-500">
            {{ selected.uncostedLineCount }} uncosted
          </Badge>
          <Badge v-else-if="selected.totalCostCents != null" class="border-transparent bg-primary/10 text-primary">
            Costed · {{ formatCents(selected.totalCostCents as Cents) }}
          </Badge>
          <span class="ml-auto text-xs text-muted-foreground">
            {{ refLabel(selected) }} · received by {{ selected.receivedByName }}
          </span>
        </div>

        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Unit cost</TableHead>
                <TableHead class="text-right">Line value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="line in selected.lines" :key="line.id">
                <TableCell>
                  {{ line.productName }}<template v-if="line.label && line.label !== line.productName"> · {{ line.label }}</template>
                  <span class="ml-1 font-mono text-xs text-muted-foreground">{{ line.sku }}</span>
                </TableCell>
                <TableCell class="tabular-nums">{{ qty(line) }}</TableCell>
                <TableCell>
                  <span v-if="costLabel(line)" class="tabular-nums">{{ costLabel(line) }}</span>
                  <InputGroup
                    v-else
                    class="h-8 w-28"
                    :class="(costDrafts[line.id] ?? '').trim() !== '' ? 'border-primary/50' : ''"
                  >
                    <InputGroupAddon class="text-xs">$</InputGroupAddon>
                    <InputGroupInput
                      :model-value="costDrafts[line.id] ?? ''"
                      inputmode="decimal"
                      autocomplete="off"
                      class="text-sm tabular-nums"
                      :aria-label="`Unit cost for ${line.productName}`"
                      @update:model-value="(v: string | number) => costDrafts[line.id] = String(v)"
                    />
                    <InputGroupAddon align="inline-end" class="text-xs">{{ unit(line) }}</InputGroupAddon>
                  </InputGroup>
                </TableCell>
                <TableCell class="text-right tabular-nums">{{ lineValue(line) ?? '—' }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <template v-if="(selected.uncostedLineCount ?? 0) > 0">
          <p class="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            Costing after stock has begun selling is an approximation: the value lands on what
            remains, so the average can read high. If that bites, cost at receipt time.
          </p>
          <div class="flex items-center justify-end gap-2">
            <Button size="sm" :disabled="!canSaveCosts" @click="saveCosts">
              {{ savingCosts ? 'Saving…' : 'Save costs' }}
            </Button>
          </div>
        </template>

        <template v-if="selected.hasVariance">
          <div class="flex items-center gap-2 border-t pt-3">
            <h3 class="text-sm font-semibold">Variance</h3>
            <span v-if="selected.reviewedAt" class="text-xs text-muted-foreground">
              Reviewed by {{ selected.reviewedByName }} · {{ when(selected.reviewedAt) }}
            </span>
          </div>
          <div v-if="varianceRows" class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead>Ordered</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="line in varianceRows" :key="line.variantId">
                  <TableCell>{{ line.productName }}<template v-if="line.label"> · {{ line.label }}</template></TableCell>
                  <TableCell class="tabular-nums">
                    {{ line.orderedBase !== null ? formatQuantity(line.orderedBase as BaseQuantity, line.trackingMode as TrackingMode) : '—' }}
                  </TableCell>
                  <TableCell class="tabular-nums">{{ formatQuantity(line.receivedBase as BaseQuantity, line.trackingMode as TrackingMode) }}</TableCell>
                  <TableCell>
                    <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums" :class="varianceTone[line.kind]">
                      {{ line.kind }} {{ varianceDiff(line) }}
                    </span>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div v-if="!selected.reviewedAt" class="flex items-center gap-2">
            <p class="text-xs text-muted-foreground">
              Stock already posted — variances are flagged, not blocked. Signing off records who accepted the difference.
            </p>
            <Button size="sm" class="ml-auto shrink-0" :disabled="reviewing" @click="markReviewed">
              {{ reviewing ? 'Signing off…' : 'Mark reviewed' }}
            </Button>
          </div>
        </template>

        <FieldError v-if="actionError">{{ actionError }}</FieldError>
      </div>
      <div v-else-if="loading" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />Loading…
      </div>
      <Empty v-else class="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
          <EmptyTitle>No delivery selected</EmptyTitle>
          <EmptyDescription>Pick one on the left.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>

    <RecordDeliveryDialog
      :open="composerOpen"
      :stores="reference?.stores ?? []"
      :suppliers="suppliers"
      @close="composerOpen = false"
      @posted="onPosted"
    />
  </div>
</template>
