<script setup lang="ts">
import { Tags } from '@lucide/vue'
import type { Cents } from '@huta/shared'
import { WEIGHT, formatCents, parseGramsToBase } from '@huta/shared'
import type { CatalogReference, PriceGroupRow, PriceLadderRow, Quote } from '@huta/shared/schemas'
import { Field, FieldLabel } from '~/components/ui/field'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { ApiError, apiFetch } from '~/composables/useApi'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { dollars, parseDollars } from '~/lib/money'

/**
 * The pricing desk (Kasan's A3 pick, 2026-08-21): the editor IS the counter's price list.
 *
 * One table whose columns are what somebody actually asks at the counter — what does this
 * weight cost, what is that per gram, and how much cheaper is it than buying a gram at a
 * time. Stored tiers are editable rows; the weights BETWEEN breaks are greyed illustrative
 * rows, so the list reads as a price list without lying about what exists in the database.
 * Editing is in place, per the approved design: no dialog, no detail pane.
 *
 * Every figure in the table is the SERVER's. `GET /pricing/groups/:id/ladder` runs the same
 * `tierFor` + `extendTier` the register runs, which is the only way the shelf tag and the
 * receipt can be guaranteed to agree. The client never multiplies a rate by a weight —
 * `extendTier` deliberately does not round-trip, so doing so would print the wrong price.
 *
 * The ladder is promotion-free and store-free on purpose: a price list that moved whenever
 * a promo ran would disagree with the printed tag. "Check any weight" underneath asks the
 * other question — it quotes a REAL variant at a REAL store, so it DOES include promotions,
 * and says so when the two disagree.
 */
definePageMeta({ layout: 'default' })
useHead({ title: 'Pricing · Huta' })

const route = useRoute()
const router = useRouter()

const groups = ref<PriceGroupRow[]>([])
const selectedId = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

const selected = computed(() => groups.value.find((g) => g.id === selectedId.value) ?? null)

/* ————— groups ————— */

async function fetchGroups(keepSelection = true) {
  loading.value = true
  error.value = null
  try {
    const res = await apiFetch<{ groups: PriceGroupRow[] }>('/pricing/groups')
    groups.value = res.groups
    const stillThere = keepSelection && groups.value.some((g) => g.id === selectedId.value)
    if (!stillThere) selectedId.value = groups.value[0]?.id ?? null
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not load the price groups.'
  } finally {
    loading.value = false
  }
}

/** Selection rides in the URL so a group is linkable and survives a refresh. */
function select(id: string) {
  selectedId.value = id
  void router.replace({ query: { ...route.query, group: id } })
}

watch(selected, (group) => {
  baseDraft.value = group ? dollars(group.basePricePerGramCents) : ''
  quoteResult.value = null
  quoteError.value = null
  rowErrors.value = {}
  draftRow.value = null
  void loadLadder()
})

onMounted(async () => {
  const wanted = typeof route.query['group'] === 'string' ? route.query['group'] : null
  await fetchGroups(false)
  if (wanted && groups.value.some((g) => g.id === wanted)) selectedId.value = wanted
  else if (selected.value) baseDraft.value = dollars(selected.value.basePricePerGramCents)
  await loadLadder()
  await fetchStores()
})

/* ————— formatting and parsing: strings in, integer cents out, never floats ————— */

const money = (cents: number) => formatCents(cents as Cents)
const gramsLabel = (base: number) => `${(base / WEIGHT.GRAM).toFixed(2)} g`
/**
 * A break is normally cheaper per gram than the base rate. A break that is DEARER is
 * almost always a typo — and it is invisible in the price column, because the total looks
 * perfectly reasonable until you divide it by the weight. So it gets a sign and a colour
 * rather than the same "—" the base row shows.
 */
const savingLabel = (bps: number) => {
  if (bps === 0) return '—'
  return bps > 0 ? `−${(bps / 100).toFixed(1)}%` : `+${(-bps / 100).toFixed(1)}%`
}

