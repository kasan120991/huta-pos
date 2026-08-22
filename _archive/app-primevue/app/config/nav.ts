/**
 * The back office navigation, in one place.
 *
 * The sidebar renders this and the topbar's breadcrumb resolves against it, so the two
 * cannot drift apart — a route added here appears in both or in neither.
 *
 * The grouping is a claim about the business, not decoration. PRODUCTS is what we sell,
 * PURCHASING is how it arrives, INVENTORY is what we do to it once it is here. Reconcile
 * sits under Inventory rather than Purchasing because a weight count is stock control, not
 * buying — and it gives Transfers somewhere obvious to land in Phase 10.
 *
 * Icons are `pi pi-*` from PrimeIcons. Without `primeicons/primeicons.css` in
 * `nuxt.config.ts` these render nothing at all.
 */

export interface NavItem {
  readonly label: string
  readonly to: string
  readonly icon: string
  /**
   * Extra paths this item owns for highlighting purposes. `/catalog/products/:id` has no
   * nav entry of its own, but it is plainly "in" Catalog and the sidebar should say so.
   */
  readonly owns?: readonly string[]
}

export interface NavGroup {
  /** Null for the ungrouped items that sit above the first heading. */
  readonly label: string | null
  readonly items: readonly NavItem[]
}

export const NAV: readonly NavGroup[] = [
  {
    label: null,
    items: [{ label: 'Dashboard', to: '/', icon: 'pi pi-home' }],
  },
  {
    label: 'Products',
    items: [
      { label: 'Catalog', to: '/catalog', icon: 'pi pi-th-large', owns: ['/catalog/products'] },
      { label: 'Pricing', to: '/admin/pricing', icon: 'pi pi-tag' },
    ],
  },
  {
    label: 'Purchasing',
    items: [
      { label: 'Suppliers', to: '/admin/suppliers', icon: 'pi pi-truck' },
      { label: 'Orders', to: '/admin/purchase-orders', icon: 'pi pi-file-edit' },
      { label: 'Receiving', to: '/admin/receiving', icon: 'pi pi-box' },
    ],
  },
  {
    label: 'Inventory',
    items: [{ label: 'Reconcile', to: '/admin/reconcile', icon: 'pi pi-sliders-h' }],
  },
]

export interface NavMatch {
  readonly group: NavGroup
  readonly item: NavItem
}

/**
 * Which nav entry a path belongs to.
 *
 * Longest match wins, so `/admin/receiving` beats `/` — every path starts with `/`, and a
 * naive prefix test would light up Dashboard on every screen in the app.
 */
export function matchNav(path: string): NavMatch | null {
  let best: NavMatch | null = null
  let bestLength = -1

  for (const group of NAV) {
    for (const item of group.items) {
      for (const candidate of [item.to, ...(item.owns ?? [])]) {
        const hit = candidate === '/' ? path === '/' : path === candidate || path.startsWith(`${candidate}/`)
        if (hit && candidate.length > bestLength) {
          best = { group, item }
          bestLength = candidate.length
        }
      }
    }
  }

  return best
}
