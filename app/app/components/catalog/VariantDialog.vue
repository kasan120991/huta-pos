<script setup lang="ts">
import type { CatalogVariant, PriceGroupRow, VariantCreateInput, VariantPatchInput } from '@huta/shared/schemas'
import type { BaseQuantity, Cents } from '@huta/shared'
import { FLOWER_PRICE_GROUP_SLUG, formatCents, formatGrams, parseGramsToBase } from '@huta/shared'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Checkbox } from '~/components/ui/checkbox'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * One dialog for creating AND editing a variant — where the quick-product rescue ends.
 *
 * The pricing block is MODE-LOCKED: tracking mode is chosen once at creation ("can't be
 * changed later — it defines what every quantity means") and shown as a fact when
 * editing. EACH prices per item; WEIGHT prices through a group; the save always sends
 * the full mutually exclusive pair, because the server validates the merged row and a
 * stale opposite field would fail it. Client-side guardrails mirror the server's
 * sentences so the admin reads them before hitting the endpoint. No cost field exists —
 * receiving owns cost.
 */
const props = defineProps<{
  open: boolean
  productId: string
  productName: string
  /** Null → create mode. */
  variant: CatalogVariant | null
  /** Default tracking mode for create (WEIGHT under Flower). */
  defaultMode?: 'EACH' | 'WEIGHT'
}>()
const emit = defineEmits<{ close: [], saved: [] }>()

const isEdit = computed(() => props.variant !== null)

const label = ref('')
const sku = ref('')
const barcode = ref('')
const mode = ref<'EACH' | 'WEIGHT'>('EACH')
const priceDollars = ref('')
const priceGroupId = ref('')
const taxable = ref(true)
const active = ref(true)
const minStr = ref('')
const maxStr = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

/** The register's quick-create signature: inactive at a zero price, awaiting rescue. */
const isRescue = computed(
  () =>
    props.variant !== null &&
    !props.variant.active &&
    (props.variant.priceCents === 0 || props.variant.priceCents === null) &&
    props.variant.trackingMode === 'EACH',
)

const boundToInput = (base: number | null, m: 'EACH' | 'WEIGHT') =>
  base === null ? '' : m === 'WEIGHT' ? formatGrams(base as BaseQuantity, { suffix: false }) : String(base)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const v = props.variant
    if (v) {
      label.value = v.label ?? ''
      sku.value = v.sku
      barcode.value = v.barcode ?? ''
      mode.value = v.trackingMode
      priceDollars.value = v.priceCents !== null ? (v.priceCents / 100).toFixed(2) : ''
      priceGroupId.value = v.priceGroup?.id ?? ''
      taxable.value = v.taxable
      active.value = v.active
      minStr.value = boundToInput(v.minSaleBase, v.trackingMode)
      maxStr.value = boundToInput(v.maxSaleBase, v.trackingMode)
    } else {
      label.value = ''
      sku.value = ''
      barcode.value = ''
      mode.value = props.defaultMode ?? 'EACH'
      priceDollars.value = ''
      priceGroupId.value = ''
      taxable.value = true
      active.value = true
      minStr.value = ''
      maxStr.value = ''
    }
    error.value = null
    if (mode.value === 'WEIGHT') void loadGroups()
  },
)

watch([label, sku, barcode, priceDollars, priceGroupId, taxable, active, minStr, maxStr], () => {
  error.value = null
})

/* Price groups, fetched once the first time WEIGHT is in play. */
const groups = ref<PriceGroupRow[] | null>(null)
async function loadGroups() {
  if (groups.value !== null) return
  const data = await apiFetch<{ groups: PriceGroupRow[] }>('/pricing/groups').catch(() => null)
  groups.value = data ? data.groups.filter((g) => g.active) : []
  if (!priceGroupId.value && !isEdit.value) {
    const flower = groups.value.find((g) => g.slug === FLOWER_PRICE_GROUP_SLUG)
    if (flower) priceGroupId.value = flower.id
  }
}
watch(mode, (m) => {
  if (m === 'WEIGHT') void loadGroups()
})

