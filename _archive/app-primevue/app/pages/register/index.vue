<script setup lang="ts">
import { ref } from 'vue'

import { useAuthStore } from '~/stores/auth'

/**
 * Placeholder for the register proper.
 *
 * Shift opening deliberately does NOT live here — it needs the cash-drawer flow designed
 * alongside closing and variance, which is register-phase work.
 */

definePageMeta({ layout: 'register' })

const auth = useAuthStore()
const router = useRouter()
const signingOut = ref(false)

async function signOut(): Promise<void> {
  signingOut.value = true
  try {
    await auth.detach()
    await router.push('/register/sign-in')
  } finally {
    signingOut.value = false
  }
}
</script>

<template>
  <div class="attached">
    <header class="bar">
      <HutaMark />
      <span v-if="auth.registerLabel" class="whereami">{{ auth.registerLabel }}</span>
      <Button
        class="out"
        label="Sign out"
        severity="secondary"
        variant="text"
        :loading="signingOut"
        @click="signOut"
      />
    </header>

    <div class="body">
      <h1>Signed in at this register</h1>
      <p class="lede">
        The device is paired and you're attached to it. The sale screen, cart and checkout
        arrive in the register phase.
      </p>

      <!--
        The one thing this screen can actually do today. Receiving is a register-surface
        task because a terminal session cannot leave /register, and staff are the people
        standing at the door when a delivery arrives.
      -->
      <div class="actions">
        <Button
          label="Take a delivery"
          icon="pi pi-box"
          size="large"
          @click="router.push('/register/receiving')"
        />
      </div>

      <dl class="facts">
        <div>
          <dt>Acting as</dt>
          <dd>{{ auth.displayName ?? auth.principal?.userId ?? '—' }}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{{ auth.principal?.role ?? '—' }}</dd>
        </div>
        <div>
          <dt>Store</dt>
          <dd>{{ auth.terminal?.store.name ?? auth.principal?.storeId ?? '—' }}</dd>
        </div>
        <div>
          <dt>Terminal</dt>
          <dd>{{ auth.terminal?.name ?? auth.principal?.terminalId ?? '—' }}</dd>
        </div>
      </dl>

      <p class="note">
        Signing out returns to the roster — the device stays paired, so nobody has to
        re-enter a pairing code between shifts.
      </p>
    </div>
  </div>
</template>

<style scoped>
.attached {
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 100dvh;
}

.bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem 1.75rem;
}

.bar :deep(.leaf) {
  color: var(--p-primary-color);
}

.whereami {
  margin-left: auto;
  font-size: 0.9375rem;
  color: var(--p-text-muted-color);
}

.out {
  margin-left: 0;
}

.body {
  align-content: center;
  display: grid;
  gap: 1rem;
  padding: 0 clamp(1.5rem, 4vw, 4rem) 4rem;
  max-width: 46rem;
}

h1 {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: -0.015em;
}

.lede,
.note {
  margin: 0;
  color: var(--p-text-muted-color);
}

.note {
  font-size: 0.875rem;
}

.actions {
  display: flex;
  gap: 0.75rem;
  margin: 1.5rem 0 0.5rem;
}

.facts {
  margin: 1rem 0;
  display: grid;
  gap: 0.75rem;
}

.facts > div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--p-content-border-color);
}

dt {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
}
</style>
