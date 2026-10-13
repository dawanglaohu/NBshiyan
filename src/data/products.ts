// 模拟数据：后端接口（docs/API.md）就绪后替换
export type Product = { slug: string; model?: string; poster: string; animated?: boolean; animationClips?: { open?: string; unfold?: string } };
export const products: Product[] = [
  { slug: 'corrugated-boxes', model: '/models/corrugated-box.anim.cc8825d0.glb', poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-boxes', model: '/models/color-box.7fb65a38.glb', poster: '/images/placeholder.svg' },
  { slug: 'gift-boxes', model: '/models/gift-box.anim.10671289.glb', poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'pulp-molding', model: '/models/pulp-egg-tray.3d60dd23.glb', poster: '/images/placeholder.svg' },
  { slug: 'paper-cups', model: '/models/paper-cup.8375532a.glb', poster: '/images/placeholder.svg' },
  { slug: 'party-supplies', model: '/models/party-supplies.828369f3.glb', poster: '/images/placeholder.svg' },
  { slug: 'wine-boxes', model: '/models/wine-box.anim.f4caccbb.glb', poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-printing', model: '/models/color-printing.6f6d1883.glb', poster: '/images/placeholder.svg' },
  { slug: 'offset-printing', model: '/models/offset-catalog.ce7ebab1.glb', poster: '/images/placeholder.svg' },
  { slug: 'eco-paper-cups', model: '/models/eco-paper-cup.c7dc1bb3.glb', poster: '/images/placeholder.svg' },
  { slug: 'gift-cards', model: '/models/gift-card.5f15f08c.glb', poster: '/images/placeholder.svg' },
  { slug: 'christmas-merchandise', model: '/models/christmas-tube.e7bde861.glb', poster: '/images/placeholder.svg' }
];
