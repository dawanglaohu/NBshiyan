import { MODELS } from './models.generated';
// 模拟数据：后端接口（docs/API.md）就绪后替换
export type Product = { slug: string; model?: string; poster: string; animated?: boolean; animationClips?: { open?: string; unfold?: string } };
export const products: Product[] = [
  { slug: 'corrugated-boxes', model: MODELS['corrugated-box.anim'], poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-boxes', model: MODELS['color-box'], poster: '/images/placeholder.svg' },
  { slug: 'gift-boxes', model: MODELS['gift-box.anim'], poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'pulp-molding', model: MODELS['pulp-egg-tray'], poster: '/images/placeholder.svg' },
  { slug: 'paper-cups', model: MODELS['paper-cup'], poster: '/images/placeholder.svg' },
  { slug: 'party-supplies', model: MODELS['party-supplies'], poster: '/images/placeholder.svg' },
  { slug: 'wine-boxes', model: MODELS['wine-box.anim'], poster: '/images/placeholder.svg', animated: true, animationClips: { open: 'Open' } },
  { slug: 'color-printing', model: MODELS['color-printing'], poster: '/images/placeholder.svg' },
  { slug: 'offset-printing', model: MODELS['offset-catalog'], poster: '/images/placeholder.svg' },
  { slug: 'eco-paper-cups', model: MODELS['eco-paper-cup'], poster: '/images/placeholder.svg' },
  { slug: 'gift-cards', model: MODELS['gift-card'], poster: '/images/placeholder.svg' },
  { slug: 'christmas-merchandise', model: MODELS['christmas-tube'], poster: '/images/placeholder.svg' }
];
