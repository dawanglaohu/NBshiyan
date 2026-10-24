export type SampleRule = [string, string, string];

export type CustomerLocale = {
  dir: 'ltr' | 'rtl';
  companyLabel: string;
  greeting: { named: string; generic: string };
  sampleRules: SampleRule[];
};

export function buildEmailTemplates(
  files: Record<string, string>,
  locales: Record<string, CustomerLocale>,
): Record<string, { subject: string; html: string; text: string }>;

export const CUSTOMER_LOCALES: Record<string, CustomerLocale>;
