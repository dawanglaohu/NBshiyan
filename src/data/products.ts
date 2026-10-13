// 模拟数据：后端接口（docs/API.md）就绪后替换
export type Product = { slug: string; model?: string; poster: string; animated?: boolean };
export const products: Product[] = [
  { slug: 'corrugated-boxes', model: '/models/corrugated-box.glb', poster: '/images/placeholder.svg', animated: true },
  { slug: 'color-boxes', poster: '/images/placeholder.svg' },
  { slug: 'gift-boxes', model: '/models/gift-box.glb', poster: '/images/placeholder.svg', animated: true },
  { slug: 'pulp-molding', poster: '/images/placeholder.svg' },
  { slug: 'paper-cups', poster: '/images/placeholder.svg' },
  { slug: 'party-supplies', poster: '/images/placeholder.svg' },
  { slug: 'wine-boxes', model: '/models/wine-box.glb', poster: '/images/placeholder.svg', animated: true },
  { slug: 'color-printing', poster: '/images/placeholder.svg' },
  { slug: 'offset-printing', poster: '/images/placeholder.svg' },
  { slug: 'eco-paper-cups', poster: '/images/placeholder.svg' },
  { slug: 'gift-cards', poster: '/images/placeholder.svg' },
  { slug: 'christmas-merchandise', poster: '/images/placeholder.svg' }
];
