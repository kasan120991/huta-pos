<script setup lang="ts">
import { FieldError } from '~/components/ui/field'
import { Button } from '~/components/ui/button'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * The "manager comes over" gesture — a full-screen takeover shared by refunds and voids.
 *
 * An admin keys their PIN; the server mints a single-use, action-bound grant and the
 * parent spends it on exactly one operation. The action is spelled out in the title so
 * the admin knows precisely what their PIN authorises. Keyboard works the same way the
 * sign-in pad does: a window-level listener feeds the same model.
 */
const props = defineProps<{
  open: boolean
  /** What the PIN approves, e.g. "Refund $10.40 in cash". */
  title: string
  detail?: string
}>()

const emit = defineEmits<{
  approved: [grantId: string]
  close: []
}>()

const pin = ref('')
const error = ref<string | null>(null)
const authorizing = ref(false)

watch(
  () => props.open,
  (open) => {
    if (open) {
      pin.value = ''
      error.value = null
      authorizing.value = false
    }
  },
)

async function submit() {
  if (pin.value.length < 4 || authorizing.value) return
  authorizing.value = true
  error.value = null
  try {
    const { grantId } = await apiFetch<{ grantId: string }>('/auth/step-up', {
      method: 'POST',
      body: { action: 'sale.refund', pin: pin.value },
    })
    emit('approved', grantId)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong.'
    pin.value = ''
  } finally {
    authorizing.value = false
  }
}

/** Admin PINs are 4–6 digits, so completion cannot be inferred — Enter or the button. */
function onKeydown(event: KeyboardEvent) {
  if (!props.open) return
  if (/^\d$/.test(event.key) && pin.value.length < 6) {
    event.preventDefault()
    pin.value += event.key
  } else if (event.key === 'Backspace') {
    event.preventDefault()
    pin.value = pin.value.slice(0, -1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void submit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- Teleported and above z-50: shadcn Dialog overlays live at body-end on z-50, and a
       receipt dialog can be open UNDER this approval — it must never eat the taps. -->
  <Teleport to="body">
  <div
    v-if="open"
    class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-5 bg-background/[.985] p-8"
    role="dialog"
    aria-modal="true"
    :aria-label="`Manager approval — ${title}`"
  >
    <span class="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-500">
      Manager approval
    </span>
    <div class="text-center">
      <h1 class="text-xl font-extrabold tracking-tight">{{ title }}</h1>
      <p v-if="detail" class="mt-1 text-sm text-muted-foreground">{{ detail }}</p>
    </div>

    <RegisterPinPad v-model="pin" :max-length="6" :disabled="authorizing" @complete="submit" />

    <FieldError v-if="error">{{ error }}</FieldError>

    <div class="flex flex-col items-center gap-2">
      <Button
        class="h-12 w-56 text-base font-bold"
        :disabled="pin.length < 4 || authorizing"
        @click="submit"
      >
        {{ authorizing ? 'Checking…' : 'Approve' }}
      </Button>
      <button
        type="button"
        class="text-sm text-muted-foreground hover:text-foreground"
        @click="emit('close')"
      >
        Cancel
      </button>
    </div>
  </div>
  </Teleport>
</template>
