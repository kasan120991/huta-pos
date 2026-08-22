<script setup lang="ts">
import { STRAIN_TYPE_VALUES } from '@huta/shared'
import type {
  CannabinoidLinkInput,
  CatalogProductDetail,
  CatalogReference,
  CatalogVariant,
  VariantPatchInput,
} from '@huta/shared/schemas'
import { Field, FieldLabel } from '~/components/ui/field'
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
 * The strain identity editor (Kasan's D1 pick, 2026-08-21) — the house dialog shape,
 * matching ProductEditDialog and VariantDialog rather than inventing a third idiom.
 *
 * The rule this whole surface exists to express: a BLANK field means "inherit the shelf's",
 * not "empty". So a field the strain does not own opens empty with the product's value as
 * italic placeholder text and an `Inherited` chip; typing overrides it; Clear hands it back.
 * The server resolves the fallback (`catalog/variant-identity.ts`) and reports which level
 * each value came from, so nothing here re-derives it.
 *
 * Potency is the exception, and it is called out on screen: the cannabinoid list falls back
 * ALL OR NOTHING, so the editor opens with the RESOLVED list — inherited rows included —
 * and a save that touches any of it makes the strain own all of it. Showing the inherited
 * rows is what stops a save from silently dropping the shelf's other cannabinoids.
 *
 * Writes follow the house dirty-diff rule: only fields whose OWN value actually moved are
 * sent, so the AuditLog row names what changed rather than echoing all six every time.
 */
const props = defineProps<{
  open: boolean
  product: CatalogProductDetail
  /** The strain being edited. Null while the dialog is closed. */
  variant: CatalogVariant | null
  reference: CatalogReference | null
  suppliers: ReadonlyArray<{ id: string, name: string }>
}>()
const emit = defineEmits<{ close: [], saved: [] }>()

/**
 * reka-ui refuses `<SelectItem value="">` — an empty string is what clears a Select back
 * to its placeholder — so "inherit" needs a real value, mapped to null on the way out.
 */
const INHERIT = '__inherit'

type ScalarKey = 'strainType' | 'terpeneProfile' | 'nose' | 'coaUrl' | 'description'

const strainType = ref(INHERIT)
const terpeneProfile = ref('')
const nose = ref('')
const coaUrl = ref('')
const description = ref('')
const supplierId = ref(INHERIT)
const potency = ref<Array<{ cannabinoidId: string, percent: string, mg: string }>>([])

const saving = ref(false)
const error = ref<string | null>(null)

/** The variant's OWN values when the dialog opened — the baseline the diff is taken against. */
const original = ref<Record<ScalarKey | 'supplierId', string | null>>({
  strainType: null,
  terpeneProfile: null,
  nose: null,
  coaUrl: null,
  description: null,
  supplierId: null,
})

const identity = computed(() => props.variant?.identity ?? null)

/** What the PRODUCT says for a field — rendered as placeholder so a blank box is legible. */
function shelfValue(key: ScalarKey): string {
  const id = identity.value
  if (!id) return ''
  return id.sources[key] === 'product' ? (id[key] ?? '') : ''
}

const shelfSupplier = computed(() =>
  identity.value?.supplierSource === 'product' ? (identity.value.supplier?.name ?? '') : '',
)

/** State reset happens on OPEN, per the house rule — never on close. */
watch(
  () => props.open,
  (open) => {
    if (!open || !props.variant) return
    const id = props.variant.identity
    error.value = null

    const own = (key: ScalarKey): string | null =>
      id && id.sources[key] === 'variant' ? (id[key] ?? null) : null

    original.value = {
      strainType: own('strainType'),
      terpeneProfile: own('terpeneProfile'),
      nose: own('nose'),
      coaUrl: own('coaUrl'),
      description: own('description'),
      supplierId: id?.supplierSource === 'variant' ? (id.supplier?.id ?? null) : null,
    }

    strainType.value = original.value.strainType ?? INHERIT
    terpeneProfile.value = original.value.terpeneProfile ?? ''
    nose.value = original.value.nose ?? ''
    coaUrl.value = original.value.coaUrl ?? ''
    description.value = original.value.description ?? ''
    supplierId.value = original.value.supplierId ?? INHERIT

    // The RESOLVED list, so the inherited rows are visible before anyone edits one.
    potency.value = (id?.cannabinoids ?? []).map((c) => ({
      cannabinoidId: c.cannabinoid.id,
      percent: c.percentBps !== null ? (c.percentBps / 100).toFixed(2).replace(/\.?0+$/, '') : '',
      mg: c.mgPerUnit !== null ? String(c.mgPerUnit) : '',
    }))
  },
)

const strainTypeLabel = (value: string) => value.charAt(0) + value.slice(1).toLowerCase()

/** Is this field currently inheriting — i.e. would a save leave it following the shelf? */
const inheriting = (key: ScalarKey | 'supplierId'): boolean => {
  if (key === 'strainType') return strainType.value === INHERIT
  if (key === 'supplierId') return supplierId.value === INHERIT
  return currentScalar(key) === ''
}

function currentScalar(key: ScalarKey): string {
  switch (key) {
    case 'terpeneProfile': return terpeneProfile.value
    case 'nose': return nose.value
    case 'coaUrl': return coaUrl.value
    case 'description': return description.value
    case 'strainType': return strainType.value === INHERIT ? '' : strainType.value
  }
}

function clearField(key: ScalarKey | 'supplierId') {
  if (key === 'strainType') strainType.value = INHERIT
  else if (key === 'supplierId') supplierId.value = INHERIT
  else if (key === 'terpeneProfile') terpeneProfile.value = ''
  else if (key === 'nose') nose.value = ''
  else if (key === 'coaUrl') coaUrl.value = ''
  else description.value = ''
}

/* ————— potency ————— */

/** "24.5" → 2450, parsed from the DIGITS. Blank is null; anything else invalid. */
function percentToBps(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return 'invalid'
  const [whole, frac = ''] = trimmed.split('.')
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return bps > 10_000 ? 'invalid' : bps
}

function mgToInt(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 'invalid'
}

function addPotencyRow() {
  potency.value.push({ cannabinoidId: '', percent: '', mg: '' })
}
function removePotencyRow(index: number) {
  potency.value.splice(index, 1)
}

/** True once the list differs from what the strain currently RESOLVES to. */
const potencyChanged = computed(() => {
  const id = identity.value
  if (!id) return false
  const before = id.cannabinoids.map(
    (c) => `${c.cannabinoid.id}:${c.percentBps ?? ''}:${c.mgPerUnit ?? ''}`,
  )
  const after = potency.value.map(
    (p) => `${p.cannabinoidId}:${percentToBps(p.percent) ?? ''}:${mgToInt(p.mg) ?? ''}`,
  )
  return before.join('|') !== after.join('|')
})

const cannabinoidName = (id: string) =>
  props.reference?.cannabinoids.find((c) => c.id === id)?.name ?? ''

/* ————— validation, mirroring the server's sentences ————— */

const clientIssue = computed<string | null>(() => {
  const seen = new Set<string>()
  for (const row of potency.value) {
    if (row.cannabinoidId === '') return 'Pick a cannabinoid for every potency row.'
    if (seen.has(row.cannabinoidId)) return 'Each cannabinoid can only appear once.'
    seen.add(row.cannabinoidId)
    if (percentToBps(row.percent) === 'invalid') return 'Percent is 0–100, to two decimals.'
    if (mgToInt(row.mg) === 'invalid') return 'mg is whole numbers only.'
  }
  if (coaUrl.value.trim() !== '' && !/^https?:\/\//i.test(coaUrl.value.trim())) {
    return 'A COA link must start with http:// or https://.'
  }
  return null
})

/** Only the fields whose OWN value moved — an untouched form sends nothing and closes. */
const patch = computed<VariantPatchInput>(() => {
  const out: Record<string, string | null> = {}
  const next: Record<ScalarKey | 'supplierId', string | null> = {
    strainType: strainType.value === INHERIT ? null : strainType.value,
    terpeneProfile: terpeneProfile.value.trim() || null,
    nose: nose.value.trim() || null,
    coaUrl: coaUrl.value.trim() || null,
    description: description.value.trim() || null,
    supplierId: supplierId.value === INHERIT ? null : supplierId.value,
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== original.value[key as ScalarKey | 'supplierId']) out[key] = value
  }
  return out as VariantPatchInput
})

