<script setup lang="ts">
import type { CatalogProductDetail, CatalogVariant } from '@huta/shared/schemas'
import { ApiError, apiFetch } from '~/composables/useApi'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'

/**
 * TEMPORARY — the barcode-tagging drive (Kasan, 2026-08-22, option 2).
 *
 * 309 of 313 active variants have no barcode, so this exists to work through a shelf with
 * a scanner. Delete this component, the button that opens it in `pages/register/catalog.vue`,
 * and the house note, once the catalogue is tagged.
 *
 * It owns the whole PRODUCT rather than one variant, because a barcode belongs to a
 * ProductVariant: `Regular Flower` does not get one, Blue Dream and Purple Haze each do, and
 * a six-size tincture needs six. One opening, six scans, rather than six round trips.
 *
 * ADMIN ONLY, by the server's rule not ours — `PATCH /catalog/variants/:id` is
 * `requireAdmin` + `catalog.manage`. The caller hides the button for staff; this component
 * would simply get a 403 otherwise.
 */
const props = defineProps<{
  open: boolean
  product: CatalogProductDetail | null
}>()

const emit = defineEmits<{ close: [], saved: [] }>()

/** Codes saved during THIS opening — the payload is not refetched between scans. */
const savedNow = reactive(new Map<string, string>())
const targetId = ref<string | null>(null)
const code = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const scanning = ref(false)
const scanFeedback = ref<{ seq: number, text: string } | null>(null)
let feedbackSeq = 0

const variants = computed<readonly CatalogVariant[]>(() => props.product?.variants ?? [])
const codeFor = (v: CatalogVariant) => savedNow.get(v.id) ?? v.barcode
const untagged = computed(() => variants.value.filter((v) => !codeFor(v)))
const taggedCount = computed(() => variants.value.length - untagged.value.length)

const target = computed(
  () => variants.value.find((v) => v.id === targetId.value) ?? untagged.value[0] ?? null,
)

const variantName = (v: CatalogVariant) => v.label ?? props.product?.name ?? v.sku

/** House rule: state resets when the dialog OPENS, never when it closes. */
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    savedNow.clear()
    targetId.value = null
    code.value = ''
    error.value = null
    busy.value = false
    scanning.value = false
  },
)

function advance() {
  code.value = ''
  error.value = null
  // `untagged` has already recomputed by the time this runs — take the next one that is
  // still blank, so Skip and Save both land somewhere sensible.
  const next = untagged.value.find((v) => v.id !== targetId.value) ?? untagged.value[0] ?? null
  targetId.value = next?.id ?? null
}

function skip() {
  const rest = untagged.value.filter((v) => v.id !== target.value?.id)
  targetId.value = rest[0]?.id ?? null
  code.value = ''
  error.value = null
}

async function save(raw: string) {
  const value = raw.trim()
  const v = target.value
  if (!v || !value || busy.value) return

  busy.value = true
  error.value = null
  try {
    await apiFetch(`/catalog/variants/${v.id}`, { method: 'PATCH', body: { barcode: value } })
    savedNow.set(v.id, value)
    scanFeedback.value = { seq: ++feedbackSeq, text: `✓ ${variantName(v)}` }
    emit('saved')
    advance()
  }
  catch (e) {
    // The server names the colliding product; surface it verbatim rather than paraphrasing.
    error.value
      = e instanceof ApiError ? e.message : 'Could not save that barcode. Try again.'
    scanFeedback.value = { seq: ++feedbackSeq, text: '✗ already used' }
  }
  finally {
    busy.value = false
  }
}

/**
 * A camera hit saves immediately — there is no "confirm" step, because the scanner only
 * fires on a decode and the cost of a wrong one is a re-scan, not a bad sale. The 1.6s
 * same-code cooldown in CameraScanner is what stops one label counting twice.
 */
function onScanned(scanned: string) {
  void save(scanned)
}
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Save barcode</DialogTitle>
        <DialogDescription>
          {{ product?.name }} · {{ taggedCount }} of {{ variants.length }} tagged
        </DialogDescription>
      </DialogHeader>

      <div v-if="target" class="flex flex-col gap-3">
        <div class="rounded-xl border border-primary/40 bg-primary/8 px-3 py-2">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-primary">Scanning now</p>
          <p class="text-base font-bold leading-tight">{{ variantName(target) }}</p>
        </div>

        <Button
          type="button"
          variant="outline"
          class="h-11"
          @click="scanning = !scanning"
        >
          {{ scanning ? 'Close camera' : 'Scan with the camera' }}
        </Button>

        <div class="relative">
          <RegisterCameraScanner
            :open="scanning"
            :feedback="scanFeedback"
            @scanned="onScanned"
            @close="scanning = false"
          />
        </div>

        <!--
          The field is not a fallback for the camera so much as the primary path: a
          keyboard-wedge scanner types into it and submits, which needs no camera, no
          permission prompt and no HTTPS.
        -->
        <form novalidate @submit.prevent="save(code)">
          <Field>
            <FieldLabel for="sbc-code">Or scan / type the code</FieldLabel>
            <Input
              id="sbc-code"
              v-model="code"
              class="h-11 font-mono text-base"
              autocomplete="off"
              inputmode="numeric"
              autofocus
              placeholder="e.g. 850012345689"
            />
            <FieldError v-if="error">{{ error }}</FieldError>
          </Field>
        </form>

        <div v-if="variants.length > 1" class="flex flex-col gap-1">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Variants
          </p>
          <div
            v-for="v in variants"
            :key="v.id"
            class="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
            :class="v.id === target?.id
              ? 'border-primary/50 bg-primary/8'
              : codeFor(v) ? 'opacity-60' : ''"
          >
            <span class="w-4 shrink-0 text-center font-bold" :class="codeFor(v) ? 'text-primary' : 'text-muted-foreground/50'">
              {{ codeFor(v) ? '✓' : v.id === target?.id ? '▸' : '·' }}
            </span>
            <span class="min-w-0 flex-1 truncate font-medium">{{ variantName(v) }}</span>
            <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
              {{ codeFor(v) ?? '—' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Nothing left to tag: reached by working the queue to the end. -->
      <div v-else class="rounded-xl border border-dashed px-4 py-6 text-center">
        <p class="text-sm font-bold">Every variant is tagged</p>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ taggedCount }} of {{ variants.length }} — nothing left on this product.
        </p>
      </div>

      <!--
        h-11 on every footer control: this is the register, and Button's default size is
        h-9 (32px), under the 44px touch floor the rest of the surface holds to. The
        DialogContent close ✕ is 28px and stays that way — it is vendored and shared by
        every dialog in the app, so resizing it here would be a global change smuggled in
        under a temporary feature. Escape and Done both dismiss.
      -->
      <DialogFooter>
        <Button v-if="target && untagged.length > 1" type="button" variant="ghost" class="h-11" @click="skip">
          Skip this one
        </Button>
        <Button
          v-if="target"
          type="button"
          class="h-11 px-6"
          :disabled="!code.trim() || busy"
          @click="save(code)"
        >
          {{ busy ? 'Saving…' : 'Save' }}
        </Button>
        <Button :variant="target ? 'outline' : 'default'" type="button" class="h-11 px-6" @click="emit('close')">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