/** Parse a dollars string to whole cents by the DIGITS — never `Number(x) * 100`. */
function parseGrams(raw: string): number | null {
  const parsed = parseGramsToBase(raw.trim())
  return parsed.ok && parsed.value > 0 ? parsed.value : null
}

/** The familiar name for a weight, when it has one. Purely a reading aid. */
const NICKNAMES: Record<number, string> = {
  [WEIGHT.HALF_GRAM]: 'half gram',
  [WEIGHT.EIGHTH]: 'eighth',
  [WEIGHT.QUARTER]: 'quarter',
  [WEIGHT.HALF_OUNCE]: 'half',
  [WEIGHT.OUNCE]: 'ounce',
  [WEIGHT.POUND]: 'pound',
}

/* ————— the price list ————— */

/**
 * The weights the list always shows, whether or not a tier sits at them — everything the
 * counter sells flower in. Every stored threshold is merged in below, so a tier at an
 * unusual weight never goes missing from its own price list.
 */
const SHELF_WEIGHTS = [WEIGHT.GRAM, WEIGHT.EIGHTH, WEIGHT.QUARTER, WEIGHT.HALF_OUNCE, WEIGHT.OUNCE]

const ladder = ref<PriceLadderRow[]>([])
const ladderLoading = ref(false)

const ladderWeights = computed(() => {
  const thresholds = (selected.value?.tiers ?? []).map((t) => t.minQuantityBase)
  return [...new Set([...SHELF_WEIGHTS, ...thresholds])].sort((a, b) => a - b)
})

async function loadLadder() {
  const group = selected.value
  if (!group) {
    ladder.value = []
    return
  }
  ladderLoading.value = true
  try {
    const res = await apiFetch<{ rows: PriceLadderRow[] }>(
      `/pricing/groups/${group.id}/ladder`,
      { query: { weights: ladderWeights.value.join(',') } },
    )
    ladder.value = res.rows
    // Re-seed the inline price boxes from the server's answer, so a rejected edit snaps
    // back to the stored figure rather than leaving a number that was never saved.
    priceDrafts.value = Object.fromEntries(
      res.rows
        .filter((r) => r.isTierThreshold && r.tierId)
        .map((r) => [r.tierId as string, dollars(r.totalCents)]),
    )
    weightDrafts.value = Object.fromEntries(
      res.rows
        .filter((r) => r.isTierThreshold && r.tierId)
        .map((r) => [r.tierId as string, (r.quantityBase / WEIGHT.GRAM).toFixed(2)]),
    )
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not price the ladder.'
  } finally {
    ladderLoading.value = false
  }
}

/* ————— inline editing ————— */

const baseDraft = ref('')
const baseSaving = ref(false)
const baseError = ref<string | null>(null)

const baseDirty = computed(
  () => !!selected.value && baseDraft.value !== dollars(selected.value.basePricePerGramCents),
)

async function saveBase() {
  const group = selected.value
  if (!group || !baseDirty.value) return
  const cents = parseDollars(baseDraft.value)
  if (cents === null) {
    baseError.value = 'Enter a price like 10.00.'
    return
  }
  baseSaving.value = true
  baseError.value = null
  try {
    await apiFetch(`/pricing/groups/${group.id}`, {
      method: 'PATCH',
      body: { basePricePerGramCents: cents },
    })
    await fetchGroups()
    await loadLadder()
  } catch (err) {
    baseError.value = err instanceof ApiError ? err.message : 'Could not save the base rate.'
    baseDraft.value = dollars(group.basePricePerGramCents)
  } finally {
    baseSaving.value = false
  }
}

const priceDrafts = ref<Record<string, string>>({})
const weightDrafts = ref<Record<string, string>>({})
const rowErrors = ref<Record<string, string>>({})
const savingTier = ref<string | null>(null)

function tierRowDirty(row: PriceLadderRow): boolean {
  const id = row.tierId
  if (!id || !row.isTierThreshold) return false
  return (
    priceDrafts.value[id] !== dollars(row.totalCents) ||
    weightDrafts.value[id] !== (row.quantityBase / WEIGHT.GRAM).toFixed(2)
  )
}