/** Dollars string → integer cents, parsed from the digits — never a float multiply. */
const priceCents = computed<number | null>(() => {
  const raw = priceDollars.value.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  const [whole, frac = ''] = raw.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0')
})

/** '' → null; otherwise base units for this mode, or 'invalid'. */
function boundToBase(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (mode.value === 'WEIGHT') {
    const parsed = parseGramsToBase(trimmed)
    return parsed.ok && parsed.value > 0 ? parsed.value : 'invalid'
  }
  return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : 'invalid'
}
const minBase = computed(() => boundToBase(minStr.value))
const maxBase = computed(() => boundToBase(maxStr.value))

/** The server's own sentences, shown before the endpoint has to say them. */
const clientIssue = computed<string | null>(() => {
  if (sku.value.trim() === '') return 'A variant needs a SKU.'
  if (mode.value === 'EACH') {
    if (priceDollars.value.trim() === '') return 'An EACH variant needs a price.'
    if (priceCents.value === null) return 'Price is dollars and cents, like 19.99.'
  } else if (priceGroupId.value === '') {
    return 'A WEIGHT variant needs a price group.'
  }
  if (minBase.value === 'invalid' || maxBase.value === 'invalid') {
    return mode.value === 'WEIGHT'
      ? 'Sale bounds are grams, to two decimals.'
      : 'Sale bounds are whole units.'
  }
  if (minBase.value !== null && maxBase.value !== null && minBase.value > maxBase.value) {
    return 'Minimum sale quantity cannot exceed the maximum.'
  }
  return null
})

const canSubmit = computed(() => !saving.value && clientIssue.value === null)

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  // The full mutually exclusive pair, always — the server validates the merged row and
  // a lingering opposite field would fail it.
  const pricing = {
    priceCents: mode.value === 'EACH' ? priceCents.value : null,
    priceGroupId: mode.value === 'WEIGHT' ? priceGroupId.value : null,
  }
  try {
    if (props.variant) {
      const body: VariantPatchInput = {
        label: label.value.trim() || null,
        sku: sku.value.trim(),
        barcode: barcode.value.trim() || null,
        taxable: taxable.value,
        active: active.value,
        minSaleBase: minBase.value as number | null,
        maxSaleBase: maxBase.value as number | null,
        ...pricing,
      }
      await apiFetch(`/catalog/variants/${props.variant.id}`, { method: 'PATCH', body })
    } else {
      const body: VariantCreateInput = {
        sku: sku.value.trim(),
        trackingMode: mode.value,
        label: label.value.trim() || null,
        barcode: barcode.value.trim() || null,
        taxable: taxable.value,
        active: active.value,
        minSaleBase: minBase.value as number | null,
        maxSaleBase: maxBase.value as number | null,
        ...pricing,
      }
      await apiFetch(`/catalog/products/${props.productId}/variants`, { method: 'POST', body })
    }
    emit('saved')
    emit('close')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    saving.value = false
  }
}

