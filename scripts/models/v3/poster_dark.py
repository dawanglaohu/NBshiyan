# #252 深色海报合成：render_dark.py 的透明 PNG → 800×800 webp（底色 --premium-bg #121214，物体占约 70%，≤30KB）
# python3 poster_dark.py <render.png> <out.webp> [preview.png]
import sys, os, numpy as np
from PIL import Image
BG = (0x12, 0x12, 0x14)
src, out = sys.argv[1], sys.argv[2]
a = np.asarray(Image.open(src).convert('RGBA')).astype(float)
ys, xs = np.where(a[:, :, 3] > 250); x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
sc = 560/max(x1-x0+1, y1-y0+1); R = round(400/sc); cx, cy = (x0+x1)/2, (y0+y1)/2
H, W = a.shape[:2]; yy, xx = np.mgrid[0:H, 0:W]; e = np.minimum.reduce([xx, yy, W-1-xx, H-1-yy])/(W*.18)
a[:, :, 3] = np.where(a[:, :, 3] < 250, a[:, :, 3]*np.minimum(1, e), a[:, :, 3])   # 阴影向画面边缘淡出
bg = Image.new('RGBA', (W + 4*R, H + 4*R), BG + (255,)); bg.alpha_composite(Image.fromarray(a.astype('uint8')), (2*R, 2*R))
L, T = int(cx + R), int(cy + R); sub = bg.crop((L, T, L + 2*R, T + 2*R)).resize((800, 800), Image.LANCZOS).convert('RGB')
for q in range(85, 30, -5):
    sub.save(out, 'WEBP', quality=q, method=6)
    if os.path.getsize(out) <= 30000: break
print(out, os.path.getsize(out), 'q', q)
if len(sys.argv) > 3: sub.save(sys.argv[3])
