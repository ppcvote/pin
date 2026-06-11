/**
 * Pin design tokens — STRUCTURE only, not color.
 *
 * Color identity comes from the skill's metadata.pin.primary_color.
 * Pin owns: layout, spacing, neutral secondaries, signature placement.
 * Skill owns: brand color, icon, name.
 *
 * Used by channel adapters (LINE Flex today; web later). Don't import outside
 * of channels/.
 */

/** Pin's neutral palette — used as FALLBACK when a skill doesn't theme. */
export const PIN_NEUTRAL = {
  ink: '#0F172A',           // dark fallback header
  cream: '#F8F5EE',         // body bg (always Pin)
  mutedText: '#64748B',     // description text
  secondaryBg: '#FFFFFF',   // secondary button bg
  secondaryBorder: '#E5E7EB',
  border: '#E5E7EB',
  navBtnBg: '#F1F5F9',      // back/home button
} as const

export const PIN_SIGNATURE = '·Pin'

export interface ThemeContext {
  primaryColor?: string   // skill's brand color, hex
  icon?: string           // skill's emoji or short mark
  title?: string          // skill display name (or generic title)
}

/** Pick high-contrast text color for a given hex bg. */
export function readableTextOn(hex: string | undefined): string {
  if (!hex) return '#FFFFFF'
  const h = hex.replace(/^#/, '')
  if (h.length !== 6) return '#FFFFFF'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  // Relative luminance approximation
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#0F172A' : '#FFFFFF'
}

/** Resolved theme with sensible defaults. */
export function resolveTheme(t: ThemeContext = {}): Required<ThemeContext> & { headerTextColor: string } {
  const primary = t.primaryColor ?? PIN_NEUTRAL.ink
  return {
    primaryColor: primary,
    icon: t.icon ?? '•',
    title: t.title ?? '',
    headerTextColor: readableTextOn(primary),
  }
}
