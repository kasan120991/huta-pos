<script setup lang="ts">
import type { CatalogProductDetail } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * The image gallery, and — for an admin — its editor.
 *
 * Editing works on a draft list saved as a whole: the array order IS the display order,
 * and the first image is the catalog thumbnail. Reordering is up/down buttons rather than
 * drag — no dependency, works with a keyboard. Legacy images are hot-linked third-party
 * URLs, so failures are expected and each tile falls back individually.
 */
const props = defineProps<{
  product: CatalogProductDetail
  canEdit: boolean
}>()

const emit = defineEmits<{ saved: [] }>()

const catalog = useCatalogStore()

const draft = ref(props.product.images.map((i) => ({ url: i.url, alt: i.alt })))
watch(
  () => props.product.images,
  (images) => {
    draft.value = images.map((i) => ({ url: i.url, alt: i.alt }))
  },
)

const newUrl = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const savedAt = ref<number | null>(null)

const failed = ref(new Set<string>())

function markFailed(url: string): void {
  const next = new Set(failed.value)
  next.add(url)
  failed.value = next
}

const dirty = computed(() => {
  const current = props.product.images.map((i) => i.url)
  const edited = draft.value.map((i) => i.url)
  return current.length !== edited.length || current.some((url, i) => url !== edited[i])
})

const urlValid = computed(() => /^https?:\/\/.+/.test(newUrl.value.trim()))

function add(): void {
  const url = newUrl.value.trim()
  if (!urlValid.value || draft.value.some((i) => i.url === url)) return
  draft.value.push({ url, alt: null })
  newUrl.value = ''
  savedAt.value = null
}

function remove(index: number): void {
  draft.value.splice(index, 1)
  savedAt.value = null
}

function move(index: number, delta: -1 | 1): void {
  const target = index + delta
  if (target < 0 || target >= draft.value.length) return
  const [item] = draft.value.splice(index, 1)
  draft.value.splice(target, 0, item!)
  savedAt.value = null
}

async function save(): Promise<void> {
  saving.value = true
  error.value = null
  try {
    await catalog.setImages(
      props.product.id,
      draft.value.map((i) => ({ url: i.url, alt: i.alt })),
    )
    savedAt.value = Date.now()
    emit('saved')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not save the images.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="media">
    <template v-if="draft.length > 0">
      <div class="grid">
        <figure v-for="(image, index) in draft" :key="image.url" class="cell">
          <img
            v-if="!failed.has(image.url)"
            :src="image.url"
            :alt="image.alt ?? ''"
            loading="lazy"
            referrerpolicy="no-referrer"
            @error="markFailed(image.url)"
          />
          <span v-else class="broken">Image unavailable</span>
          <figcaption v-if="index === 0" class="primary">Primary</figcaption>
          <div v-if="canEdit" class="tools">
            <button
              type="button"
              :disabled="index === 0"
              :aria-label="`Move image ${index + 1} earlier`"
              @click="move(index, -1)"
            >
              ‹
            </button>
            <button
              type="button"
              :disabled="index === draft.length - 1"
              :aria-label="`Move image ${index + 1} later`"
              @click="move(index, 1)"
            >
              ›
            </button>
            <button
              type="button"
              class="danger"
              :aria-label="`Remove image ${index + 1}`"
              @click="remove(index)"
            >
              ×
            </button>
          </div>
        </figure>
      </div>
      <p class="note">The first image is the thumbnail shown in the catalog.</p>
    </template>
    <div v-else class="empty">
      <p>No images yet.</p>
    </div>

    <template v-if="canEdit">
      <div class="addrow">
        <InputText
          v-model="newUrl"
          placeholder="https://… image URL"
          size="small"
          class="urlinput"
          autocomplete="off"
          aria-label="New image URL"
          @keydown.enter.prevent="add"
        />
        <Button label="Add" size="small" severity="secondary" :disabled="!urlValid" @click="add" />
        <Button label="Save images" size="small" :disabled="!dirty" :loading="saving" @click="save" />
      </div>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <p v-else-if="savedAt" class="ok">Saved.</p>
    </template>
  </div>
</template>

<style scoped>
.media {
  display: grid;
  gap: 0.75rem;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.75rem;
}

.cell {
  position: relative;
  margin: 0;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--p-surface-100);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.app-dark .cell {
  background: var(--p-surface-800);
}

.cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.broken {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.primary {
  position: absolute;
  top: 0.4rem;
  left: 0.4rem;
  padding: 0.1rem 0.45rem;
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-content-background) 85%, transparent);
  border-radius: 0.25rem;
}

.tools {
  position: absolute;
  bottom: 0.4rem;
  right: 0.4rem;
  display: flex;
  gap: 0.25rem;
}

.tools button {
  width: 1.6rem;
  height: 1.6rem;
  font: inherit;
  font-size: 0.9rem;
  line-height: 1;
  color: var(--p-text-color);
  background: color-mix(in srgb, var(--p-content-background) 92%, transparent);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.3rem;
  cursor: pointer;
}

.tools button:disabled {
  opacity: 0.4;
  cursor: default;
}

.tools button.danger:hover {
  color: var(--p-red-500);
}

.tools button:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.note {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

.empty {
  padding: 2.5rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.empty p {
  margin: 0;
}

.addrow {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.urlinput {
  flex: 1;
  min-width: 14rem;
}

.ok {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-primary-color);
}
</style>
