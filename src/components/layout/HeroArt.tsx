// 首屏右侧主图：内联 SVG 构图（零请求、不参与 LCP 竞争），真实产品 WebP 到位后可替换（#65）
export default function HeroArt({ label }: { label: string }) {
  return (
    <svg className="hero-art" viewBox="0 0 480 400" role="img" aria-label={label}>
      <defs>
        <linearGradient id="hg-k" x1="0" x2="1"><stop offset="0" stopColor="#D9B48A" /><stop offset="1" stopColor="#C49A6C" /></linearGradient>
        <linearGradient id="hg-n" x1="0" x2="1"><stop offset="0" stopColor="#1D1D22" /><stop offset="1" stopColor="#121214" /></linearGradient>
      </defs>
      <ellipse cx="250" cy="360" rx="200" ry="22" fill="#1C1C1C" opacity=".08" />
      {/* 牛皮纸箱 */}
      <polygon points="70,190 200,140 330,190 200,240" fill="#E6C9A4" />
      <polygon points="70,190 200,240 200,350 70,300" fill="url(#hg-k)" />
      <polygon points="200,240 330,190 330,300 200,350" fill="#B88B5E" />
      <line x1="135" y1="165" x2="265" y2="215" stroke="#9C7148" strokeWidth="6" opacity=".5" />
      {/* 黑金礼盒 */}
      <polygon points="230,140 330,100 430,140 330,180" fill="#2A2A30" />
      <polygon points="230,140 330,180 330,260 230,220" fill="url(#hg-n)" />
      <polygon points="330,180 430,140 430,220 330,260" fill="#0E0E10" />
      <polygon points="268,155 368,115 378,119 278,159" fill="#D4AF6A" />
      <polygon points="278,159 288,163 288,243 278,239" fill="#D4AF6A" opacity=".85" />
      <polygon points="368,195 378,191 378,235 368,239" fill="#B8934F" />
      {/* 珊瑚色纸杯 */}
      <polygon points="372,262 432,262 424,350 380,350" fill="#FF5A36" />
      <ellipse cx="402" cy="262" rx="30" ry="9" fill="#E0401F" />
      <ellipse cx="402" cy="350" rx="22" ry="6" fill="#C2361A" />
      <rect x="378" y="290" width="48" height="10" fill="#FFD166" opacity=".9" />
      <circle cx="110" cy="90" r="26" fill="#FFD166" opacity=".55" />
    </svg>
  );
}