async function saveTier(row: PriceLadderRow) {
  const group = selected.value
  const id = row.tierId
  if (!group || !id || !tierRowDirty(row)) return

  const totalPriceCents = parseDollars(priceDrafts.value[id] ?? '')
  const minQuantityBase = parseGrams(weightDrafts.value[id] ?? '')
  if (totalPriceCents === null) {
    rowErrors.value = { ...rowErrors.value, [id]: 'Enter a price like 30.00.' }
    return
  }
  if (minQuantityBase === null) {
    rowErrors.value = { ...rowErrors.value, [id]: 'Enter a weight in grams, like 3.5.' }
    return
  }

  savingTier.value = id
  const { [id]: _dropped, ...rest } = rowErrors.value
  rowErrors.value = rest
  try {
    await apiFetch(`/pricing/groups/${group.id}/tiers/${id}`, {
      method: 'PUT',
      body: { minQuantityBase, totalPriceCents },
    })
    await fetchGroups()
    await loadLadder()
  } catch (err) {
    rowErrors.value = {
      ...rowErrors.value,
      [id]: err instanceof ApiError ? err.message : 'Could not save that break.',
    }
  } finally {
    savingTier.value = null
  }
}

const removing = ref<string | null>(null)

async function removeTier(id: string) {
  const group = selected.value
  if (!group) return
  removing.value = id
  try {
    await apiFetch(`/pricing/groups/${group.id}/tiers/${id}`, { method: 'DELETE' })
    await fetchGroups()
    await loadLadder()
  } catch (err) {
    // A tier that has already priced a sale cannot be deleted — the server says so in a
    // sentence worth showing verbatim, because "edit it instead" is the actual remedy.
    rowErrors.value = {
      ...rowErrors.value,
      [id]: err instanceof ApiError ? err.message : 'Could not remove that break.',
    }
  } finally {
    removing.value = null
  }
}

/* ————— adding a break ————— */

const draftRow = ref<{ grams: string, price: string } | null>(null)
const draftError = ref<string | null>(null)
const draftSaving = ref(false)

function startDraft() {
  draftRow.value = { grams: '', price: '' }
  draftError.value = null
}

const draftValid = computed(
  () =>
    draftRow.value !== null &&
    parseGrams(draftRow.value.grams) !== null &&
    parseDollars(draftRow.value.price) !== null,
)

async function saveDraft() {
  const group = selected.value
  const draft = draftRow.value
  if (!group || !draft || !draftValid.value) return
  draftSaving.value = true
  draftError.value = null
  try {
    await apiFetch(`/pricing/groups/${group.id}/tiers`, {
      method: 'POST',
      body: {
        minQuantityBase: parseGrams(draft.grams),
        totalPriceCents: parseDollars(draft.price),
      },
    })
    draftRow.value = null
    await fetchGroups()
    await loadLadder()
  } catch (err) {
    draftError.value = err instanceof ApiError ? err.message : 'Could not add that break.'
  } finally {
    draftSaving.value = false
  }
}

/* ————— check a weight: the ONE place promotions show up ————— */

const checkWeight = ref('')
const quoteResult = ref<{ grossCents: number, netCents: number, tierLabel: string | null } | null>(null)
const quoteError = ref<string | null>(null)
const quoting = ref(false)

const previewVariant = computed(() => selected.value?.variants[0] ?? null)
const checkBase = computed(() => parseGrams(checkWeight.value))

const stores = ref<CatalogReference['stores']>([])
const checkStoreId = ref<string | null>(null)

async function fetchStores() {
  try {
    const res = await apiFetch<CatalogReference>('/catalog/reference')
    stores.value = res.stores
    checkStoreId.value = res.stores[0]?.id ?? null
  } catch {
    // A missing store list only disables the promo check; the price list still works.
    stores.value = []
  }
}