const dirty = computed(() => Object.keys(patch.value).length > 0 || potencyChanged.value)
const canSubmit = computed(() => !saving.value && clientIssue.value === null && dirty.value)

async function submit() {
  const variant = props.variant
  if (!variant || !canSubmit.value) return
  saving.value = true
  error.value = null
  try {
    if (Object.keys(patch.value).length > 0) {
      await apiFetch(`/catalog/variants/${variant.id}`, { method: 'PATCH', body: patch.value })
    }
    if (potencyChanged.value) {
      const links: CannabinoidLinkInput[] = potency.value.map((row) => ({
        cannabinoidId: row.cannabinoidId,
        percentBps: percentToBps(row.percent) as number | null,
        mgPerUnit: mgToInt(row.mg) as number | null,
      }))
      await apiFetch(`/catalog/variants/${variant.id}/cannabinoids`, {
        method: 'PUT',
        body: { links },
      })
    }
    emit('saved')
    emit('close')
  } catch (err) {
    // Dialogs close only on success — the message renders here, the form stays open.
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    saving.value = false
  }
}

/** Hands every field back to the shelf in one action, including the whole potency list. */
async function handBack() {
  const variant = props.variant
  if (!variant) return
  saving.value = true
  error.value = null
  try {
    await apiFetch(`/catalog/variants/${variant.id}`, {
      method: 'PATCH',
      body: {
        strainType: null,
        terpeneProfile: null,
        nose: null,
        coaUrl: null,
        description: null,
        supplierId: null,
      },
    })
    await apiFetch(`/catalog/variants/${variant.id}/cannabinoids`, {
      method: 'PUT',
      body: { links: [] },
    })
    emit('saved')
    emit('close')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not hand this strain back.'
  } finally {
    saving.value = false
  }
}

