<script setup lang="ts">
import { Camera, X } from '@lucide/vue'
import { Input } from '~/components/ui/input'

/**
 * A text input with a clear (×) button — every search and scan box wears this so "wipe
 * it and start over" is one tap everywhere. Clearing refocuses the input, which matters
 * at the register where the scan bar must keep focus for the next barcode.
 *
 * `scanner` adds a camera button (the iPad-as-barcode-scanner entry point). It renders
 * ONLY where the camera can actually work — a device with getUserMedia on a secure
 * origin — so desktops over plain HTTP and camera-less registers never see a dead
 * button.
 *
 * Attrs (class, placeholder, inputmode, aria-label…) fall through to the inner Input;
 * the wrapper only positions the buttons, so call sites keep their exact styling and
 * their own leading icons.
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{ scanner?: boolean }>()

const model = defineModel<string>({ default: '' })

const emit = defineEmits<{ cleared: [], scan: [] }>()

const scannerAvailable = computed(
  () =>
    props.scanner === true &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia,
)

const inputRef = ref<{ $el?: HTMLInputElement } | HTMLInputElement | null>(null)

function focus() {
  const el = inputRef.value
  const input = el instanceof HTMLInputElement ? el : el?.$el
  input?.focus()
}

function clear() {
  model.value = ''
  emit('cleared')
  focus()
}

defineExpose({ focus })
</script>

<template>
  <div class="relative">
    <Input
      ref="inputRef"
      v-model="model"
      v-bind="$attrs"
      :class="scannerAvailable ? 'pr-16' : 'pr-9'"
    />
    <button
      v-if="model.length > 0"
      type="button"
      class="absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      :class="scannerAvailable ? 'right-9' : 'right-1.5'"
      aria-label="Clear"
      @click="clear"
    >
      <X class="size-3.5" />
    </button>
    <button
      v-if="scannerAvailable"
      type="button"
      class="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-primary/12 text-primary transition-colors hover:bg-primary/20"
      aria-label="Scan with the camera"
      @click="emit('scan')"
    >
      <Camera class="size-4" />
    </button>
  </div>
</template>
