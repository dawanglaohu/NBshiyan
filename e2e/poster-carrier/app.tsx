import 'virtual:globals-css';
import { createRoot } from 'react-dom/client';
import { useTranslations } from 'next-intl';
import ProductGallery from '@/components/three/ProductGallery';
import { QuoteProvider } from '@/components/quote/QuoteProvider';
import FloatingActions from '@/components/quote/FloatingActions';
import { products } from '@/data/products';

export type CarrierOptions = {
  /** 负控用：给「纯 poster」夹具塞真实 GLB，验证 harness 能按该卡片自己的状态/回调抓到它 */
  purePosterHasModel?: boolean;
};

type ModelResult = { slug: string; status: 'ready' | 'failed'; reason?: string };
declare global {
  interface Window {
    __modelResults: ModelResult[];
    __carrier: Record<string, unknown>;
  }
}

/**
 * 任务专用组件测试载体，不进入生产路由、不改 src/app。
 * 真实挂载 ProductGallery + QuoteProvider + FloatingActions；只替换 next/dynamic、
 * next-intl、@/i18n/navigation 三个边界。适配器只覆盖本测试用到的调用形态，
 * 不宣称与 Next.js 全部语义等价。
 */
function Carrier({ purePosterHasModel }: Required<CarrierOptions>) {
  const t = useTranslations('Products');
  const v = useTranslations('Views');
  const modelBase = products.find((p) => p.slug === 'corrugated-boxes')!;
  const posterBase = products.find((p) => p.slug === 'color-boxes')!;

  const modelItem = {
    ...modelBase,
    name: t('names.corrugated-boxes'),
    desc: t('desc.corrugated-boxes'),
    specs: t.raw('specs.corrugated-boxes'),
    alt: modelBase.posterAlt?.en,
  };
  const purePosterItem = {
    ...posterBase,
    slug: 'pure-poster',
    // Product.model 是可选字段；当前生产目录 12/12 都有 model，故这是组件输入夹具
    model: purePosterHasModel ? modelBase.model : undefined,
    animated: false,
    animationClips: undefined,
    landing: undefined,
    name: 'Color Boxes (pure poster fixture)',
    desc: t('desc.color-boxes'),
    specs: t.raw('specs.color-boxes'),
    alt: posterBase.posterAlt?.en,
  };

  const labels = {
    learnMore: t('learnMore'),
    specsLabel: t('specsLabel'),
    tap: t('tapToRotate'),
    drag: t('dragToRotate'),
    loading: t('loading'),
    add: t('addToQuote'),
    details: t('details'),
    done: t('done'),
    viewsLabel: v('label'),
    views: { closed: v('closed'), open: v('open'), dieline: v('dieline') },
  };

  return (
    <QuoteProvider>
      <main className="container">
        <p data-testid="carrier-note" style={{ fontSize: 12, color: '#555' }}>
          Task-only component test carrier, not a production route. pure-poster fixture has model: {String(purePosterHasModel)}.
        </p>
        <ProductGallery
          items={[purePosterItem, modelItem] as never}
          labels={labels as never}
          onModelResult={(result) => { window.__modelResults.push(result as ModelResult); }}
        />
      </main>
      <FloatingActions />
    </QuoteProvider>
  );
}

export function mountCarrier(options: CarrierOptions = {}) {
  window.__modelResults = [];
  window.__carrier = {
    taskOnly: true,
    notProductionRoute: true,
    fixture: 'pure-poster',
    purePosterHasModel: !!options.purePosterHasModel,
  };
  createRoot(document.getElementById('root')!).render(<Carrier purePosterHasModel={!!options.purePosterHasModel} />);
}
