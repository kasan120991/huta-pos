<script setup lang="ts">
import { ref } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * Terminal pairing. Seen once per device, by whoever sets the register up.
 */

definePageMeta({ layout: 'register' })

const auth = useAuthStore()
const router = useRouter()

const code = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const paired = ref<{ store: string; terminal: string } | null>(null)

async function submit(): Promise<void> {
  error.value = null
  if (code.value.trim().length < 4) {
    error.value = 'Enter the code from the back office.'
    return
  }

  submitting.value = true
  try {
    const result = await auth.pairTerminal(code.value.trim())
    // Echo the match back before moving on, so whoever set this up can confirm they
    // paired the right machine to the right store rather than finding out at opening.
    paired.value = { store: result.store.name, terminal: result.terminal.name }
    setTimeout(() => {
      void router.push('/register/sign-in')
    }, 1800)
  } catch (err) {
    // The server returns ONE message for unknown, already-used and expired codes — saying
    // "expired" would confirm the code existed. Surface it as-is.
    error.value =
      err instanceof ApiError ? err.message : 'Could not reach the server. Try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="pair">
    <div v-if="paired" class="done">
      <div class="tick" aria-hidden="true">✓</div>
      <h1>Register paired</h1>
      <p class="match">
        <strong>{{ paired.store }}</strong>
        <span class="sep">·</span>
        {{ paired.terminal }}
      </p>
      <p class="hint">Taking you to sign-in…</p>
    </div>

    <form v-else class="form" novalidate @submit.prevent="submit">
      <div class="brand">
        <HutaMark :size="42" />
      </div>

      <h1>Pair this register</h1>
      <p class="lede">Enter the code from the back office. It expires after ten minutes.</p>

      <InputText
        v-model="code"
        class="code"
        :invalid="Boolean(error)"
        :disabled="submitting"
        placeholder="XXXX-XXXX"
        autocapitalize="characters"
        autocomplete="off"
        spellcheck="false"
        aria-label="Pairing code"
      />

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <Button type="submit" label="Pair register" size="large" :loading="submitting" />
    </form>
  </div>
</template>

<style scoped>
.pair {
  place-content: center;
  justify-items: center;
  padding: 2rem;
}

.form,
.done {
  display: grid;
  justify-items: center;
  gap: 1.25rem;
  text-align: center;
  max-width: 26rem;
}

.brand {
  color: var(--p-primary-color);
}

h1 {
  margin: 0;
  font-size: 1.875rem;
  letter-spacing: -0.02em;
}

.lede,
.hint {
  margin: 0;
  color: var(--p-text-muted-color);
}

.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 2rem;
  letter-spacing: 0.25em;
  text-align: center;
  width: 11rem;
  padding: 0.75rem;
}

.tick {
  width: 4rem;
  height: 4rem;
  border-radius: 50%;
  display: grid;
  place-content: center;
  font-size: 1.75rem;
  color: var(--p-primary-contrast-color);
  background: var(--p-primary-color);
}

.match {
  margin: 0;
  font-size: 1.125rem;
}

.sep {
  margin: 0 0.5rem;
  color: var(--p-text-muted-color);
}
</style>
