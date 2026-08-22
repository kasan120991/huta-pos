<script setup lang="ts">
import { FieldError } from '~/components/ui/field'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { ApiError } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * Terminal pairing. Seen once per device, by whoever sets the register up. PUBLIC by
 * design — an unpaired device presents no cookies, so it is indistinguishable from a
 * signed-out admin.
 */
definePageMeta({ layout: 'register' })

const auth = useAuthStore()
const router = useRouter()

const code = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const paired = ref<{ store: string, terminal: string } | null>(null)

async function submit() {
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
    // ONE message for unknown, already-used and expired codes — saying "expired" would
    // confirm the code existed. Surface it as-is.
    error.value = err instanceof ApiError ? err.message : 'Could not reach the server. Try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex flex-1 flex-col">
    <RegisterBar />
    <div class="flex flex-1 items-center justify-center p-8">
      <div v-if="paired" class="flex flex-col items-center gap-4 text-center">
        <div class="flex size-16 items-center justify-center rounded-full bg-primary text-2xl text-primary-foreground" aria-hidden="true">✓</div>
        <h1 class="text-3xl font-bold tracking-tight">Register paired</h1>
        <p class="text-lg">
          <strong>{{ paired.store }}</strong>
          <span class="mx-2 text-muted-foreground">·</span>
          {{ paired.terminal }}
        </p>
        <p class="text-muted-foreground">Taking you to sign-in…</p>
      </div>

      <form v-else class="flex w-full max-w-sm flex-col items-center gap-5 text-center" novalidate @submit.prevent="submit">
        <svg class="size-11 text-primary" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3c4 3 6 7 6 11a6 6 0 0 1-12 0c0-4 2-8 6-11Z" stroke="currentColor" stroke-width="1.6" />
          <path d="M12 8v11" stroke="currentColor" stroke-width="1.6" />
        </svg>
        <h1 class="text-3xl font-bold tracking-tight">Pair this register</h1>
        <p class="text-muted-foreground">Enter the code from the back office. It expires after ten minutes.</p>
        <Input
          v-model="code"
          class="h-14 w-56 text-center font-mono text-2xl tracking-[0.25em]"
          placeholder="XXXX-XXXX"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          aria-label="Pairing code"
          :disabled="submitting"
          autofocus
        />
        <FieldError v-if="error">{{ error }}</FieldError>
        <Button type="submit" size="lg" class="h-12 px-8 text-base" :disabled="submitting">
          {{ submitting ? 'Pairing…' : 'Pair register' }}
        </Button>
      </form>
    </div>
  </div>
</template>
