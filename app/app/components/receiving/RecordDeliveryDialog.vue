<script setup lang="ts">
import type { CatalogPage, SupplierRow } from '@huta/shared/schemas'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { formatCents, formatQuantity, parseGramsToBase } from '@huta/shared'
import { PackagePlus, X } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * An admin-posted delivery WITH unit costs — the costed path the flower count-in wants.
 * Posts stock immediately; receipts are the audit trail, not an approval gate. Cost is
 * optional per line: a blank cost posts an uncosted line that lands in the costing queue.
 */
const props = defineProps<{
  open: boolean
  stores: ReadonlyArray<{ id: string, name: string }>
  suppliers: readonly SupplierRow[]
}>()
const emit = defineEmits<{ close: [], posted: [receiptId: string] }>()

interface ComposerLine {
  variantId: string
  name: string
  sku: string
  trackingMode: TrackingMode
  qty: string
  cost: string
}

const storeId = ref('')
const supplierId = ref('')
const invoiceNumber = ref('')
const lines = ref<ComposerLine[]>([])
const search = ref('')
const results = ref<Array<{ variantId: string, name: string, sku: string, trackingMode: TrackingMode }>>([])
const searching = ref(false)
const submitting = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) {
      storeId.value = props.stores[0]?.id ?? ''
      supplierId.value = ''
      invoiceNumber.value = ''
      lines.value = []
      search.value = ''
      results.value = []
      error.value = null
    }
  },
)

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (value) => {
  clearTimeout(searchTimer)
  const term = value.trim()
  if (term.length < 2) {
    results.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    searching.value = true
    try {
      const page = await apiFetch<CatalogPage>('/catalog/products', {
        query: { search: term, pageSize: 8, active: 'all' },
      })
      results.value = page.products.flatMap((p) =>
        p.variants.map((v) => ({
          variantId: v.id,
          name: v.label && v.label !== p.name ? `${p.name} · ${v.label}` : p.name,
          sku: v.sku,
          trackingMode: v.trackingMode,
        })),
      )
    } finally {
      searching.value = false
    }
  }, 250)
})

function addLine(result: (typeof results.value)[number]) {
  if (!lines.value.some((l) => l.variantId === result.variantId)) {
    lines.value.push({ ...result, qty: '', cost: '' })
  }
  search.value = ''
  results.value = []
}

function removeLine(variantId: string) {
  lines.value = lines.value.filter((l) => l.variantId !== variantId)
}

