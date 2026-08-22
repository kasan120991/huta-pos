<script setup lang="ts">
import { Pencil } from '@lucide/vue'
import type {
  CatalogProductDetail,
  CatalogReference,
  CatalogVariant,
} from '@huta/shared/schemas'
import StrainDialog from '~/components/catalog/StrainDialog.vue'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { Button } from '~/components/ui/button'
import { apiFetch } from '~/composables/useApi'

/**
 * The strain shelf (Kasan's B2 pick, 2026-08-21) — every strain on one flower product,
 * side by side. Editing opens StrainDialog (the D1 pick); this card is read-only.
 *
 * It exists because strains are VARIANTS of one flower Product (the house rules, Domain model),
 * so the question that matters before anything goes on a shelf is comparative: which of
 * these is missing a COA, which has no potency figure, which came from which supplier.
 * A dialog answers one strain at a time and cannot answer that.
 *
 * Reading the table: a value in plain text is the strain's OWN. A value in italic grey is
 * INHERITED from the product — the shelf's fact, standing in until the strain records its
 * own. An amber "not set" means neither level has it, which is the only state that needs
 * doing something about. The server resolves the fallback and tells us which is which
 * (`identity.sources`), so nothing here re-implements that rule.
 *
 * This card carries identity only. Price, stock and active status stay on the Variants
 * card above — one card, one question.
 */
const props = defineProps<{
  product: CatalogProductDetail
  reference: CatalogReference | null
}>()
const emit = defineEmits<{ saved: [], addStrain: [] }>()

/** THC-A is the figure a flower customer actually asks for, so it gets its own column. */
const THCA_SLUG = 'thc-a'

const suppliers = ref<Array<{ id: string, name: string }>>([])

onMounted(async () => {
  try {
    const res = await apiFetch<{ suppliers: Array<{ id: string, name: string }> }>('/suppliers')
    suppliers.value = res.suppliers
  } catch {
    // Only the supplier picker degrades; every other field still edits.
    suppliers.value = []
  }
})

/* ————— reading the resolved identity ————— */

function identity(v: CatalogVariant) {
  return v.identity ?? null
}

function thca(v: CatalogVariant): { percent: string, inherited: boolean } | null {
  const id = identity(v)
  if (!id) return null
  const link = id.cannabinoids.find((c) => c.cannabinoid.slug === THCA_SLUG)
  if (!link || link.percentBps === null) return null
  return {
    percent: `${(link.percentBps / 100).toFixed(2).replace(/\.?0+$/, '')}%`,
    inherited: id.cannabinoidSource === 'product',
  }
}

const strainTypeLabel = (value: string | null) =>
  value === null ? null : value.charAt(0) + value.slice(1).toLowerCase()

/* ————— editing lives in the dialog (Kasan's D1 pick) ————— */

/** The strain whose dialog is open, or null. */
const editing = ref<CatalogVariant | null>(null)

/** Strains still missing a fact nobody has recorded — the shelf-readiness question. */
const incomplete = computed(() =>
  props.product.variants.filter((v) => {
    const id = identity(v)
    if (!id) return false
    return thca(v) === null || id.coaUrl === null
  }),
)
</script>

<template>
  <div class="rounded-xl border bg-card">
    <div class="flex items-center justify-between border-b px-3.5 py-2">
      <div class="flex items-baseline gap-2">
        <h3 class="text-sm font-semibold">Strains</h3>
        <span class="text-xs text-muted-foreground">
          {{ product.variants.length }}
          {{ product.variants.length === 1 ? 'strain' : 'strains' }} on this shelf
        </span>
      </div>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-primary" @click="emit('addStrain')">
        ＋ Add strain
      </Button>
    </div>

    <div class="overflow-x-auto">
      <Table>
        <TableCaption class="sr-only">
          Strain identity for {{ product.name }}. Italic values are inherited from the product.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Strain</TableHead>
            <TableHead scope="col">Type</TableHead>
            <TableHead scope="col" class="text-right">THCa</TableHead>
            <TableHead scope="col">Nose</TableHead>
            <TableHead scope="col">COA</TableHead>
            <TableHead scope="col">Supplier</TableHead>
            <TableHead><span class="sr-only">Edit</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="v in product.variants" :key="v.id">
            <TableRow :class="v.active ? '' : 'opacity-60'">
              <TableCell class="font-medium">
                {{ v.label ?? product.name }}
                <Badge v-if="!v.active" variant="secondary" class="ml-1.5 text-[10px]">Inactive</Badge>
              </TableCell>

              <TableCell>
                <span
                  v-if="v.identity?.strainType"
                  :class="v.identity.sources.strainType === 'product' ? 'italic text-muted-foreground' : ''"
                >
                  {{ strainTypeLabel(v.identity.strainType) }}
                </span>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </TableCell>

              <TableCell class="text-right tabular-nums">
                <span v-if="thca(v)" :class="thca(v)!.inherited ? 'italic text-muted-foreground' : ''">
                  {{ thca(v)!.percent }}
                </span>
                <Badge
                  v-else
                  class="border-amber-500/40 bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
                >
                  not set
                </Badge>
              </TableCell>

              <TableCell>
                <span
                  v-if="v.identity?.nose"
                  :class="v.identity.sources.nose === 'product' ? 'italic text-muted-foreground' : ''"
                >
                  {{ v.identity.nose }}
                </span>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </TableCell>

              <TableCell>
                <a
                  v-if="v.identity?.coaUrl && v.identity.sources.coaUrl === 'variant'"
                  :href="v.identity.coaUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-primary underline-offset-2 hover:underline"
                >
                  Linked
                </a>
                <a
                  v-else-if="v.identity?.coaUrl"
                  :href="v.identity.coaUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs italic text-muted-foreground underline-offset-2 hover:underline"
                >
                  Shelf COA
                </a>
                <Badge
                  v-else
                  class="border-amber-500/40 bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
                >
                  not set
                </Badge>
              </TableCell>

              <TableCell>
                <span
                  v-if="v.identity?.supplier"
                  :class="v.identity.supplierSource === 'product' ? 'italic text-muted-foreground' : ''"
                >
                  {{ v.identity.supplier.name }}
                </span>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </TableCell>

              <TableCell class="text-right">
                <button
                  type="button"
                  class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  :aria-label="`Edit ${v.label ?? product.name} identity`"
                  @click="editing = v"
                >
                  <Pencil class="size-3.5" />
                </button>
              </TableCell>
            </TableRow>

          </template>
        </TableBody>
      </Table>
    </div>

    <p
      v-if="incomplete.length"
      class="border-t px-3.5 py-2 text-xs text-muted-foreground"
    >
      <span class="font-medium text-amber-600 dark:text-amber-400">{{ incomplete.length }}</span>
      {{ incomplete.length === 1 ? 'strain is' : 'strains are' }} missing a THCa figure or a COA
      of their own:
      {{ incomplete.map((v) => v.label ?? product.name).join(', ') }}.
    </p>

    <StrainDialog
      :open="editing !== null"
      :product="product"
      :variant="editing"
      :reference="reference"
      :suppliers="suppliers"
      @close="editing = null"
      @saved="emit('saved')"
    />
  </div>
</template>
