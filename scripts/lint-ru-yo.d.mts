// Types for scripts/lint-ru-yo.mjs (used by tests/lint-ru-yo.test.ts).
export type RuYoHit = { file: string; line: number; word: string; fix: string; kind: 'yo' | 'cta' };
export type RuYoAllow = { file?: string; word: string };
export const YO_WORDS: [string, string, string][];
export const OLD_CTA: RegExp[];
export const EXCLUDE: RegExp[];
export function lintText(text: string, file?: string, allow?: RuYoAllow[]): RuYoHit[];
export function fixText(text: string): string;
export function defaultFiles(cwd?: string): string[];
export function fileId(p: string): string;
export function sameFile(a: string, b: string): boolean;
