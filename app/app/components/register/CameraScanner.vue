<script setup lang="ts">
import { BarcodeDetector } from 'barcode-detector/ponyfill'
import { X } from '@lucide/vue'

/**
 * The camera as a DROP-DOWN under the scan bar (Kasan's C pick, 2026-08-19 — replacing
 * the earlier full-screen takeover) — and CONTINUOUS everywhere: the panel stays open,
 * each hit flashes, blips, toasts the parent's feedback, and scanning carries on until
 * the ✕ (or Escape, or the 📷 toggle) closes it. The page stays fully live around it —
 * cart, grid, and the search box all keep working while the camera runs.
 *
 * Decoding is the standard BarcodeDetector API via the zxing ponyfill (WASM on WebKit,
 * native where it exists). The component only decodes — the PARENT owns what a code
 * means, and a per-code cooldown keeps one label from registering twice.
 *
 * Render this INSIDE the search bar's `relative` wrapper — it anchors like the search
 * results dropdown does.
 */
const props = defineProps<{
  open: boolean
  /** Parent-supplied toast after it processed a scan ("✓ added ×2", "no match"…). */
  feedback?: { seq: number, text: string } | null
}>()

const emit = defineEmits<{ scanned: [code: string], close: [] }>()

const videoEl = ref<HTMLVideoElement | null>(null)
const error = ref<string | null>(null)
const flash = ref(false)
const toast = ref<string | null>(null)

let stream: MediaStream | null = null
let detector: BarcodeDetector | null = null
let timer: ReturnType<typeof setInterval> | undefined
let detecting = false
let lastCode = ''
let lastAt = 0
let flashTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined
let audio: AudioContext | null = null

async function start() {
  error.value = null
  toast.value = null
  lastCode = ''
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      error.value =
        'The camera needs a secure connection — open the register over https (DEV_TLS=1 in development).'
      return
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    })
    await nextTick()
    const video = videoEl.value
    if (!video) return
    video.srcObject = stream
    await video.play()
    detector ??= new BarcodeDetector({
      formats: ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'code_39'],
    })
    timer = setInterval(() => void detect(), 140)
  } catch (err) {
    error.value =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Camera access was denied — allow it for this site in Settings, then try again.'
        : 'Could not start the camera.'
  }
}

function stop() {
  clearInterval(timer)
  timer = undefined
  detecting = false
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  if (videoEl.value) videoEl.value.srcObject = null
}

async function detect() {
  const video = videoEl.value
  if (!video || video.readyState < 2 || detecting || !detector) return
  detecting = true
  try {
    const codes = await detector.detect(video)
    const raw = codes[0]?.rawValue?.trim()
    if (raw) hit(raw)
  } catch {
    // A single failed frame is noise — the next tick tries again.
  } finally {
    detecting = false
  }
}

function hit(code: string) {
  // The cooldown: at ~7 frames/sec one label would otherwise register several times.
  const now = performance.now()
  if (code === lastCode && now - lastAt < 1600) return
  lastCode = code
  lastAt = now

  flash.value = true
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flash.value = false), 220)
  beep()

  emit('scanned', code)
}

/** A short synthesized blip — no asset, and harmless if the context can't start. */
function beep() {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, audio.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12)
    osc.connect(gain).connect(audio.destination)
    osc.start()
    osc.stop(audio.currentTime + 0.12)
  } catch {
    // The green flash is the real confirmation; sound is garnish.
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void start()
    else stop()
  },
)

watch(
  () => props.feedback,
  (feedback) => {
    if (!feedback) return
    toast.value = feedback.text
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = null), 2000)
  },
)

function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stop()
})
</script>

<template>
  <div
    v-if="open"
    class="absolute inset-x-0 top-full z-10 mt-1.5 overflow-hidden rounded-xl border bg-popover shadow-xl"
    role="region"
    aria-label="Camera barcode scanner"
  >
    <div class="relative h-52 bg-black">
      <video
        ref="videoEl"
        playsinline
        muted
        autoplay
        class="absolute inset-0 h-full w-full object-cover"
      />

      <!-- targeting frame -->
      <div v-if="!error" class="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <div class="relative h-[62%] w-[74%]">
          <span class="absolute left-0 top-0 size-5 rounded-tl-md border-l-[3px] border-t-[3px] border-primary" />
          <span class="absolute right-0 top-0 size-5 rounded-tr-md border-r-[3px] border-t-[3px] border-primary" />
          <span class="absolute bottom-0 left-0 size-5 rounded-bl-md border-b-[3px] border-l-[3px] border-primary" />
          <span class="absolute bottom-0 right-0 size-5 rounded-br-md border-b-[3px] border-r-[3px] border-primary" />
          <span class="scanline absolute inset-x-[4%] top-1/2 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent shadow-[0_0_12px_var(--primary)]" />
        </div>
      </div>

      <!-- hit flash -->
      <div v-if="flash" class="pointer-events-none absolute inset-0 bg-primary/25" aria-hidden="true" />

      <p
        v-if="toast"
        class="absolute left-1/2 top-2.5 max-w-[90%] -translate-x-1/2 truncate rounded-full bg-primary px-3.5 py-1 text-sm font-bold text-primary-foreground shadow-lg"
        role="status"
      >
        {{ toast }}
      </p>

      <div v-if="error" class="absolute inset-0 flex items-center justify-center p-4">
        <p class="rounded-xl border border-destructive/50 bg-background/95 px-4 py-3 text-center text-sm">
          {{ error }}
        </p>
      </div>

      <button
        type="button"
        class="absolute right-2 top-2 flex size-8 items-center justify-center rounded-lg bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
        aria-label="Close the camera"
        @click="emit('close')"
      >
        <X class="size-4" />
      </button>

      <p class="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[11px] text-white/80 [text-shadow:0_1px_4px_rgba(0,0,0,0.9)]">
        Scanning continuously — every hit lands as you go
      </p>
    </div>
  </div>
</template>

<style scoped>
.scanline {
  animation: scan 2.2s ease-in-out infinite;
}
@keyframes scan {
  0%, 100% { transform: translateY(-320%); }
  50% { transform: translateY(320%); }
}
@media (prefers-reduced-motion: reduce) {
  .scanline { animation: none; }
}
</style>
