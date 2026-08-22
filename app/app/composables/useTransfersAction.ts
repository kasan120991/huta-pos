import type { TransferRow } from '@huta/shared/schemas'
import { apiFetch } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * How many transfers need THIS terminal's store to act — pending or accepted requests
 * it must fill, plus arrivals waiting to be received. One shared number (Kasan's 5B):
 * the rail badge and the home tile both read it, so they can never disagree.
 *
 * State is a `useState` so every consumer shares one count and one in-flight refresh
 * story; the SOCKET subscription stays with the consumers (the rail listens), because a
 * composable cannot own a listener's lifecycle across the several components using it.
 */
export function actionNeeded(transfer: TransferRow, storeId: string): boolean {
  if (transfer.sourceStoreId === storeId) {
    return transfer.status === 'PENDING' || transfer.status === 'ACCEPTED'
  }
  if (transfer.requestingStoreId === storeId) {
    return transfer.status === 'IN_TRANSIT'
  }
  return false
}

export function useTransfersActionCount() {
  const count = useState<number>('transfers-action-count', () => 0)
  const auth = useAuthStore()

  async function refresh() {
    // A bare terminal cannot list transfers (no person attached), and a desk session
    // has no register store to count for.
    if (!auth.isAtTerminal || auth.isUnattendedTerminal || !auth.terminal) {
      count.value = 0
      return
    }
    const storeId = auth.terminal.store.id
    try {
      const data = await apiFetch<{ transfers: TransferRow[] }>('/transfers')
      count.value = data.transfers.filter((t) => actionNeeded(t, storeId)).length
    } catch {
      // The badge is a hint. A failed refresh must never take a page down with it.
      count.value = 0
    }
  }

  return { count, refresh }
}
