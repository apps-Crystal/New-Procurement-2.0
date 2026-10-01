/**
 * Navigation.
 *
 * The prototype's four groups (Inventory, Procurement, Receiving, Accounts) are
 * kept in the same order with the same labels. Three groups are added for the
 * screens the prototype never covered: Dashboard at the top, Vendors and
 * Masters at the bottom.
 *
 * Every entry names the permission that reveals it. Hiding a link is presentation
 * only — the route and its service check the same key server-side.
 */
import type { PermissionKey } from '@/lib/auth/permissions';

export interface NavItem {
  href: string;
  label: string;
  permission: PermissionKey;
  /**
   * The phase that builds this screen, while it does not exist yet.
   *
   * The nav lists the whole product from the start, because the shape of the
   * thing is part of what the sidebar communicates. But a link to a screen that
   * has not been written is a 404, and a 404 reads as a bug rather than as
   * "not yet" — so these render as plainly unavailable instead.
   *
   * Delete the marker when the screen lands; the architecture test checks that
   * every unmarked href resolves to a page.
   */
  comingIn?: string;
  /**
   * Shortcuts into the same screen, shown indented beneath it.
   *
   * Not new pages — a child's href is the parent's path with a query string
   * that puts the screen straight into the state the label promises. "Approve
   * requests" is the material request list filtered to the ones waiting on a
   * decision, not a second list.
   *
   * Each child names its own permission, so somebody who may raise a request
   * but not approve one sees only the first.
   */
  children?: NavItem[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', permission: 'DASHBOARD.VIEW' },
      { href: '/approvals', label: 'Pending approvals', permission: 'DASHBOARD.VIEW' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/inventory', label: 'Warehouse stock', permission: 'INVENTORY.VIEW' },
      { href: '/inventory/ledger', label: 'Stock ledger', permission: 'INVENTORY.VIEW' },
      { href: '/inventory/issues', label: 'Stock issues', permission: 'INVENTORY.VIEW' },
      { href: '/inventory/assets', label: 'Asset register', permission: 'ASSET.VIEW' },
      { href: '/damage', label: 'Damaged & missing', permission: 'DAMAGE.VIEW' },
    ],
  },
  {
    label: 'Procurement',
    items: [
      {
        href: '/mr',
        label: 'Material requests',
        permission: 'MR.VIEW',
        children: [
          { href: '/mr?new=1', label: 'Raise a request', permission: 'MR.CREATE' },
          { href: '/mr?stage=MR_DECLARED', label: 'Approve requests', permission: 'MR.APPROVE' },
        ],
      },
      { href: '/transfers', label: 'Stock transfers', permission: 'TRANSFER.VIEW' },
      { href: '/pr', label: 'Purchase requests', permission: 'PR.VIEW' },
      { href: '/quotations', label: 'Vendor quotations', permission: 'QUOTATION.VIEW' },
      { href: '/po', label: 'Purchase orders', permission: 'PO.VIEW' },
    ],
  },
  {
    label: 'Receiving',
    items: [
      { href: '/gate-inward', label: 'Gate inward', permission: 'GATE_INWARD.VIEW' },
      { href: '/qc', label: 'QA/QC inspection', permission: 'QC.VIEW' },
      { href: '/grn', label: 'Goods receipt (GRN)', permission: 'GRN.VIEW' },
      { href: '/shortfalls', label: 'Shortfalls', permission: 'SHORTFALL.VIEW' },
      { href: '/returns', label: 'Purchase returns', permission: 'RTV.VIEW' },
    ],
  },
  {
    label: 'Accounts',
    items: [
      { href: '/invoices', label: 'Vendor invoices', permission: 'INVOICE.VIEW' },
      { href: '/notes', label: 'Debit & credit notes', permission: 'DEBIT_NOTE.VIEW' },
      { href: '/reconciliation', label: 'Vendor reconciliation', permission: 'RECON.VIEW' },
    ],
  },
  {
    label: 'Vendors',
    items: [{ href: '/vendors', label: 'Vendor master', permission: 'VENDOR.VIEW' }],
  },
  {
    label: 'Administration',
    items: [
      { href: '/masters', label: 'Master data', permission: 'MASTER.VIEW' },
      { href: '/audit', label: 'Audit trail', permission: 'AUDIT.VIEW' },
    ],
  },
];

/** Longest matching href wins, so /inventory/ledger doesn't light up /inventory. */
/** Every item, parents and children alike. */
export const navItems = (): NavItem[] => NAV.flatMap(g => g.items.flatMap(i => [i, ...(i.children ?? [])]));

/** A child's href carries a query string; the page it resolves to does not. */
export const navPath = (href: string): string => href.split('?')[0];

export function activeHref(pathname: string): string | null {
  // Parents only. A child is highlighted from the query string too, which the
  // pathname does not carry — the Sidebar does that with the live search params.
  const all = NAV.flatMap(g => g.items.map(i => i.href));
  const matches = all.filter(h => (h === '/' ? pathname === '/' : pathname === h || pathname.startsWith(`${h}/`)));
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}
