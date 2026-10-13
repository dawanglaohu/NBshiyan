'use client';
import { useTranslations } from 'next-intl';
import { useQuote } from './QuoteProvider';

export default function AddToQuoteButton({ slug }: { slug: string }) {
  const t = useTranslations('Quote');
  const { items, add, setOpen } = useQuote();
  const added = items.some((i) => i.slug === slug);
  return (
    <button type="button" className={`btn sm${added ? ' ghost' : ''}`} onClick={(e) => { e.stopPropagation(); if (added) setOpen(true); else add(slug); }} aria-pressed={added}>
      {added ? t('added') : t('add')}
    </button>
  );
}
