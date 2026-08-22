<script setup lang="ts">
import type { ShiftRow } from '@huta/shared/schemas'
import { ArrowLeftRight, BookOpen, Clock, Inbox, LogOut, ShoppingCart } from '@lucide/vue'
import { apiFetch } from '~/composables/useApi'
import { useTransfersActionCount } from '~/composables/useTransfersAction'
import { useAuthStore } from '~/stores/auth'

/**
 * The register home an attached person lands on — staff, or an admin covering the
 * counter (the guard keys on the TERMINAL, not the role).
 */
definePageMeta({ layout: 'register' })

const auth = useAuthStore()
const router = useRouter()

const shift = ref<ShiftRow | null>(null)
const shiftResolved = ref(false)
const { count: transfersNeedAction, refresh: refreshTransfers } = useTransfersActionCount()

onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) {
    await router.replace('/register/pair')
  } else if (auth.isUnattendedTerminal) {
    await router.replace('/register/sign-in')
  } else if (!auth.isAtTerminal) {
    // A desk session has no business on the register surface.
    await router.replace('/')
  } else {
    void refreshTransfers()
    try {
      const data = await apiFetch<{ shift: ShiftRow | null }>('/shifts/current', {
        query: { storeId: auth.terminal?.store.id },
      })
      shift.value = data.shift
    } finally {
      shiftResolved.value = true
    }
  }
})

async function signOut() {
  await auth.detach()
  await router.replace('/register/sign-in')
}

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
</script>

<template>
  <div class="flex flex-1 flex-col">
    <RegisterBar>
      <button
        v-if="auth.user"
        type="button"
        class="flex items-center gap-2 rounded-full bg-accent py-1 pl-1.5 pr-3 text-sm text-foreground transition-colors hover:bg-accent/70"
        @click="signOut"
      >
        <span class="flex size-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
          {{ auth.initials }}
        </span>
        {{ auth.displayName }}
        <LogOut class="size-3.5 text-muted-foreground" />
      </button>
    </RegisterBar>

    <div v-if="auth.user" class="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <h1 class="text-2xl font-extrabold tracking-tight">
        Welcome, {{ auth.user.firstName }}
      </h1>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <NuxtLink
          to="/register/sale"
          class="flex h-36 w-56 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span class="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShoppingCart class="size-5" />
          </span>
          <span class="text-base font-bold">New sale</span>
          <span class="text-xs text-muted-foreground">
            {{ shiftResolved && !shift ? 'Opens the shift first' : 'Ring up a customer' }}
          </span>
        </NuxtLink>
        <NuxtLink
          to="/register/catalog"
          class="flex h-36 w-56 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span class="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <BookOpen class="size-5" />
          </span>
          <span class="text-base font-bold">Catalog</span>
          <span class="text-xs text-muted-foreground">Prices, potency, both stores</span>
        </NuxtLink>
        <NuxtLink
          to="/register/transfers"
          class="flex h-36 w-56 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span class="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ArrowLeftRight class="size-5" />
          </span>
          <span class="text-base font-bold">Transfers</span>
          <span
            class="text-xs"
            :class="transfersNeedAction > 0 ? 'font-semibold text-amber-500' : 'text-muted-foreground'"
          >
            {{ transfersNeedAction > 0
              ? `${transfersNeedAction} need${transfersNeedAction === 1 ? 's' : ''} action`
              : 'Between the stores' }}
          </span>
        </NuxtLink>
        <NuxtLink
          to="/register/receiving"
          class="flex h-36 w-56 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span class="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Inbox class="size-5" />
          </span>
          <span class="text-base font-bold">Take a delivery</span>
          <span class="text-xs text-muted-foreground">Count in what arrived</span>
        </NuxtLink>
        <NuxtLink
          to="/register/shift"
          class="flex h-36 w-56 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span class="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Clock class="size-5" />
          </span>
          <span class="text-base font-bold">Shift</span>
          <span class="text-xs text-muted-foreground">
            <template v-if="!shiftResolved">…</template>
            <template v-else-if="shift">Open since {{ timeFmt.format(new Date(shift.openedAt)) }}</template>
            <template v-else>Not open yet</template>
          </span>
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