/** Anything this strain owns today — what "hand back" would actually undo. */
const ownsSomething = computed(() => {
  const id = identity.value
  if (!id) return false
  return (
    Object.values(id.sources).some((s) => s === 'variant') ||
    id.supplierSource === 'variant' ||
    id.cannabinoidSource === 'variant'
  )
})
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          Edit strain — {{ variant?.label ?? product.name }}
        </DialogTitle>
        <DialogDescription>
          Leave a field blank to inherit {{ product.name }}'s.
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
        <!--
          Only the FIELDS scroll. The footer sits outside this wrapper so Save is always
          reachable — inside it, a tall form clipped the buttons at the container edge.
        -->
        <div class="flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="mb-1 flex items-center justify-between gap-2">
              <FieldLabel for="strain-type">Type</FieldLabel>
              <span v-if="inheriting('strainType') && shelfValue('strainType')" class="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                Inherited
              </span>
            </div>
            <Select v-model="strainType">
              <SelectTrigger id="strain-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="INHERIT">
                  {{ shelfValue('strainType')
                    ? `Inherit — ${strainTypeLabel(shelfValue('strainType'))}`
                    : `Inherit from ${product.name}` }}
                </SelectItem>
                <SelectItem v-for="t in STRAIN_TYPE_VALUES" :key="t" :value="t">
                  {{ strainTypeLabel(t) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <div class="mb-1 flex items-center justify-between gap-2">
              <FieldLabel for="strain-terps">Terpenes</FieldLabel>
              <span v-if="inheriting('terpeneProfile') && shelfValue('terpeneProfile')" class="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                Inherited
              </span>
              <button
                v-else-if="!inheriting('terpeneProfile')"
                type="button"
                class="text-[11px] text-primary underline-offset-2 hover:underline"
                @click="clearField('terpeneProfile')"
              >
                Clear
              </button>
            </div>
            <Input
              id="strain-terps"
              v-model="terpeneProfile"
              :placeholder="shelfValue('terpeneProfile') || 'myrcene, limonene'"
              :class="inheriting('terpeneProfile') && shelfValue('terpeneProfile') ? 'placeholder:italic' : ''"
            />
          </div>
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between gap-2">
            <FieldLabel for="strain-nose">Nose</FieldLabel>
            <span v-if="inheriting('nose') && shelfValue('nose')" class="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
              Inherited
            </span>
            <button
              v-else-if="!inheriting('nose')"
              type="button"
              class="text-[11px] text-primary underline-offset-2 hover:underline"
              @click="clearField('nose')"
            >
              Clear
            </button>
          </div>
          <Input
            id="strain-nose"
            v-model="nose"
            :placeholder="shelfValue('nose') || 'grape, pine'"
            :class="inheriting('nose') && shelfValue('nose') ? 'placeholder:italic' : ''"
          />
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between gap-2">
            <FieldLabel for="strain-coa">COA link</FieldLabel>
            <span v-if="inheriting('coaUrl') && shelfValue('coaUrl')" class="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
              Inherited
            </span>
            <button
              v-else-if="!inheriting('coaUrl')"
              type="button"
              class="text-[11px] text-primary underline-offset-2 hover:underline"
              @click="clearField('coaUrl')"
            >
              Clear
            </button>
          </div>
          <Input
            id="strain-coa"
            v-model="coaUrl"
            :placeholder="shelfValue('coaUrl') || 'https://…'"
            :class="inheriting('coaUrl') && shelfValue('coaUrl') ? 'placeholder:italic' : ''"
          />
          <p v-if="inheriting('coaUrl') && !shelfValue('coaUrl')" class="mt-1 text-xs text-muted-foreground">
            {{ product.name }} has no COA either — a blank here means nobody has one.
          </p>
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between gap-2">
            <FieldLabel for="strain-supplier">Supplier</FieldLabel>
            <span v-if="inheriting('supplierId') && shelfSupplier" class="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
              Inherited
            </span>
          </div>
          <Select v-model="supplierId">
            <SelectTrigger id="strain-supplier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="INHERIT">
                {{ shelfSupplier ? `Inherit — ${shelfSupplier}` : `Inherit from ${product.name}` }}
              </SelectItem>
              <SelectItem v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="mt-1 text-xs text-muted-foreground">
            Sales of this strain attribute here — set it when a strain comes from a different
            distributor than the shelf.
          </p>
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between gap-2">
            <FieldLabel for="strain-desc">Description</FieldLabel>
            <button
              v-if="!inheriting('description')"
              type="button"
              class="text-[11px] text-primary underline-offset-2 hover:underline"
              @click="clearField('description')"
            >
              Clear
            </button>
          </div>
          <Input
            id="strain-desc"
            v-model="description"
            :placeholder="shelfValue('description') || `Inherit ${product.name}'s`"
            :class="inheriting('description') && shelfValue('description') ? 'placeholder:italic' : ''"
          />
        </div>

        <!-- potency: the whole list, because owning any of it owns all of it -->
        <div class="rounded-lg border p-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">Potency</span>
            <button
              type="button"
              class="text-xs text-primary underline-offset-2 hover:underline"
              @click="addPotencyRow"
            >
              ＋ Add cannabinoid
            </button>
          </div>

          <p
            v-if="identity?.cannabinoidSource === 'product' && potency.length"
            class="mt-2 rounded-r-md border-l-2 border-amber-500 bg-amber-500/10 px-2.5 py-1.5 text-xs text-muted-foreground"
          >
            These rows come from {{ product.name }}. Changing any of them makes this strain
            own its whole cannabinoid list — they are shown so a save can't quietly drop them.
          </p>

          <div v-if="potency.length" class="mt-2 flex flex-col gap-2">
            <div v-for="(row, i) in potency" :key="i" class="flex items-center gap-2">
              <Select v-model="row.cannabinoidId">
                <SelectTrigger class="data-[size=default]:h-9 flex-1">
                  <SelectValue :placeholder="cannabinoidName(row.cannabinoidId) || 'Cannabinoid'" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="c in reference?.cannabinoids ?? []" :key="c.id" :value="c.id">
                    {{ c.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input v-model="row.percent" class="h-9 w-20 tabular-nums" placeholder="24.5" aria-label="Percent" />
              <span class="text-xs text-muted-foreground">%</span>
              <Input v-model="row.mg" class="h-9 w-20 tabular-nums" placeholder="mg" aria-label="mg per unit" />
              <button
                type="button"
                class="text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                :aria-label="`Remove ${cannabinoidName(row.cannabinoidId) || 'row'}`"
                @click="removePotencyRow(i)"
              >
                ✕
              </button>
            </div>
          </div>
          <p v-else class="mt-2 text-xs text-muted-foreground">
            No potency recorded at either level.
          </p>
        </div>
        </div>

        <p v-if="clientIssue" class="text-sm text-destructive">{{ clientIssue }}</p>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

        <DialogFooter class="sm:justify-end">
          <button
            v-if="ownsSomething"
            type="button"
            class="mr-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            :disabled="saving"
            @click="handBack"
          >
            Hand everything back to {{ product.name }}
          </button>
          <Button type="button" variant="ghost" @click="emit('close')">Cancel</Button>
          <Button type="submit" :disabled="!canSubmit">
            {{ saving ? 'Saving…' : 'Save strain' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
