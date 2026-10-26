declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: {
      document: Document;
      HTMLElement: { prototype: { scrollIntoView: (arg?: unknown) => void } };
      HTMLInputElement: typeof HTMLInputElement;
      HTMLButtonElement: typeof HTMLButtonElement;
      Element: typeof Element;
      Node: typeof Node;
      DocumentFragment: typeof DocumentFragment;
      MutationObserver: typeof MutationObserver;
      SVGElement: typeof SVGElement;
      getComputedStyle: (elt: Element) => CSSStyleDeclaration;
    };
  }
}