/** Base units from the typed quantity, or null while invalid. Grams parse from the string. */
function lineQuantityBase(line: ComposerLine): number | null {
  const raw = line.qty.trim()
  if (raw === '') return null
  if (line.trackingMode === 'WEIGHT') {
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null
}

/** Dollars string → cents, parsed from the digits. Null = no cost entered (legal). */
function lineCostCents(line: ComposerLine): number | null {
  const raw = line.cost.trim()
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  const [whole, frac = ''] = raw.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0')
}

/** Display-only line value: per-gram cost × milligrams for WEIGHT, per-unit × count for EACH. */
function lineValueCents(line: ComposerLine): number | null {
  const qty = lineQuantityBase(line)
  const cost = lineCostCents(line)
  if (qty === null || cost === null) return null
  return line.trackingMode === 'WEIGHT' ? Math.round((cost * qty) / 1000) : cost * qty
}

const totalCents = computed(() =>
  lines.value.reduce((sum, line) => sum + (lineValueCents(line) ?? 0), 0),
)

const canPost = computed(
  () =>
    !submitting.value
    && storeId.value !== ''
    && lines.value.length > 0
    && lines.value.every(
      (l) => lineQuantityBase(l) !== null && (l.cost.trim() === '' || lineCostCents(l) !== null),
    ),
)

async function post() {
  if (!canPost.value) return
  submitting.value = true
  error.value = null
  try {
    const created = await apiFetch<{ id: string }>('/receiving/receipts', {
      method: 'POST',
      body: {
        storeId: storeId.value,
        ...(supplierId.value ? { supplierId: supplierId.value } : {}),
        ...(invoiceNumber.value.trim() ? { invoiceNumber: invoiceNumber.value.trim() } : {}),
        lines: lines.value.map((l) => ({
          variantId: l.variantId,
          quantityBase: lineQuantityBase(l),
          ...(lineCostCents(l) !== null ? { unitCostCents: lineCostCents(l) } : {}),
        })),
      },
    })
    emit('posted', created.id)
    emit('close')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    submitting.value = false
  }
}

function fmtBase(line: ComposerLine): string {
  const qty = lineQuantityBase(line)
  return qty === null ? '' : formatQuantity(qty as BaseQuantity, line.trackingMode)
}
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Record delivery</DialogTitle>
        <DialogDescription>
          Posts stock immediately — receipts are the audit trail, not an approval gate.
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" novalidate @submit.prevent="post">
        <div class="grid grid-cols-3 gap-2.5">
          <Field>
            <FieldLabel for="rd-store" class="text-xs">Store</FieldLabel>
            <Select v-model="storeId">
              <SelectTrigger id="rd-store" class="h-8 w-full text-xs">
                <SelectValue placeholder="Pick a store" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel for="rd-supplier" class="text-xs">
              Supplier <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Select v-model="supplierId">
              <SelectTrigger id="rd-supplier" class="h-8 w-full text-xs">
                <SelectValue placeholder="No supplier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel for="rd-invoice" class="text-xs">
              Invoice # <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="rd-invoice" v-model="invoiceNumber" class="h-8 text-xs" autocomplete="off" />
          </Field>
        </div>

        <div class="relative">
          <SearchInput
            v-model="search"
            placeholder="Add a line — search product or SKU…"
            autocomplete="off"
            aria-label="Search products to add"
          />
          <div
            v-if="results.length"
            class="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
          >
            <button
              v-for="result in results"
              :key="result.variantId"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              @click="addLine(result)"
            >
              <span class="min-w-0 flex-1 truncate">{{ result.name }}</span>
              <span class="font-mono text-xs text-muted-foreground">{{ result.sku }}</span>
              <span class="text-xs text-muted-foreground">{{ result.trackingMode === 'WEIGHT' ? 'weight' : 'each' }}</span>
            </button>
          </div>
        </div>

        <div v-if="lines.length" class="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Unit cost</TableHead>
                <TableHead class="text-right">Value</TableHead>
                <TableHead><span class="sr-only">Remove</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="line in lines" :key="line.variantId">
                <TableCell class="max-w-48 truncate" :title="line.name">
                  {{ line.name }}
                  <span class="ml-1 font-mono text-xs text-muted-foreground">{{ line.sku }}</span>
                </TableCell>
                <TableCell>
                  <InputGroup class="h-8 w-24">
                    <InputGroupInput
                      v-model="line.qty"
                      :inputmode="line.trackingMode === 'WEIGHT' ? 'decimal' : 'numeric'"
                      class="text-sm tabular-nums"
                      :aria-label="`Quantity for ${line.name}`"
                      autocomplete="off"
                    />
                    <InputGroupAddon align="inline-end" class="text-xs">
                      {{ line.trackingMode === 'WEIGHT' ? 'g' : 'ct' }}
                    </InputGroupAddon>
                  </InputGroup>
                </TableCell>
                <TableCell>
                  <InputGroup class="h-8 w-28">
                    <InputGroupAddon class="text-xs">$</InputGroupAddon>
                    <InputGroupInput
                      v-model="line.cost"
                      inputmode="decimal"
                      class="text-sm tabular-nums"
                      :aria-label="`Unit cost for ${line.name}`"
                      autocomplete="off"
                    />
                    <InputGroupAddon align="inline-end" class="text-xs">
                      {{ line.trackingMode === 'WEIGHT' ? '/g' : '/ct' }}
                    </InputGroupAddon>
                  </InputGroup>
                </TableCell>
                <TableCell class="text-right tabular-nums">
                  {{ lineValueCents(line) !== null ? formatCents(lineValueCents(line)! as Cents) : '—' }}
                </TableCell>
                <TableCell class="px-1">
                  <button
                    type="button"
                    class="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    :aria-label="`Remove ${line.name}`"
                    @click="removeLine(line.variantId)"
                  >
                    <X class="size-3.5" />
                  </button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <Empty v-else class="flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><PackagePlus /></EmptyMedia>
            <EmptyTitle>No lines yet</EmptyTitle>
            <EmptyDescription>Search above to add what arrived.</EmptyDescription>
          </EmptyHeader>
        </Empty>

        <p class="text-xs text-muted-foreground">
          A line left without a cost posts uncosted and lands in the costing queue.
          <span v-for="line in lines" :key="line.variantId">
            <template v-if="fmtBase(line)"> {{ line.name }}: {{ fmtBase(line) }}.</template>
          </span>
        </p>

        <FieldError v-if="error">{{ error }}</FieldError>

        <DialogFooter class="items-center">
          <span class="mr-auto text-sm font-semibold tabular-nums">
            Total {{ formatCents(totalCents as Cents) }}
          </span>
          <Button type="button" variant="ghost" @click="emit('close')">Cancel</Button>
          <Button type="submit" :disabled="!canPost">
            {{ submitting ? 'Posting…' : 'Post delivery' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
