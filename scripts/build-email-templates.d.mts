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

export function invokedDirectly(argv?: string[], metaUrl?: string): boolean;

export type EmailBuildPlan =
  | { action: 'write'; code: 0 }
  | { action: 'fail'; code: 1; error: string }
  | { action: 'skip'; code: 0 };

export function emailBuildPlan(options?: {
  argv?: string[];
  metaUrl?: string;
  lifecycle?: string;
}): EmailBuildPlan;
