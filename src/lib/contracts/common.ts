import { z } from 'zod';

export const NonNegativeIntSchema = z.number().int().min(0).max(2_147_483_647);
export const PositiveIntSchema = NonNegativeIntSchema.refine((value) => value > 0);
export const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const UuidSchema = z.string().uuid();
export const LocaleSchema = z.enum(['en', 'ru']);
export const UtcDateTimeSchema = z.string().datetime().refine((value) => Number.isFinite(Date.parse(value)));
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const TimezoneSchema = z.string().min(1).max(100).refine((value) => {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
export const EmailSchema = z.string().refine((value) => !/[\r\n]/.test(value)).pipe(z.string().trim().max(254).email());
export const ProductSlugSchema = z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const SitePathSchema = z.string().min(1).max(200).refine((value) => {
  const path = value.split(/[?#]/, 1)[0];
  if (!path.startsWith('/') || /[\s\\\p{Cc}\p{Cf}]/u.test(path)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  if (/[\\%?#\s\p{Cc}\p{Cf}]/u.test(decoded) || decoded.includes('//')) return false;
  if (decoded.split('/').some((part) => part === '.' || part === '..')) return false;
  return decoded === '/' || /^\/(?:en|ru)(?:\/|$)/.test(decoded);
}).transform((value) => value.split(/[?#]/, 1)[0]);
export const BodyTextSchema = z.string().refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\r\n]/g, '')))
  .transform((value) => value.trim()).refine((value) => {
    const length = Array.from(value).length;
    return length >= 1 && length <= 4_000 && !/<\/?[a-z!][^>]*>/i.test(value);
  });
export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const TotpSchema = z.string().regex(/^[0-9]{6}$/);
export const EmptyRequestSchema = z.object({}).strict();

/** URLSearchParams values use explicit decimal/boolean syntax, never truthiness coercion. */
export const queryIntSchema = (max = 2_147_483_647) => z.union([
  z.number().int(), z.string().regex(/^(?:0|[1-9][0-9]*)$/).transform(Number),
]).pipe(NonNegativeIntSchema.max(max));
export const QueryBooleanSchema = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]);

/** Cursor validation is format-only: the owning query still verifies scope and sort position. */
export function makeCursorSchema(field: 'createdAt' | 'updatedAt') {
  const key = z.object({ [field]: UtcDateTimeSchema, id: IdSchema }).strict();
  return z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).refine((cursor) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    if (cursor.length % 4 === 1) return false;
    let bits = 0; let buffer = 0; let decoded = '';
    for (const character of cursor) {
      buffer = (buffer << 6) | alphabet.indexOf(character); bits += 6;
      if (bits >= 8) {
        bits -= 8;
        const byte = (buffer >> bits) & 255;
        if (byte > 127) return false;
        decoded += String.fromCharCode(byte);
      }
    }
    if (bits && (buffer & ((1 << bits) - 1))) return false;
    try { return key.safeParse(JSON.parse(decoded)).success; } catch { return false; }
  });
}
