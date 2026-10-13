// 模拟数据：后端接口（docs/API.md）就绪后替换
export type Product = { slug: string; model?: string; poster: string; animated?: boolean; animationClips?: { open?: string; unfold?: string } };
export const products: Product[] = [
  { slug: 'corrugated-boxes', model: '/models/corrugated-box.anim.cc8825d0.glb', poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-boxes', poster: '/images/placeholder.svg' },
  { slug: 'gift-boxes', model: '/models/gift-box.anim.10671289.glb', poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'pulp-molding', poster: '/images/placeholder.svg' },
  { slug: 'paper-cups', poster: '/images/placeholder.svg' },
  { slug: 'party-supplies', poster: '/images/placeholder.svg' },
  { slug: 'wine-boxes', model: '/models/wine-box.anim.f4caccbb.glb', poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-printing', poster: '/images/placeholder.svg' },
  { slug: 'offset-printing', poster: '/images/placeholder.svg' },
  { slug: 'eco-paper-cups', poster: '/images/placeholder.svg' },
  { slug: 'gift-cards', poster: '/images/placeholder.svg' },
  { slug: 'christmas-merchandise', poster: '/images/placeholder.svg' }
];
