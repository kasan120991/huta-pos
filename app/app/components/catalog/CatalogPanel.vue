<script setup lang="ts">
import type { CatalogProductDetail, CatalogVariant } from '@huta/shared/schemas'
import type { BaseQuantity, Cents } from '@huta/shared'
import { formatCents, formatQuantity } from '@huta/shared'
import { Spinner } from '~/components/ui/spinner'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { apiFetch } from '~/composables/useApi'

const props = defineProps<{
  productId: string | null
  storeId: string | undefined
}>()
const emit = defineEmits<{ close: [] }>()

const detail = ref<CatalogProductDetail | null>(null)
const loading = ref(false)
const imageFailed = ref(false)

watch(
  () => props.productId,
  async (id) => {
    detail.value = null
    imageFailed.value = false
    if (!id) return
    loading.value = true
    try {
      detail.value = await apiFetch<CatalogProductDetail>(`/catalog/products/${id}`, {
        query: { storeId: props.storeId },
      })
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

/** Null when the link records no potency — render a muted dash, not an empty chip. */
function potencyLabel(link: CatalogProductDetail['cannabinoids'][number]): string | null {
  if (link.percentBps !== null) return `${(link.percentBps / 100).toFixed(2)}%`
  if (link.mgPerUnit !== null) return `${link.mgPerUnit}mg`
  return null
}

function variantPrice(v: CatalogVariant): string {
  if (v.trackingMode === 'WEIGHT' && v.priceGroup)
    return `${formatCents(v.priceGroup.basePricePerGramCents as Cents)}/g`
  return v.priceCents !== null ? formatCents(v.priceCents as Cents) : '—'
}

function variantStock(v: CatalogVariant): string {
  if (v.stock.status === 'OUT') return 'Out'
  return formatQuantity(v.stock.quantityBase as BaseQuantity, v.trackingMode)
}

const statusClass: Record<string, string> = { OK: 'bg-primary', LOW: 'bg-amber-500', OUT: 'bg-red-400' }

const attributes = computed(() => {
  if (!detail.value) return []
  const out: Array<{ k: string, v: string }> = []
  if (detail.value.strainType) out.push({ k: 'Strain', v: detail.value.strainType })
  if (detail.value.terpeneProfile) out.push({ k: 'Terpenes', v: detail.value.terpeneProfile })
  if (detail.value.nose) out.push({ k: 'Nose', v: detail.value.nose })
  return out
})
</script>

<template>
  <Sheet :open="productId !== null" @update:open="(open: boolean) => !open && emit('close')">
    <SheetContent side="right" class="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
      <SheetHeader class="border-b">
        <SheetTitle class="flex items-center gap-2">
          <span class="truncate">{{ detail?.name ?? 'Loading…' }}</span>
          <Badge v-if="detail?.active" class="border-transparent bg-primary/10 text-primary">Active</Badge>
          <Badge v-else-if="detail" variant="secondary">Inactive</Badge>
        </SheetTitle>
        <SheetDescription>
          <template v-if="detail">
            {{ detail.category.parent ? `${detail.category.parent.name} › ` : '' }}{{ detail.category.name }}
          </template>
          <template v-else>Product preview</template>
        </SheetDescription>
      </SheetHeader>

      <div v-if="detail" class="flex flex-1 flex-col gap-5 p-4">
        <div
          v-if="detail.imageUrl && !imageFailed"
          class="overflow-hidden rounded-xl border bg-accent/30"
        >
          <img :src="detail.imageUrl" :alt="detail.name" class="max-h-44 w-full object-contain" @error="imageFailed = true">
        </div>

        <p v-if="detail.description" class="text-sm text-muted-foreground">{{ detail.description }}</p>

        <section v-if="detail.cannabinoids.length">
          <h3 class="mb-2 text-sm font-semibold">Cannabinoids</h3>
          <div class="flex flex-col gap-1.5">
            <div
              v-for="link in detail.cannabinoids"
              :key="link.cannabinoid.id"
              class="flex items-center justify-between text-sm"
            >
              <span class="text-muted-foreground">{{ link.cannabinoid.name }}</span>
              <span
                v-if="potencyLabel(link)"
                class="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary tabular-nums"
              >
                {{ potencyLabel(link) }}
              </span>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </div>
          </div>
        </section>

        <section v-if="attributes.length" class="grid grid-cols-3 gap-2">
          <div v-for="attr in attributes" :key="attr.k" class="rounded-lg border bg-accent/20 p-2.5">
            <div class="text-[11px] text-muted-foreground">{{ attr.k }}</div>
            <div class="truncate text-sm font-medium" :title="attr.v">{{ attr.v }}</div>
          </div>
        </section>

        <section>
          <h3 class="mb-2 text-sm font-semibold">Details</h3>
          <dl class="flex flex-col gap-1.5 text-sm">
            <div class="flex justify-between">
              <dt class="text-muted-foreground">Brand</dt>
              <dd>{{ detail.brand?.name ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">Supplier</dt>
              <dd>{{ detail.primarySupplier?.name ?? '—' }}</dd>
            </div>
            <div v-if="detail.coaUrl" class="flex justify-between">
              <dt class="text-muted-foreground">COA</dt>
              <dd>
                <a :href="detail.coaUrl" target="_blank" rel="noopener noreferrer" class="text-primary underline-offset-2 hover:underline">
                  View certificate
                </a>
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h3 class="mb-2 text-sm font-semibold">Variants</h3>
          <div class="flex flex-col gap-1.5">
            <div
              v-for="v in detail.variants"
              :key="v.id"
              class="flex items-center justify-between gap-2 text-sm"
            >
              <span class="min-w-0 truncate">
                {{ v.label ?? detail.name }}
                <span v-if="!v.active" class="text-xs text-muted-foreground">(inactive)</span>
              </span>
              <span class="flex shrink-0 items-center gap-3">
                <span class="text-muted-foreground tabular-nums">{{ variantPrice(v) }}</span>
                <span class="flex items-center gap-1.5 tabular-nums">
                  <span class="size-1.5 rounded-full" :class="statusClass[v.stock.status]" />
                  {{ variantStock(v) }}
                </span>
              </span>
            </div>
          </div>
        </section>

        <div class="mt-auto flex gap-2 pt-2">
          <Button class="flex-1" @click="navigateTo(`/catalog/products/${detail.id}`)">
            Open full page
          </Button>
        </div>
      </div>

      <div v-else-if="loading" class="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />Loading…
      </div>
    </SheetContent>
  </Sheet>
</template>
