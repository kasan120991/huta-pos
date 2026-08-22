<script setup lang="ts">
import type { CatalogProductDetail, ProductImageInput } from '@huta/shared/schemas'
import { ArrowDown, ArrowUp, Pencil, X } from '@lucide/vue'
import { FieldError } from '~/components/ui/field'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * The Media rail card — Kasan's 3A pick: the card itself flips into edit state.
 *
 * URL-based by decision (no uploads yet). Reorder is ▲▼ buttons — keyboard-safe, no
 * dependency — and the ARRAY ORDER is the saved sort order; the first image is the
 * product's thumbnail everywhere. Nothing touches the server until Save, which is one
 * full-array PUT; Save stays disabled until something actually changed. Existing alt
 * text rides along untouched.
 */
const props = defineProps<{
  product: CatalogProductDetail
  editable: boolean
}>()
const emit = defineEmits<{ saved: [] }>()

const editing = ref(false)
const draft = ref<Array<{ url: string, alt: string | null }>>([])
const newUrl = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const failed = ref<Record<string, boolean>>({})

function startEditing() {
  draft.value = props.product.images.map((img) => ({ url: img.url, alt: img.alt ?? null }))
  newUrl.value = ''
  error.value = null
  editing.value = true
}

function cancel() {
  editing.value = false
  error.value = null
}

const urlValid = computed(() => /^https?:\/\/.+/.test(newUrl.value.trim()))

function addUrl() {
  const url = newUrl.value.trim()
  if (!urlValid.value) return
  if (draft.value.some((img) => img.url === url)) {
    error.value = 'That image is already in the list.'
    return
  }
  if (draft.value.length >= 12) {
    error.value = 'Twelve images is the limit.'
    return
  }
  draft.value.push({ url, alt: null })
  newUrl.value = ''
  error.value = null
}

function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= draft.value.length) return
  const [row] = draft.value.splice(index, 1)
  draft.value.splice(target, 0, row!)
}

function remove(index: number) {
  draft.value.splice(index, 1)
  error.value = null
}

/** Save only when the set or the order genuinely changed. */
const dirty = computed(() => {
  const current = props.product.images
  if (draft.value.length !== current.length) return true
  return draft.value.some((img, index) => img.url !== current[index]?.url)
})

async function save() {
  if (!dirty.value || saving.value) return
  saving.value = true
  error.value = null
  const images: ProductImageInput[] = draft.value.map((img) => ({ url: img.url, alt: img.alt }))
  try {
    await apiFetch(`/catalog/products/${props.product.id}/images`, {
      method: 'PUT',
      body: { images },
    })
    editing.value = false
    emit('saved')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    saving.value = false
  }
}

const shortUrl = (url: string) => url.replace(/^https?:\/\//, '')
</script>

<template>
  <div class="rounded-xl border bg-card p-3.5">
    <div class="mb-2 flex items-center justify-between">
      <h3 class="text-sm font-semibold">Media</h3>
      <span v-if="editing" class="text-xs font-medium text-primary">editing</span>
      <button
        v-else-if="editable"
        type="button"
        class="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Edit images"
        @click="startEditing"
      >
        <Pencil class="size-3.5" />
      </button>
    </div>

    <!-- view -->
    <template v-if="!editing">
      <div v-if="product.images.length" class="flex flex-wrap gap-2">
        <div
          v-for="img in product.images"
          :key="img.url"
          class="flex size-14 items-center justify-center overflow-hidden rounded-lg border bg-accent/30"
        >
          <img
            v-if="!failed[img.url]"
            :src="img.url"
            :alt="img.alt ?? ''"
            class="size-full object-cover"
            @error="failed[img.url] = true"
          >
          <span v-else class="text-sm font-semibold text-muted-foreground">{{ product.name.charAt(0) }}</span>
        </div>
      </div>
      <p v-else class="text-sm text-muted-foreground">No images yet.</p>
    </template>

    <!-- edit -->
    <template v-else>
      <div class="flex flex-col gap-1.5">
        <div
          v-for="(img, index) in draft"
          :key="img.url"
          class="flex items-center gap-1.5 rounded-lg border bg-background/60 p-1.5"
        >
          <div class="flex flex-col gap-0.5">
            <button
              type="button"
              class="flex h-4 w-5 items-center justify-center rounded border text-muted-foreground hover:bg-accent disabled:opacity-30"
              :disabled="index === 0"
              :aria-label="`Move image ${index + 1} up`"
              @click="move(index, -1)"
            >
              <ArrowUp class="size-2.5" />
            </button>
            <button
              type="button"
              class="flex h-4 w-5 items-center justify-center rounded border text-muted-foreground hover:bg-accent disabled:opacity-30"
              :disabled="index === draft.length - 1"
              :aria-label="`Move image ${index + 1} down`"
              @click="move(index, 1)"
            >
              <ArrowDown class="size-2.5" />
            </button>
          </div>
          <div class="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-accent/30">
            <img
              v-if="!failed[img.url]"
              :src="img.url"
              alt=""
              class="size-full object-cover"
              @error="failed[img.url] = true"
            >
            <span v-else class="text-xs font-semibold text-muted-foreground">{{ index + 1 }}</span>
          </div>
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" :title="img.url">
            {{ shortUrl(img.url) }}
          </span>
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            :aria-label="`Remove image ${index + 1}`"
            @click="remove(index)"
          >
            <X class="size-3" />
          </button>
        </div>

        <div class="flex gap-1.5">
          <Input
            v-model="newUrl"
            placeholder="Paste an image URL…"
            autocomplete="off"
            class="h-8 text-xs"
            aria-label="New image URL"
            @keydown.enter.prevent="addUrl"
          />
          <Button type="button" variant="outline" size="sm" class="h-8 shrink-0 text-xs" :disabled="!urlValid" @click="addUrl">
            Add
          </Button>
        </div>

        <FieldError v-if="error" class="text-xs">{{ error }}</FieldError>

        <div class="mt-1 flex justify-end gap-1.5">
          <Button type="button" variant="ghost" size="sm" class="h-8 text-xs" @click="cancel">Cancel</Button>
          <Button type="button" size="sm" class="h-8 text-xs" :disabled="!dirty || saving" @click="save">
            {{ saving ? 'Saving…' : 'Save order' }}
          </Button>
        </div>
      </div>
    </template>
  </div>
</template>
