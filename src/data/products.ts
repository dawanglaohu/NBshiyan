// 模拟数据：后端接口（docs/API.md）就绪后替换
export type Product = { slug: string; model?: string; poster: string; animated?: boolean; animationClips?: { open?: string; unfold?: string }; /** 品类落地页路径（上线后填写），卡片显示 Learn more */ landing?: string };
export const products: Product[] = [
  { slug: 'corrugated-boxes', model: '/models/corrugated-box.anim.da398ca9.glb', poster: '/images/posters/custom-corrugated-boxes.webp', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-boxes', model: '/models/color-box.22c5a61b.glb', poster: '/images/posters/custom-color-boxes.webp' },
  { slug: 'gift-boxes', model: '/models/gift-box.anim.ccfb2baa.glb', poster: '/images/posters/custom-gift-boxes.webp', animated: true, animationClips: { open: 'Open' } },
  { slug: 'pulp-molding', model: '/models/pulp-egg-tray.987b0ed9.glb', poster: '/images/posters/custom-pulp-molding.webp' },
  { slug: 'paper-cups', model: '/models/paper-cup.4477e5bf.glb', poster: '/images/posters/custom-paper-cups.webp' },
  { slug: 'party-supplies', model: '/models/party-supplies.91649d75.glb', poster: '/images/posters/custom-party-supplies.webp' },
  { slug: 'wine-boxes', model: '/models/wine-box.anim.49bdad5f.glb', poster: '/images/posters/custom-wine-boxes.webp', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-printing', model: '/models/color-printing.83089082.glb', poster: '/images/posters/custom-color-printing.webp' },
  { slug: 'offset-printing', model: '/models/offset-catalog.e4b3ee44.glb', poster: '/images/posters/custom-offset-printing.webp' },
  { slug: 'eco-paper-cups', model: '/models/eco-paper-cup.fc1fbcbc.glb', poster: '/images/posters/custom-eco-paper-cups.webp' },
  { slug: 'gift-cards', model: '/models/gift-card.a9cc3581.glb', poster: '/images/posters/custom-gift-cards.webp' },
  { slug: 'christmas-merchandise', model: '/models/christmas-tube.621c7715.glb', poster: '/images/posters/custom-christmas-merchandise.webp' }
];
