import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'

/**
 * The Huta theme: Aura with a green primary and a neutral surface.
 *
 * Customisation goes through design tokens, never CSS overrides — reach for
 * `definePreset` or a component's `dt` prop before writing a style rule, and never target
 * PrimeVue's internal classes with `:deep()`. See the Frontend conventions.
 */
export const HutaPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{green.50}',
      100: '{green.100}',
      200: '{green.200}',
      300: '{green.300}',
      400: '{green.400}',
      500: '{green.500}',
      600: '{green.600}',
      700: '{green.700}',
      800: '{green.800}',
      900: '{green.900}',
      950: '{green.950}',
    },
    surface: {
      0: '#ffffff',
      50: '{neutral.50}',
      100: '{neutral.100}',
      200: '{neutral.200}',
      300: '{neutral.300}',
      400: '{neutral.400}',
      500: '{neutral.500}',
      600: '{neutral.600}',
      700: '{neutral.700}',
      800: '{neutral.800}',
      900: '{neutral.900}',
      950: '{neutral.950}',
    },
  },
})
