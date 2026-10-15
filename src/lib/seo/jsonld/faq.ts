// FAQPage JSON-LD (Refs #99). Disabled by default until Ryan finalizes the FAQ
// copy in docs/content/*.md. Items must match the FAQ visible on the page exactly.
export type FaqItem = { question: string; answer: string };

/** Flip via NEXT_PUBLIC_FAQ_JSONLD_ENABLED=true once FAQ copy is final. */
export const FAQ_JSONLD_ENABLED = process.env.NEXT_PUBLIC_FAQ_JSONLD_ENABLED === 'true';

export function buildFaqJsonLd(items: FaqItem[], opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? FAQ_JSONLD_ENABLED;
  const clean = items.filter((i) => i.question.trim() && i.answer.trim());
  if (!enabled || clean.length === 0) return null;
  // Never publish placeholder answers.
  if (clean.some((i) => /\bTBD\b/i.test(i.answer))) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: clean.map((i) => ({
      '@type': 'Question',
      name: i.question.trim(),
      acceptedAnswer: { '@type': 'Answer', text: i.answer.trim() },
    })),
  };
}