const boundsUnit = computed(() => (mode.value === 'WEIGHT' ? 'g' : 'units'))
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ isEdit ? `Edit variant — ${variant?.label ?? productName}` : `Add a variant to ${productName}` }}</DialogTitle>
        <DialogDescription v-if="!isEdit">
          Tracking mode is chosen here once — it defines what every quantity means.
        </DialogDescription>
      </DialogHeader>

      <div
        v-if="isRescue"
        class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-500"
      >
        Quick-created at the register — price it and switch it on to finish the rescue.
      </div>

      <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
        <FieldGroup class="gap-4">
          <div class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel for="vd-label">
                Label <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input id="vd-label" v-model="label" autocomplete="off" placeholder="e.g. 1000mg" />
            </Field>
            <Field>
              <FieldLabel for="vd-sku">SKU</FieldLabel>
              <Input id="vd-sku" v-model="sku" autocomplete="off" class="font-mono" />
            </Field>
          </div>

          <Field>
            <FieldLabel for="vd-barcode">
              Barcode <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="vd-barcode" v-model="barcode" autocomplete="off" placeholder="Scan or type…" />
          </Field>

          <!-- pricing: mode-locked on edit, chosen once on create -->
          <FieldSet class="gap-2.5 rounded-lg border p-3">
            <div class="flex items-center justify-between">
              <FieldLegend class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Pricing
              </FieldLegend>
              <ToggleGroup
                v-if="!isEdit"
                v-model="mode"
                type="single"
                variant="outline"
                size="sm"
                aria-label="Sold by"
                @update:model-value="(v) => v && (mode = v as 'EACH' | 'WEIGHT')"
              >
                <ToggleGroupItem value="EACH" class="px-3 text-xs">Each</ToggleGroupItem>
                <ToggleGroupItem value="WEIGHT" class="px-3 text-xs">Weight</ToggleGroupItem>
              </ToggleGroup>
              <span v-else class="text-xs text-muted-foreground">
                {{ mode === 'EACH' ? 'EACH — priced per item' : 'WEIGHT — priced per gram' }} · can't change
              </span>
            </div>

            <Field v-if="mode === 'EACH'">
              <FieldLabel for="vd-price" class="text-xs">Price</FieldLabel>
              <InputGroup class="h-8">
                <InputGroupAddon>$</InputGroupAddon>
                <InputGroupInput id="vd-price" v-model="priceDollars" inputmode="decimal" autocomplete="off" class="tabular-nums" />
              </InputGroup>
            </Field>
            <Field v-else>
              <FieldLabel for="vd-group" class="text-xs">Price group</FieldLabel>
              <Select v-model="priceGroupId">
                <SelectTrigger id="vd-group" class="w-full">
                  <SelectValue placeholder="Pick a group" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="group in groups ?? []" :key="group.id" :value="group.id">
                    {{ group.name }} · {{ formatCents(group.basePricePerGramCents as Cents) }}/g base
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>Rates and tiers live on the Pricing page.</FieldDescription>
            </Field>
          </FieldSet>

          <div class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel for="vd-min">
                Min sale <span class="font-normal text-muted-foreground">({{ boundsUnit }}, optional)</span>
              </FieldLabel>
              <Input id="vd-min" v-model="minStr" inputmode="decimal" autocomplete="off" class="tabular-nums" />
            </Field>
            <Field>
              <FieldLabel for="vd-max">
                Max sale <span class="font-normal text-muted-foreground">({{ boundsUnit }}, optional)</span>
              </FieldLabel>
              <Input id="vd-max" v-model="maxStr" inputmode="decimal" autocomplete="off" class="tabular-nums" />
            </Field>
          </div>

          <div class="flex items-center gap-5">
            <Field orientation="horizontal" class="w-auto">
              <Checkbox id="vd-taxable" v-model="taxable" />
              <FieldLabel for="vd-taxable" class="text-sm font-normal">Taxable</FieldLabel>
            </Field>
            <Field orientation="horizontal" class="w-auto">
              <Checkbox id="vd-active" v-model="active" />
              <FieldLabel for="vd-active" class="text-sm font-normal">
                Active
                <span class="text-xs text-muted-foreground">— sellable at the register</span>
              </FieldLabel>
            </Field>
          </div>
        </FieldGroup>

        <FieldError v-if="error">{{ error }}</FieldError>
        <p v-else-if="clientIssue" class="text-xs text-amber-500">{{ clientIssue }}</p>
        <FieldDescription v-else class="text-xs">Cost arrives with the first receipt, never typed here.</FieldDescription>

        <DialogFooter>
          <Button type="button" variant="ghost" @click="emit('close')">Cancel</Button>
          <Button type="submit" :disabled="!canSubmit">
            {{ saving ? 'Saving…' : isEdit ? 'Save variant' : 'Add variant' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
