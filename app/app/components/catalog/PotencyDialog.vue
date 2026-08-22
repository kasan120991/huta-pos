<script setup lang="ts">
import { FlaskConical } from '@lucide/vue'
import type { CannabinoidLinkInput, CatalogProductDetail, CatalogReference } from '@huta/shared/schemas'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { FieldError } from '~/components/ui/field'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * The cannabinoid links editor — a row per link, saved as ONE full-array replace.
 *
 * Per-PRODUCT, never per-variant. Packaged goods carry mg per unit; flower carries a
 * percentage — either column, or NEITHER: "contains X, potency unrecorded" is a legal,
 * honest fact. Percent parses by the digits (24.5 → 2450 bps), mg is whole numbers.
 */
const props = defineProps<{
  open: boolean
  productId: string
  links: CatalogProductDetail['cannabinoids']
  reference: CatalogReference
}>()
const emit = defineEmits<{ close: [], saved: [] }>()

interface Row {
  cannabinoidId: string
  mg: string
  percent: string
}

const rows = ref<Row[]>([])
const saving = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    rows.value = props.links.map((link) => ({
      cannabinoidId: link.cannabinoid.id,
      mg: link.mgPerUnit !== null ? String(link.mgPerUnit) : '',
      percent:
        link.percentBps !== null
          ? (link.percentBps / 100).toFixed(2).replace(/\.?0+$/, '')
          : '',
    }))
    error.value = null
  },
)

watch(rows, () => (error.value = null), { deep: true })

function addRow() {
  rows.value.push({ cannabinoidId: '', mg: '', percent: '' })
}
function removeRow(index: number) {
  rows.value.splice(index, 1)
}

/** "24.5" → 2450, parsed from the digits; null for blank; 'invalid' otherwise. */
function percentToBps(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return 'invalid'
  const [whole, frac = ''] = trimmed.split('.')
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0')
  return bps > 10000 ? 'invalid' : bps
}

function mgToInt(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 'invalid'
}

const clientIssue = computed<string | null>(() => {
  const seen = new Set<string>()
  for (const row of rows.value) {
    if (row.cannabinoidId === '') return 'Pick a cannabinoid for every row.'
    if (seen.has(row.cannabinoidId)) return 'Each cannabinoid can only appear once.'
    seen.add(row.cannabinoidId)
    if (mgToInt(row.mg) === 'invalid') return 'mg is whole numbers only.'
    if (percentToBps(row.percent) === 'invalid') return 'Percent is 0–100, to two decimals.'
  }
  return null
})

const canSubmit = computed(() => !saving.value && clientIssue.value === null)

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  const links: CannabinoidLinkInput[] = rows.value.map((row) => ({
    cannabinoidId: row.cannabinoidId,
    mgPerUnit: mgToInt(row.mg) as number | null,
    percentBps: percentToBps(row.percent) as number | null,
  }))
  try {
    await apiFetch(`/catalog/products/${props.productId}/cannabinoids`, {
      method: 'PUT',
      body: { links },
    })
    emit('saved')
    emit('close')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Cannabinoids</DialogTitle>
        <DialogDescription>
          mg per unit for packaged goods, percent for flower — either, or neither
          ("contains it, potency unrecorded").
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-3" novalidate @submit.prevent="submit">
        <div v-if="rows.length" class="flex flex-col gap-2">
          <div class="grid grid-cols-[minmax(0,1fr)_72px_72px_28px] gap-2 text-xs font-medium text-muted-foreground">
            <span>Cannabinoid</span><span>mg</span><span>%</span><span />
          </div>
          <div
            v-for="(row, index) in rows"
            :key="index"
            class="grid grid-cols-[minmax(0,1fr)_72px_72px_28px] items-center gap-2"
          >
            <Select v-model="row.cannabinoidId">
              <SelectTrigger class="data-[size=default]:h-9 w-full" :aria-label="`Cannabinoid ${index + 1}`">
                <SelectValue placeholder="Pick…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in reference.cannabinoids" :key="c.id" :value="c.id">
                  {{ c.name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <Input v-model="row.mg" inputmode="numeric" autocomplete="off" class="h-9 tabular-nums" :aria-label="`mg per unit, row ${index + 1}`" />
            <Input v-model="row.percent" inputmode="decimal" autocomplete="off" class="h-9 tabular-nums" :aria-label="`percent, row ${index + 1}`" />
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              :aria-label="`Remove row ${index + 1}`"
              @click="removeRow(index)"
            >
              ✕
            </button>
          </div>
        </div>
        <Empty v-else class="flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FlaskConical /></EmptyMedia>
            <EmptyTitle>No cannabinoids linked</EmptyTitle>
            <EmptyDescription>Age verification at the register keys on these.</EmptyDescription>
          </EmptyHeader>
        </Empty>

        <Button type="button" variant="ghost" size="sm" class="self-start px-2 text-xs text-primary" @click="addRow">
          ＋ Add cannabinoid
        </Button>

        <FieldError v-if="error">{{ error }}</FieldError>
        <p v-else-if="clientIssue && rows.length" class="text-xs text-amber-500">{{ clientIssue }}</p>

        <DialogFooter>
          <Button type="button" variant="ghost" @click="emit('close')">Cancel</Button>
          <Button type="submit" :disabled="!canSubmit">
            {{ saving ? 'Saving…' : 'Save cannabinoids' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
