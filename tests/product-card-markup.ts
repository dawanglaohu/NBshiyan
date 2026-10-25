import React, { createElement } from 'react';

(globalThis as { React?: typeof React }).React = React;

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import ProductGallery from '../src/components/three/ProductGallery';
import { QuoteProvider } from '../src/components/quote/QuoteProvider';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as {
  Products: { desc: Record<string, string>; specs: Record<string, string[]> };
  Quote: Record<string, string>;
};

const labels = {
  learnMore: 'Learn more',
  specsLabel: 'Key specs',
  tap: 'Tap',
  drag: 'Drag',
  loading: 'Loading',
  add: 'Add',
  details: 'Details',
  done: 'Done',
  viewsLabel: 'Views',
  views: { closed: 'Closed', open: 'Open', dieline: 'Dieline' },
};

/** 渲染一张目录卡。landing 省略时走 `#slug` 回退，和未上线的 `/products#key` 一样是纯文本。 */
export function renderCatalogCard(landing?: string): string {
  const slug = 'corrugated-boxes';
  const gallery = createElement(ProductGallery, {
    items: [{
      slug,
      poster: '/images/posters/custom-corrugated-boxes.webp',
      name: 'Corrugated Boxes',
      desc: en.Products.desc[slug],
      specs: en.Products.specs[slug],
      landing,
    }],
    labels,
  });
  return renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale: 'en',
    messages: { Quote: en.Quote },
    children: createElement(QuoteProvider, { children: gallery }),
  }));
}

if (process.env.PRINT_PRODUCT_CARDS === '1') {
  process.stdout.write(JSON.stringify({
    anchor: renderCatalogCard('/products#corrugated-boxes'),
    hash: renderCatalogCard(undefined),
    live: renderCatalogCard('/products/custom-corrugated-boxes'),
  }));
}