async function runCheck() {
  const variant = previewVariant.value
  const base = checkBase.value
  if (!variant || base === null || !checkStoreId.value) return
  quoting.value = true
  quoteError.value = null
  try {
    const res = await apiFetch<Quote>('/pricing/quote', {
      method: 'POST',
      body: {
        storeId: checkStoreId.value,
        lines: [{ variantId: variant.id, quantityBase: base }],
      },
    })
    const line = res.lines[0]!
    quoteResult.value = {
      grossCents: line.grossCents,
      netCents: line.netCents,
      tierLabel: line.appliedTierLabel ?? null,
    }
  } catch (err) {
    quoteError.value = err instanceof ApiError ? err.message : 'Could not price that weight.'
  } finally {
    quoting.value = false
  }
}

/** A promotion moved the price — worth saying out loud on a screen about list prices. */
const promoApplied = computed(
  () => quoteResult.value !== null && quoteResult.value.netCents !== quoteResult.value.grossCents,
)

/** The lowest real break, named in the round-up warning so the sentence is concrete. */
const firstBreak = computed(() => ladder.value.find((r) => r.isTierThreshold && r.tierId) ?? null)

/** Breaks that cost MORE per gram than the base rate — almost certainly a mistyped total. */
const dearerBreaks = computed(() =>
  ladder.value.filter((r) => r.isTierThreshold && r.savingBps < 0),
)
</script>

