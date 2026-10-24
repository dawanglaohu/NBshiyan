/** Public copies of the user-selected artwork and corrected product video. */
export const BRAND_MEDIA = {
  video: {
    compact: '/brand/video2-packjoyu-products-web-720p60-v3.mp4',
    full: '/brand/video2-packjoyu-products-v3.mp4',
    poster: '/brand/video2-packjoyu-products-v3-poster-12233ms.jpg',
  },
  scene: {
    poster: '/brand/packjoyu-industrial-city-v3.png',
    /** Default src for the city GIF pause still. BrandScene adds the 2000w WebP. The 1737×905 illustration is a different frame. */
    pauseStill: '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp',
    animation: '/brand/packjoyu-industrial-city-v3-loop-preview.gif',
    width: 1737,
    height: 905,
  },
} as const;
