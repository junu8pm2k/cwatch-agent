export const PERMISSION_MODES = ['explore', 'ask', 'allow-all'] as const;
export type Mode = typeof PERMISSION_MODES[number];
