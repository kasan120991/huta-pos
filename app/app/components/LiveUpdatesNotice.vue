<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'

import { Button } from '~/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * "2 updates · Show" — the held half of Kasan's Option B (2026-09-03).
 *
 * Figures update silently because they sit in fixed positions. A list that would insert or
 * reorder rows holds them behind this instead, so scroll position, reading position and row
 * selection all survive a busy Saturday. Renders nothing at all when nothing is waiting.
 *
 * NOT the registry's `Alert`, deliberately: that ships `role="alert"`, an ASSERTIVE live
 * region that interrupts a screen reader mid-sentence — and nothing here is wrong. This is
 * the same explanation-versus-alert line the house style already draws for the amber blocks.
 * `role="status"` is polite: it is announced when the user is between things.
 *
 * The count is of EVENTS, not rows, and the copy stays neutral for that reason. A refund and
 * a void change rows that already exist, so "2 new sales" would be a lie on both.
 */
const props = defineProps<{
  /** How many changes are waiting. Zero renders nothing. */
  count: number
  /** `touch` gives the register a 44px hit area; the back office does not need one. */
  size?: 'default' | 'touch'
  class?: HTMLAttributes['class']
}>()

const emit = defineEmits<{ apply: [] }>()

const label = computed(() => (props.count === 1 ? '1 update' : `${props.count} updates`))
const touch = computed(() => props.size === 'touch')
</script>

<template>
  <div
    v-if="count > 0"
    role="status"
    :class="
      cn(
        'flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/10',
        touch ? 'px-4 py-2.5 text-base' : 'px-3 py-2 text-sm',
        props.class,
      )
    "
  >
    <span class="text-primary">{{ label }}</span>
    <Button
      size="sm"
      :class="touch ? 'h-11 px-5 text-base' : undefined"
      @click="emit('apply')"
    >
      Show
    </Button>
  </div>
</template>
