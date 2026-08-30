import { ColorPaletteId } from '../types';

export interface ColorPaletteConfig {
  id: ColorPaletteId;
  name: string;
  subtitle: string;
  /** The live transmission lamp color (hex). */
  lamp: string;
  /** Complementary secondary accent for dual gradients. */
  secondary: string;
  /** Tertiary deep cosmic accent for multi-color spectral shading. */
  tertiary?: string;
  /** Same hue, pre-mixed for soft fills and halos. */
  lampSoft: string;
  lampGlow: string;
  previewColors: string[];
}

const soft = (hex: string, alpha: number): string => {
  const value = hex.replace('#', '').trim();
  const r = parseInt(value.slice(0, 2), 16) || 0;
  const g = parseInt(value.slice(2, 4), 16) || 0;
  const b = parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const defineLamp = (
  id: ColorPaletteId,
  name: string,
  subtitle: string,
  lamp: string,
  secondary = '#00d2ff',
  tertiary = '#a855f7'
): ColorPaletteConfig => ({
  id,
  name,
  subtitle,
  lamp,
  secondary,
  tertiary,
  lampSoft: soft(lamp, 0.16),
  lampGlow: soft(lamp, 0.4),
  previewColors: [lamp, secondary, tertiary],
});

export const PREDEFINED_PALETTES: Record<Exclude<ColorPaletteId, 'custom'>, ColorPaletteConfig> = {
  'cosmic-indigo':   defineLamp('cosmic-indigo',   'Cosmic Indigo',   'Deep nebula · electric cyan',        '#4f46e5', '#06b6d4', '#9333ea'),
  'cyber-emerald':   defineLamp('cyber-emerald',   'Cyber Emerald',   'Neon aurora · matrix teal',          '#10b981', '#06b6d4', '#3b82f6'),
  'solar-flare':     defineLamp('solar-flare',     'Solar Flare',     'Amber sunburst · warm crimson',      '#f97316', '#ef4444', '#fbbf24'),
  'amethyst-nebula': defineLamp('amethyst-nebula', 'Amethyst Nebula', 'Electric violet · magenta pulse',    '#a855f7', '#ec4899', '#3b82f6'),
  'glacier-ice':     defineLamp('glacier-ice',     'Glacier Ice',     'Arctic cyan · sapphire crystal',     '#06b6d4', '#3b82f6', '#818cf8'),
  'supernova-gold':  defineLamp('supernova-gold',  'Supernova Gold',  'Stellar radiance · amber flare',     '#eab308', '#f97316', '#ef4444'),
  'phantom-crimson': defineLamp('phantom-crimson', 'Phantom Crimson', 'Cyber ruby · infrared pulse',        '#f43f5e', '#a855f7', '#06b6d4'),
};

export const DEFAULT_PALETTE_ID: ColorPaletteId = 'solar-flare';

function hexToHsl(hex: string): [number, number, number] {
  let value = hex.replace('#', '').trim();
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (value.length !== 6) return [200, 100, 50];
  const r = (parseInt(value.slice(0, 2), 16) || 0) / 255;
  const g = (parseInt(value.slice(2, 4), 16) || 0) / 255;
  const b = (parseInt(value.slice(4, 6), 16) || 0) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (0 <= h && h < 60) { r = c; g = x; b = 0; }
  else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
  else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
  else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
  else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
  else if (300 <= h && h < 360) { r = c; g = 0; b = x; }
  const toHex = (n: number) => {
    const hex = Math.round((n + m) * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Build a multi-color harmonic custom palette from any user hex color */
export function buildCustomPalette(hex: string): ColorPaletteConfig {
  const safeHex = hex?.startsWith('#') ? hex : `#${hex || '00e5ff'}`;
  const [h, s, l] = hexToHsl(safeHex);
  // Multi-color harmonic: secondary shifts hue +40°, tertiary shifts hue -35°
  const secondaryHex = hslToHex(h + 40, Math.max(70, s), Math.min(65, Math.max(38, l)));
  const tertiaryHex = hslToHex(h - 35, Math.max(65, s), Math.max(30, l - 8));

  return {
    id: 'custom' as ColorPaletteId,
    name: 'Custom',
    subtitle: 'Custom harmonic gradient',
    lamp: safeHex,
    secondary: secondaryHex,
    tertiary: tertiaryHex,
    lampSoft: soft(safeHex, 0.18),
    lampGlow: soft(safeHex, 0.45),
    previewColors: [safeHex, secondaryHex, tertiaryHex],
  };
}

export function getPaletteConfig(paletteId?: ColorPaletteId, customColor?: string): ColorPaletteConfig {
  if (paletteId === 'custom') {
    return buildCustomPalette(customColor || '#00e5ff');
  }
  if (paletteId && PREDEFINED_PALETTES[paletteId as keyof typeof PREDEFINED_PALETTES]) {
    return PREDEFINED_PALETTES[paletteId as keyof typeof PREDEFINED_PALETTES];
  }
  return PREDEFINED_PALETTES[DEFAULT_PALETTE_ID];
}
