<script setup lang="ts">
import type { BaseQuantity, TrackingMode } from '@huta/shared'
import { ADJUSTMENT_REASONS, formatQuantity, parseGramsToBase } from '@huta/shared'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * Correct a stock count.
 *
 * Takes what was COUNTED, not the difference — that is how a stocktake actually happens,
 * and nobody should be doing subtraction in their head while holding a clipboard. The
 * delta is derived and shown live, so a mistyped "380" for "38" is visible before it is
 * committed. The count opens BLANK: pre-filling the recorded figure invites
 * rubber-stamping it.
 */
const props = defineProps<{
  open: boolean
  variantId: string
  variantLabel: string
  productName: string
  storeId: string
  storeName: string
  currentBase: number
  trackingMode: TrackingMode
}>()

const emit = defineEmits<{ close: [], adjusted: [] }>()

const counted = ref('')
const reasonCode = ref<string | null>(null)
const note = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) {
      counted.value = ''
      reasonCode.value = null
      note.value = ''
      error.value = null
    }
  },
)

const isWeight = computed(() => props.trackingMode === 'WEIGHT')

/** The typed count in base units, or null while it isn't a valid number. */
const countedBase = computed<number | null>(() => {
  const raw = counted.value.trim()
  if (raw === '') return null
  if (isWeight.value) {
    const parsed = parseGramsToBase(raw)
    return parsed.ok ? parsed.value : null
  }
  return /^\d+$/.test(raw) ? Number(raw) : null
})

/** Why the count doesn't parse, when it doesn't — shown inline, in the parser's words. */
const parseError = computed<string | null>(() => {
  const raw = counted.value.trim()
  if (raw === '') return null
  if (isWeight.value) {
    const parsed = parseGramsToBase(raw)
    return parsed.ok ? null : parsed.message
  }
  return /^\d+$/.test(raw) ? null : 'Enter a whole number of units.'
})

const delta = computed(() =>
  countedBase.value === null ? null : countedBase.value - props.currentBase,
)

/**
 * The ledger row this writes is always type ADJUSTMENT — SHRINKAGE belongs to the
 * weight-reconcile flow. Direction shows in the sign and color, not the type.
 */
const deltaView = computed(() => {
  if (delta.value === null) return null
  if (delta.value === 0) return { kind: 'zero' as const }
  const magnitude = formatQuantity(Math.abs(delta.value) as BaseQuantity, props.trackingMode)
  return delta.value < 0
    ? { kind: 'down' as const, type: 'ADJUSTMENT', magnitude, phrase: 'fewer than recorded' }
    : { kind: 'up' as const, type: 'ADJUSTMENT', magnitude, phrase: 'more than recorded' }
})

const currentLabel = computed(() =>
  formatQuantity(props.currentBase as BaseQuantity, props.trackingMode),
)

const canSubmit = computed(
  () =>
    !submitting.value
    && countedBase.value !== null
    && delta.value !== 0
    && reasonCode.value !== null,
)

async function submit() {
  if (!canSubmit.value || countedBase.value === null || reasonCode.value === null) return
  submitting.value = true
  error.value = null
  try {
    await apiFetch('/inventory/adjust', {
      method: 'POST',
      body: {
        storeId: props.storeId,
        variantId: props.variantId,
        countedBase: countedBase.value,
        reasonCode: reasonCode.value,
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
      },
    })
    emit('adjusted')
    emit('close')
  } catch (err) {
    // The dialog closes only on success — an error stays inside it.
    error.value =
      err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Adjust stock</DialogTitle>
        <DialogDescription>
          {{ productName }}<template v-if="variantLabel !== productName"> · {{ variantLabel }}</template>
          · {{ storeName }}
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
        <FieldGroup class="gap-4">
          <Field :data-invalid="!!parseError">
            <FieldLabel for="adjust-counted">
              Counted quantity
              <span class="font-normal text-muted-foreground"> — system shows {{ currentLabel }}</span>
            </FieldLabel>
            <!-- The unit rides in an end addon; the count itself stays the big number. -->
            <InputGroup class="h-11">
              <InputGroupInput
                id="adjust-counted"
                v-model="counted"
                :inputmode="isWeight ? 'decimal' : 'numeric'"
                autocomplete="off"
                class="text-lg font-semibold tabular-nums"
                :aria-invalid="!!parseError"
                autofocus
              />
              <InputGroupAddon align="inline-end">{{ isWeight ? 'grams' : 'units' }}</InputGroupAddon>
            </InputGroup>
            <FieldError v-if="parseError">{{ parseError }}</FieldError>
          </Field>

          <div
            v-if="deltaView"
            class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
            :class="{
              'bg-red-400/10 text-red-400': deltaView.kind === 'down',
              'bg-primary/10 text-primary': deltaView.kind === 'up',
              'bg-accent text-muted-foreground': deltaView.kind === 'zero',
            }"
          >
            <template v-if="deltaView.kind === 'zero'">
              Matches the recorded quantity — nothing to post.
            </template>
            <template v-else>
              <span class="rounded border border-current px-1.5 font-mono text-[10px] font-semibold opacity-90">
                {{ deltaView.type }}
              </span>
              <span class="font-semibold tabular-nums">
                {{ deltaView.kind === 'down' ? '−' : '+' }}{{ deltaView.magnitude }}
              </span>
              <span>{{ deltaView.phrase }}</span>
            </template>
          </div>

          <Field>
            <FieldLabel id="adjust-reason-label">Reason</FieldLabel>
            <ToggleGroup
              :model-value="reasonCode"
              type="single"
              variant="outline"
              :spacing="1.5"
              aria-labelledby="adjust-reason-label"
              class="flex-wrap"
              @update:model-value="(v) => v && (reasonCode = v as typeof reasonCode)"
            >
              <ToggleGroupItem
                v-for="reason in ADJUSTMENT_REASONS"
                :key="reason.code"
                :value="reason.code"
                class="rounded-full px-3"
              >
                {{ reason.label }}
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <Field>
            <FieldLabel for="adjust-note">
              Note <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="adjust-note" v-model="note" maxlength="500" autocomplete="off" />
          </Field>
        </FieldGroup>

        <FieldError v-if="error">{{ error }}</FieldError>

        <DialogFooter>
          <Button type="button" variant="ghost" @click="emit('close')">Cancel</Button>
          <Button type="submit" :disabled="!canSubmit">
            {{ submitting ? 'Posting…' : 'Post adjustment' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
