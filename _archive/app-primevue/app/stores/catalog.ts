import type { StockFilter } from '@huta/shared'
import type {
  CatalogPage,
  CatalogProductDetail,
  CatalogReference,
  CatalogSummary,
  MovementRow,
  ProductInsights,
} from '@huta/shared/schemas'
import { defineStore } from 'pinia'

import { apiFetch } from '~/composables/useApi'

export interface CatalogFilters {
  categories: string[]
  cannabinoids: string[]
  search: string
  stock: StockFilter
  /** Null means every store — the combined view. */
  storeId: string | null
  /** Admin-only reach into inactive products; the server forces 'true' for staff. */
  active?: 'true' | 'all'
  page: number
}

const PAGE_SIZE = 50

export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    page: null as CatalogPage | null,
    reference: null as CatalogReference | null,
    summary: null as CatalogSummary | null,
    loading: false,
    /**
     * The store whose numbers are shown, or null for the combined view.
     *
     * Null is a real value here, not "unset" — the combined view is the default and the
     * most useful one for an admin, who has no home store of their own.
     */
    selectedStoreId: null as string | null,
  }),

  getters: {
    /**
     * The category tree, as the rail renders it.
     *
     * Every parent is included regardless of its count. The previous version dropped any
     * node with `productCount === 0`, which silently removed all five real parents —
     * their counts are zero because products are filed on the LEAVES — and with them the
     * only control that could select a whole branch.
     *
     * Note `Other` is a top-level node WITH products and no children, so a parent is not
     * automatically a heading and the rail has to render both shapes.
     */
    categoryTree(state) {
      const all = state.reference?.categories ?? []
      const parents = all.filter((c) => c.parentId === null)
      return parents.map((parent) => ({
        ...parent,
        children: all.filter((c) => c.parentId === parent.id),
      }))
    },

    /** Stores in the order the table lays its columns out. */
    stores(state) {
      return state.reference?.stores ?? []
    },

    /** The columns the stock table shows: one store, or all of them. */
    visibleStores(state): ReadonlyArray<{ id: string; name: string }> {
      const all = state.reference?.stores ?? []
      if (state.selectedStoreId === null) return all
      return all.filter((s) => s.id === state.selectedStoreId)
    },
  },

  actions: {
    async loadReference(): Promise<void> {
      if (this.reference) return
      this.reference = await apiFetch<CatalogReference>('/catalog/reference')
      // Deliberately NOT defaulting to the first store: null is the combined view, which
      // is what an admin with no home store should land on.
    },

    /** Counts for the summary strip. Cheap, and re-read whenever the store scope changes. */
    async loadSummary(storeId: string | null): Promise<void> {
      this.summary = await apiFetch<CatalogSummary>('/catalog/summary', {
        query: { storeId: storeId ?? undefined },
      })
    },

    async search(filters: CatalogFilters): Promise<void> {
      this.loading = true
      try {
        this.page = await apiFetch<CatalogPage>('/catalog/products', {
          query: {
            categories: filters.categories,
            cannabinoids: filters.cannabinoids,
            search: filters.search || undefined,
            stock: filters.stock === 'all' ? undefined : filters.stock,
            storeId: filters.storeId ?? undefined,
            active: filters.active === 'all' ? 'all' : undefined,
            page: filters.page,
            pageSize: PAGE_SIZE,
          },
        })
      } finally {
        this.loading = false
      }
    },

    async getProduct(id: string, storeId: string | null = null): Promise<CatalogProductDetail> {
      return apiFetch<CatalogProductDetail>(`/catalog/products/${id}`, {
        query: { storeId: storeId ?? undefined },
      })
    },

    async adjust(input: {
      storeId: string
      variantId: string
      countedBase: number
      /** A code from ADJUSTMENT_REASONS — stored in its own column so it is queryable. */
      reasonCode: string
      note?: string
    }): Promise<void> {
      await apiFetch('/inventory/adjust', { method: 'POST', body: input })
    },

    /** Admin-only economics — the caller catches the refusal and renders without them. */
    async getInsights(id: string, storeId: string | null = null): Promise<ProductInsights> {
      return apiFetch<ProductInsights>(`/catalog/products/${id}/insights`, {
        query: { storeId: storeId ?? undefined },
      })
    },

    async getMovements(variantId: string, storeId: string | null = null): Promise<MovementRow[]> {
      const data = await apiFetch<{ movements: MovementRow[] }>(
        `/inventory/movements/${variantId}`,
        { query: { storeId: storeId ?? undefined } },
      )
      return data.movements
    },

    // --- the product editor's write half. All admin-only server-side. -----------------

    async updateProduct(id: string, patch: Record<string, unknown>): Promise<void> {
      await apiFetch(`/catalog/products/${id}`, { method: 'PATCH', body: patch })
    },

    async updateVariant(id: string, patch: Record<string, unknown>): Promise<void> {
      await apiFetch(`/catalog/variants/${id}`, { method: 'PATCH', body: patch })
    },

    async createVariant(productId: string, body: Record<string, unknown>): Promise<void> {
      await apiFetch(`/catalog/products/${productId}/variants`, { method: 'POST', body })
    },

    async setCannabinoids(
      productId: string,
      links: Array<{ cannabinoidId: string; mgPerUnit: number | null; percentBps: number | null }>,
    ): Promise<void> {
      await apiFetch(`/catalog/products/${productId}/cannabinoids`, {
        method: 'PUT',
        body: { links },
      })
    },

    async setImages(
      productId: string,
      images: Array<{ url: string; alt?: string | null }>,
    ): Promise<void> {
      await apiFetch(`/catalog/products/${productId}/images`, { method: 'PUT', body: { images } })
    },

    async createBrand(name: string): Promise<{ id: string; name: string }> {
      const brand = await apiFetch<{ id: string; name: string }>('/catalog/brands', {
        method: 'POST',
        body: { name },
      })
      await this.reloadReference()
      return brand
    },

    /** Bust the reference cache — a brand create means the picker's list just changed. */
    async reloadReference(): Promise<void> {
      this.reference = await apiFetch<CatalogReference>('/catalog/reference')
    },
  },
})
