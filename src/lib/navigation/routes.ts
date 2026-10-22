/** Public routes this layer registers. Later tasks append their own entries to this table. */
export const PUBLIC_ROUTES = {
  home: { id: 'home', path: '/', entryId: 'home-link' },
  products: { id: 'products', path: '/products', entryId: 'products-link' },
  contact: { id: 'contact', path: '/contact', entryId: 'contact-link' },
} as const;

export type PublicRouteId = keyof typeof PUBLIC_ROUTES;
