/**
 * Dark mode is a class on <html>, not `system` — a POS runs under fixed store lighting,
 * so staff pick rather than inherit whatever the OS decided. Dark is the default.
 * The app is ssr:false, so localStorage is always available at setup time.
 */
const STORAGE_KEY = 'huta-theme'

export function useTheme() {
  const theme = useState<'dark' | 'light'>('huta-theme', () => {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  })

  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    localStorage.setItem(STORAGE_KEY, theme.value)
  }

  return { theme, toggle }
}
