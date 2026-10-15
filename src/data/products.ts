// 模拟数据：后端接口（docs/API.md）就绪后替换
export type Product = { slug: string; model?: string; poster: string; animated?: boolean; animationClips?: { open?: string; unfold?: string }; /** 品类落地页路径（上线后填写），卡片显示 Learn more */ landing?: string };
export const products: Product[] = [
  { slug: 'corrugated-boxes', model: '/models/corrugated-box.anim.da398ca9.glb', poster: '/images/posters/custom-corrugated-boxes.webp', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-boxes', model: '/models/color-box.355d50bc.glb', poster: '/images/posters/custom-color-boxes.webp' },
  { slug: 'gift-boxes', model: '/models/gift-box.anim.ccfb2baa.glb', poster: '/images/posters/custom-gift-boxes.webp', animated: true, animationClips: { open: 'Open' } },
  { slug: 'pulp-molding', model: '/models/pulp-egg-tray.3d60dd23.glb', poster: '/images/posters/custom-pulp-molding.webp' },
  { slug: 'paper-cups', model: '/models/paper-cup.8375532a.glb', poster: '/images/posters/custom-paper-cups.webp' },
  { slug: 'party-supplies', model: '/models/party-supplies.828369f3.glb', poster: '/images/posters/custom-party-supplies.webp' },
  { slug: 'wine-boxes', model: '/models/wine-box.anim.49bdad5f.glb', poster: '/images/posters/custom-wine-boxes.webp', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-printing', model: '/models/color-printing.6f6d1883.glb', poster: '/images/posters/custom-color-printing.webp' },
  { slug: 'offset-printing', model: '/models/offset-catalog.ce7ebab1.glb', poster: '/images/posters/custom-offset-printing.webp' },
  { slug: 'eco-paper-cups', model: '/models/eco-paper-cup.1c05faa9.glb', poster: '/images/posters/custom-eco-paper-cups.webp' },
  { slug: 'gift-cards', model: '/models/gift-card.5f15f08c.glb', poster: '/images/posters/custom-gift-cards.webp' },
  { slug: 'christmas-merchandise', model: '/models/christmas-tube.e7bde861.glb', poster: '/images/posters/custom-christmas-merchandise.webp' }
];
