import type { Component } from 'vue'
import { ArrowLeftRight, Banknote, HandCoins, ClipboardList, Inbox, LayoutGrid, MonitorSmartphone, Package, ReceiptText, Scale, Tag, Truck, Users } from '@lucide/vue'

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
    // Called Sales, not Reports: naming it Reports would promise the Phase-12 margin, supplier
    // and valuation dashboards, which this is not. (Named "Transactions" between 2026-08-24 and
    // 2026-09-03; the group and its sales item swapped names on Kasan's call.)
    label: 'Sales',
    items: [
      // Drawers file here, not under Store: a till is money accountability, while the Store
      // group is devices and people. First in the group since 2026-08-24 — the day's takings
      // are the thing looked at most.
      { title: 'Drawers', to: '/admin/drawers', icon: Banknote },
      // Titled Transactions, matching the page's own <h1> and document title — both renamed
      // alongside this on 2026-09-03. It read "History" until 2026-08-24 and "Sales" until
      // 2026-09-03; each time the heading moved with it, because the breadcrumb resolves
      // against this array precisely so the two cannot drift.
      { title: 'Transactions', to: '/admin/sales', icon: ReceiptText },
      // Payroll files here, not under Store: it is money going out, and it reconciles against
      // the same drawers Drawers reports on.
      { title: 'Payroll', to: '/admin/payroll', icon: HandCoins },
    ],
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
    // Device and people administration — Stores land here too when they get a screen.
    label: 'Store',
    items: [
      { title: 'Registers', to: '/admin/registers', icon: MonitorSmartphone },
      { title: 'Staff', to: '/admin/staff', icon: Users },
    ],
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