<template>
  <div class="flex flex-col gap-5">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">Pricing</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        What the shelf charges by weight. Every figure here is priced by the server, with the
        same code the register runs.
      </p>
    </div>

    <p
      v-if="error"
      class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {{ error }}
    </p>

    <!-- group chips -->
    <!-- A group is always selected, so an empty value from re-selecting the active chip is
         ignored rather than clearing the page. -->
    <ToggleGroup
      v-if="groups.length"
      :model-value="selectedId ?? ''"
      type="single"
      :spacing="2"
      aria-label="Price group"
      class="flex-wrap"
      @update:model-value="(v) => v && select(v as string)"
    >
      <ToggleGroupItem
        v-for="g in groups"
        :key="g.id"
        :value="g.id"
        class="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/45 data-[state=on]:bg-primary/12 data-[state=on]:font-medium data-[state=on]:text-primary"
      >
        {{ g.name }}
        <span v-if="!g.active" class="ml-1 text-xs opacity-70">· inactive</span>
      </ToggleGroupItem>
    </ToggleGroup>

    <Empty v-else-if="!loading" class="flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Tags /></EmptyMedia>
        <EmptyTitle>No price groups yet</EmptyTitle>
        <EmptyDescription>Weight-tracked products price through a group.</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-if="selected">
      <!-- base rate, edited in place, with the blast radius stated next to it -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div class="flex items-baseline gap-3">
          <span class="text-sm font-semibold">{{ selected.name }}</span>
          <span class="text-xs text-muted-foreground">
            {{ selected.variantCount }}
            {{ selected.variantCount === 1 ? 'variant prices' : 'variants price' }} through this group
          </span>
        </div>
        <div class="flex items-center gap-2">
          <FieldLabel for="base-rate" class="text-xs uppercase tracking-wider text-muted-foreground">
            Base
          </FieldLabel>
          <InputGroup class="h-8 w-24">
            <InputGroupAddon>$</InputGroupAddon>
            <InputGroupInput
              id="base-rate"
              v-model="baseDraft"
              inputmode="decimal"
              class="tabular-nums"
              :aria-invalid="baseError ? 'true' : undefined"
              @blur="saveBase"
              @keyup.enter="saveBase"
            />
          </InputGroup>
          <span class="text-xs text-muted-foreground">/g</span>
          <span v-if="baseSaving" class="text-xs text-muted-foreground">Saving…</span>
          <span v-else-if="baseDirty" class="text-xs text-primary">Enter to save</span>
        </div>
      </div>
      <p v-if="baseError" class="-mt-3 text-sm text-destructive">{{ baseError }}</p>

      <!-- THE price list -->
      <div class="relative rounded-lg border bg-card">
        <div v-if="ladderLoading" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true"></div>
        <Table>
          <TableCaption class="sr-only">
            Price list for {{ selected.name }} by weight
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Buying</TableHead>
              <TableHead scope="col" class="text-right">They pay</TableHead>
              <TableHead scope="col" class="text-right">Per gram</TableHead>
              <TableHead scope="col" class="text-right">vs. base</TableHead>
              <TableHead scope="col">Tier</TableHead>
              <TableHead scope="col" class="text-right">
                <span class="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <template v-for="row in ladder" :key="row.quantityBase">
              <TableRow :class="row.isTierThreshold ? '' : 'text-muted-foreground'">
                <!-- Buying -->
                <TableCell class="tabular-nums">
                  <div class="flex items-center gap-1.5">
                    <template v-if="row.isTierThreshold && row.tierId">
                      <Input
                        v-model="weightDrafts[row.tierId]"
                        inputmode="decimal"
                        class="h-8 w-20 tabular-nums"
                        :aria-label="`Break weight in grams, currently ${gramsLabel(row.quantityBase)}`"
                        @blur="saveTier(row)"
                        @keyup.enter="saveTier(row)"
                      />
                      <span class="text-xs text-muted-foreground">g</span>
                    </template>
                    <span v-else>{{ gramsLabel(row.quantityBase) }}</span>
                    <span v-if="NICKNAMES[row.quantityBase]" class="text-xs text-muted-foreground">
                      {{ NICKNAMES[row.quantityBase] }}
                    </span>
                  </div>
                </TableCell>

                <!-- They pay -->
                <TableCell class="text-right tabular-nums">
                  <div v-if="row.isTierThreshold && row.tierId" class="flex items-center justify-end">
                    <InputGroup class="h-8 w-24">
                      <InputGroupAddon>$</InputGroupAddon>
                      <InputGroupInput
                        v-model="priceDrafts[row.tierId]"
                        inputmode="decimal"
                        class="text-right tabular-nums"
                        :aria-label="`Total price at ${gramsLabel(row.quantityBase)}`"
                        @blur="saveTier(row)"
                        @keyup.enter="saveTier(row)"
                      />
                    </InputGroup>
                  </div>
                  <span v-else>{{ money(row.totalCents) }}</span>
                </TableCell>

                <TableCell class="text-right tabular-nums text-muted-foreground">
                  {{ money(row.perGramCents) }}
                </TableCell>
                <TableCell
                  class="text-right text-xs tabular-nums"
                  :class="row.savingBps < 0
                    ? 'font-medium text-destructive'
                    : row.savingBps > 0 && row.isTierThreshold
                      ? 'text-primary'
                      : 'text-muted-foreground'"
                  :title="row.savingBps < 0 ? 'This break costs more per gram than the base rate' : undefined"
                >
                  {{ savingLabel(row.savingBps) }}
                </TableCell>
                <TableCell class="text-xs text-muted-foreground">
                  <template v-if="row.isTierThreshold">break</template>
                  <template v-else-if="row.tierId">between breaks</template>
                  <template v-else>base rate</template>
                </TableCell>
                <TableCell class="text-right">
                  <template v-if="row.isTierThreshold && row.tierId">
                    <span v-if="savingTier === row.tierId" class="text-xs text-muted-foreground">Saving…</span>
                    <button
                      v-else
                      class="text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
                      :disabled="removing === row.tierId"
                      @click="removeTier(row.tierId)"
                    >
                      {{ removing === row.tierId ? 'Removing…' : 'Remove' }}
                    </button>
                  </template>
                </TableCell>
              </TableRow>
              <!-- The error sits in its OWN row directly under the one it belongs to. -->
              <TableRow v-if="row.tierId && rowErrors[row.tierId]" :key="`${row.quantityBase}-err`">
                <TableCell colspan="6" class="pt-0 pb-2 text-xs text-destructive">
                  {{ rowErrors[row.tierId] }}
                </TableCell>
              </TableRow>
            </template>

            <!-- the new-break draft row -->
            <TableRow v-if="draftRow" class="bg-accent/40 hover:bg-accent/40">
              <TableCell>
                <div class="flex items-center gap-1.5">
                  <Input
                    v-model="draftRow.grams"
                    inputmode="decimal"
                    placeholder="3.50"
                    aria-label="New break weight in grams"
                    class="h-8 w-20 tabular-nums"
                  />
                  <span class="text-xs text-muted-foreground">g</span>
                </div>
              </TableCell>
              <TableCell class="text-right">
                <div class="flex items-center justify-end">
                  <InputGroup class="h-8 w-24">
                    <InputGroupAddon>$</InputGroupAddon>
                    <InputGroupInput
                      v-model="draftRow.price"
                      inputmode="decimal"
                      placeholder="30.00"
                      aria-label="Total price at the new break"
                      class="text-right tabular-nums"
                      @keyup.enter="saveDraft"
                    />
                  </InputGroup>
                </div>
              </TableCell>
              <TableCell colspan="3" class="whitespace-normal text-xs text-muted-foreground">
                The total someone pays at this weight — the system works the per-gram rate out.
              </TableCell>
              <TableCell class="text-right">
                <Button size="sm" :disabled="!draftValid || draftSaving" @click="saveDraft">
                  {{ draftSaving ? 'Adding…' : 'Add' }}
                </Button>
                <button
                  class="ml-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  @click="draftRow = null"
                >
                  Cancel
                </button>
              </TableCell>
            </TableRow>
            <TableRow v-if="draftError">
              <TableCell colspan="6" class="pt-0 pb-2 text-xs text-destructive">{{ draftError }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <Button v-if="!draftRow" variant="outline" size="sm" class="border-dashed" @click="startDraft">
          ＋ Add a break
        </Button>
        <span v-else></span>

        <!-- the promo-aware spot check -->
        <div class="flex flex-wrap items-center gap-2">
          <FieldLabel for="check-weight" class="text-xs text-muted-foreground">Check any weight</FieldLabel>
          <Input
            id="check-weight"
            v-model="checkWeight"
            inputmode="decimal"
            placeholder="5.00"
            class="h-8 w-24 tabular-nums"
            @keyup.enter="runCheck"
          />
          <Button
            size="sm"
            variant="outline"
            :disabled="checkBase === null || !previewVariant || quoting"
            @click="runCheck"
          >
            {{ quoting ? 'Pricing…' : 'Price it' }}
          </Button>
          <span v-if="quoteResult" class="tabular-nums text-sm font-semibold">
            {{ money(quoteResult.netCents) }}
          </span>
          <span v-if="quoteResult?.tierLabel" class="text-xs text-muted-foreground">
            {{ quoteResult.tierLabel }}
          </span>
        </div>
      </div>

      <p v-if="quoteError" class="text-sm text-destructive">{{ quoteError }}</p>

      <p
        v-if="promoApplied && quoteResult"
        class="rounded-r-md border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
      >
        A promotion is running: the list price is {{ money(quoteResult.grossCents) }}, the
        register will ring {{ money(quoteResult.netCents) }}. The table above is the shelf
        price and deliberately ignores promotions.
      </p>

      <p v-else-if="!previewVariant" class="text-xs text-muted-foreground">
        No variant prices through this group yet, so a weight cannot be quoted against a real
        product. The price list above is still correct — it is the ladder itself.
      </p>

      <p
        v-if="dearerBreaks.length"
        class="rounded-r-md border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <template v-for="(row, i) in dearerBreaks" :key="row.quantityBase">
          <template v-if="i">, </template>
          The {{ gramsLabel(row.quantityBase) }} break charges
          {{ money(row.perGramCents) }}/g, more than the
          {{ money(selected.basePricePerGramCents) }}/g base rate
        </template>
        — buying that much would cost more per gram than buying a gram at a time. Check the
        figure, or remove the break.
      </p>

      <p class="rounded-r-md border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
        Greyed rows are not breaks — they are common weights priced at the surrounding
        break's rate, shown so the list reads like the shelf. Only the rows with a Remove
        button exist in the database.
        <template v-if="firstBreak">
          And note a break makes more weight cost less: just under
          {{ gramsLabel(firstBreak.quantityBase) }} costs more than
          {{ gramsLabel(firstBreak.quantityBase) }} itself, so round a near-miss weight up.
        </template>
      </p>
    </template>
  </div>
</template>
