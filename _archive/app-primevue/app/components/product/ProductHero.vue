<script setup lang="ts">
import type { CatalogProductDetail } from '@huta/shared/schemas'
import { computed, ref } from 'vue'

import { useCatalogStore } from '~/stores/catalog'

/**
 * The identity band: image, name, status, provenance, and the store scope control.
 *
 * The scope Select lives HERE rather than in the topbar because only this page (and the
 * catalog index) honours a store scope — a global switcher would imply a scope the rest of
 * the app does not have. The options come from the reference store list, not the payload's
 * `stores`, because the payload is already narrowed by the current scope.
 */
const props = defineProps<{
  product: CatalogProductDetail
  storeId: string | null
}>()

const emit = defineEmits<{ 'update:storeId': [value: string | null] }>()

const catalog = useCatalogStore()

const imgFailed = ref(false)

/** Hot-linked legacy URLs 404 and hotlink-block; the fallback tile is the common case. */
const showImage = computed(() => props.product.imageUrl !== null && !imgFailed.value)

const scopeOptions = computed(() => [
  { label: 'All stores', value: null },
  ...catalog.stores.map((s) => ({ label: s.name, value: s.id })),
])

const meta = computed(() => {
  const parts: string[] = []
  if (props.product.brand) parts.push(props.product.brand.name)
  if (props.product.primarySupplier) parts.push(`supplied by ${props.product.primarySupplier.name}`)
  if (props.product.strainType) parts.push(humanStrain(props.product.strainType))
  return parts
})

function humanStrain(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase()
}
</script>

<template>
  <header class="hero">
    <img
      v-if="showImage"
      class="thumb"
      :src="product.imageUrl ?? undefined"
      alt=""
      width="72"
      height="72"
      referrerpolicy="no-referrer"
      @error="imgFailed = true"
    />
    <span v-else class="thumb ph" aria-hidden="true">{{ product.name.charAt(0) }}</span>

    <div class="who">
      <div class="nameline">
        <h1>{{ product.name }}</h1>
        <Tag v-if="!product.active" severity="warn" value="Inactive" />
        <StockPill :status="product.stock.status" />
      </div>
      <p class="meta">
        <template v-if="meta.length > 0">{{ meta.join(' · ') }}</template>
        <EmptyValue v-else label="no brand or supplier recorded" />
      </p>
    </div>

    <div class="side">
      <Select
        :model-value="storeId"
        :options="scopeOptions"
        option-label="label"
        option-value="value"
        size="small"
        aria-label="Store scope"
        @update:model-value="emit('update:storeId', $event)"
      />
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.thumb {
  flex: none;
  width: 72px;
  height: 72px;
  border-radius: 0.55rem;
  object-fit: cover;
  background: var(--p-surface-100);
  border: 1px solid var(--p-content-border-color);
}

.app-dark .thumb {
  background: var(--p-surface-800);
}

.ph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  font-weight: 650;
  color: var(--p-text-muted-color);
  user-select: none;
}

.who {
  min-width: 0;
  flex: 1;
}

.nameline {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

h1 {
  margin: 0;
  font-size: 1.625rem;
  letter-spacing: -0.02em;
}

.meta {
  margin: 0.15rem 0 0;
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
}

.side {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: none;
}

@container content (max-width: 700px) {
  .hero {
    flex-wrap: wrap;
  }

  .side {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
