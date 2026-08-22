<script setup lang="ts">
import type { Socket } from 'socket.io-client'
import { ArrowLeftRight, BookOpen, Clock, Home, Inbox, ReceiptText, ShoppingCart } from '@lucide/vue'
import { useTransfersActionCount } from '~/composables/useTransfersAction'
import { useAuthStore } from '~/stores/auth'

/**
 * The register's icon rail — one source so a new surface (Catalog arrived with the
 * Phase-9 follow-up, Transfers with Phase 10) lands on every screen that shows it, and
 * the active state can't drift between copies.
 *
 * The Transfers item carries the needs-action badge (Kasan's 5B): the rail is on every
 * register page except home, so a request arriving mid-shift is visible from wherever
 * staff actually stand. The count refreshes on every transfer.changed the store's
 * socket room delivers; the badge is a nudge, never the record.
 */
const props = defineProps<{
  /** The route the current page owns, e.g. '/register/sale'. */
  active: string
}>()

const items = [
  { label: 'Home', icon: Home, to: '/register' },
  { label: 'Sale', icon: ShoppingCart, to: '/register/sale' },
  { label: 'Catalog', icon: BookOpen, to: '/register/catalog' },
  { label: 'Deliveries', icon: Inbox, to: '/register/receiving' },
  { label: 'Transfers', icon: ArrowLeftRight, to: '/register/transfers' },
  { label: 'History', icon: ReceiptText, to: '/register/history' },
  { label: 'Shift', icon: Clock, to: '/register/shift' },
]

const auth = useAuthStore()
const { count, refresh } = useTransfersActionCount()
const { $socket } = useNuxtApp() as unknown as { $socket: Socket | null }

const onChanged = () => void refresh()

onMounted(() => {
  void refresh()
  $socket?.on('transfer.changed', onChanged)
})
onUnmounted(() => $socket?.off('transfer.changed', onChanged))

// Pages resolve auth in their own onMounted, so the rail's first refresh can run before
// the principal exists — re-run once it does.
watch(() => auth.principal, () => void refresh())
</script>

<template>
  <nav class="flex w-[76px] shrink-0 flex-col items-center gap-1.5 border-r px-2 py-3" aria-label="Register">
    <NuxtLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      class="flex w-full flex-col items-center gap-1 rounded-xl py-2.5 text-[11px] font-medium transition-colors"
      :class="item.to === props.active
        ? 'bg-primary/12 text-primary'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
      :aria-current="item.to === props.active ? 'page' : undefined"
    >
      <span class="relative">
        <component :is="item.icon" class="size-5" />
        <span
          v-if="item.to === '/register/transfers' && count > 0"
          class="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold leading-none text-black"
          :aria-label="`${count} transfers need action`"
        >
          {{ count }}
        </span>
      </span>
      {{ item.label }}
    </NuxtLink>
  </nav>
</template>
