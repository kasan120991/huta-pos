import type { Component } from 'vue'
import { ArrowLeftRight, ClipboardList, Inbox, LayoutGrid, MonitorSmartphone, Package, ReceiptText, Scale, Tag, Truck } from '@lucide/vue'

/**
 * The back-office nav, defined ONCE. The sidebar renders it and the topbar breadcrumb
 * resolves against it, so the two cannot drift — the rule carried over from the old shell.
 *
 * Reconcile is filed under Inventory rather than Purchasing because a weight count is
 * stock control, not buying — and it gives Transfers an obvious home in Phase 10.
 */
export interface NavItem {
  title: string
  to: string
  icon: Component
}

export interface NavGroup {
  /** Null renders the group without a label — Dashboard sits ungrouped at the top. */
  label: string | null
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  {
    label: null,
    items: [{ title: 'Dashboard', to: '/', icon: LayoutGrid }],
  },
  {
    // Called Sales, not Reports: naming it Reports would promise the Phase-12 margin,
    // supplier and valuation dashboards, which this is not.
    label: 'Sales',
    items: [{ title: 'History', to: '/admin/sales', icon: ReceiptText }],
  },
  {
    label: 'Products',
    items: [
      { title: 'Catalog', to: '/catalog', icon: Package },
      { title: 'Pricing', to: '/admin/pricing', icon: Tag },
    ],
  },
  {
    label: 'Purchasing',
    items: [
      { title: 'Suppliers', to: '/admin/suppliers', icon: Truck },
      { title: 'Orders', to: '/admin/purchase-orders', icon: ClipboardList },
      { title: 'Receiving', to: '/admin/receiving', icon: Inbox },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { title: 'Transfers', to: '/admin/transfers', icon: ArrowLeftRight },
      { title: 'Reconcile', to: '/admin/reconcile', icon: Scale },
    ],
  },
  {
    // Device and (later) people administration — Users and Stores land here too.
    label: 'Store',
    items: [{ title: 'Registers', to: '/admin/registers', icon: MonitorSmartphone }],
  },
]

/**
 * Which nav entry owns a path. Nested routes resolve to their section — /catalog/products/x
 * still highlights Catalog and breadcrumbs as Products › Catalog.
 */
export function resolveNav(path: string): { group: NavGroup, item: NavItem } | undefined {
  for (const group of NAV) {
    for (const item of group.items) {
      if (path === item.to || path.startsWith(`${item.to}/`)) return { group, item }
    }
  }
  return undefined
}
