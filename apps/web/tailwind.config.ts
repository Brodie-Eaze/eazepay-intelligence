import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F7F8FA',
        surface: '#FFFFFF',
        ink: '#0F172A',
        ink2: '#1E293B',
        muted: '#475569',
        soft: '#94A3B8',
        line: '#E2E8F0',
        line2: '#EEF1F5',
        accent: '#3B82F6',
        accentSoft: '#DBEAFE',
        // Tone tokens repurposed onto a navy + light-blue scale.
        // Names preserved so existing classes still resolve.
        success: '#1D4ED8',
        successSoft: '#DBEAFE',
        warn: '#475569',
        warnSoft: '#EEF1F5',
        danger: '#0F172A',
        dangerSoft: '#E2E8F0',
        hero: '#0F172A',
        heroLine: '#1E293B',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
export default config;
