/** Public routes this layer registers. Later tasks append their own entries to this table. */
export const PUBLIC_ROUTES = {
  home: { id: 'home', path: '/', entryId: 'home-link' },
  products: { id: 'products', path: '/products', entryId: 'products-link' },
  contact: { id: 'contact', path: '/contact', entryId: 'contact-link' },
  about: { id: 'about', path: '/about', entryId: 'about-link' },
  privacy: { id: 'privacy', path: '/privacy', entryId: 'privacy-link' },
} as const;

export type PublicRouteId = keyof typeof PUBLIC_ROUTES;

/** Admin routes registered by this layer; display hint only, never authorization. */
export const ADMIN_ROUTES = {
  stats: {
    id: 'admin-stats',
    path: '/admin/stats',
    entryId: 'stats-link',
    roles: ['ADMIN', 'SALES', 'EDITOR'] as const,
  },
} as const;

export type AdminRouteId = keyof typeof ADMIN_ROUTES;
