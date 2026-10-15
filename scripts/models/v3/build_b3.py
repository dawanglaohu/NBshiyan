# #77 batch 3（Blender 4.2.3 LTS）：12oz 纸杯+盖 / 牛皮纸杯+杯套+盖 / 派对用品（纸盘、派对帽、纸杯、吸管）
# blender -b --python build_b3.py -- <cup|ecocup|party> <outdir>   (TEX_DIR=tex-b3/)
import bpy, bmesh, math, os, sys
_d = os.path.dirname(os.path.abspath(__file__))
_src = open(os.path.join(_d, 'build_print_b1.py')).read()
exec(_src[:_src.rindex("{'giftcard'")])
TEX = os.environ.get('TEX_DIR', os.path.join(_d, 'tex-b3/'))
CAM_A = math.atan2(-2.6, 2.4)   # 网站默认相机方向（Blender XY）；贴图 u=0.5 对准它

def rev(name, prof, m, seg=64, loc=(0, 0, 0), vrange=None, a0=CAM_A - math.pi, smooth=True):
    """回转体，u 随角度增加（外侧看左→右），u=0.5 朝相机"""
    V, F = [], []; P = len(prof); L = [0]
    for j in range(1, P): L.append(L[-1] + math.dist(prof[j], prof[j-1]))
    for s in range(seg + 1):
        a = a0 + 2*math.pi*s/seg
        for r, z in prof: V.append((loc[0] + r*math.cos(a), loc[1] + r*math.sin(a), loc[2] + z))
    for s in range(seg):
        for j in range(P - 1): a = s*P + j; F.append((a, a + 1, a + P + 1, a + P))
    me = bpy.data.meshes.new(name); me.from_pydata(V, [], F); me.update(); uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        poly.use_smooth = smooth
        for li in poly.loop_indices:
            s, j = divmod(me.loops[li].vertex_index, P)
            vv = (prof[j][1] - vrange[0])/(vrange[1] - vrange[0]) if vrange else L[j]/max(L[-1], 1e-9)
            uvl.data[li].uv = (s/seg, vv)
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); o.data.materials.append(m)
    return o

def cup(prefix, wrapM, inM, lidM, rimM, H=110*MM, rb=28*MM, rt=45*MM, loc=(0, 0, 0), lid=True, seg=64):
    """单层纸杯：杯身锥面（贴图区 8mm..H-4mm）、底部 8mm 内凹圈脚、卷边 Ø3mm、内壁；盖子裙边扣住卷边"""
    t = .35*MM; zb = 8*MM; zt = H - 2*MM
    r = lambda z: rb + (rt - rb)*(z - zb)/(zt - zb)
    rev(prefix + 'Body', [(r(zb), zb), (r(zt), zt)], wrapM, seg, loc, vrange=(zb, zt))
    rev(prefix + 'Foot', [(rb - .6*MM, 0), (rb - .3*MM, 0), (r(zb)*.999, zb)], rimM, seg, loc)
    rr = 1.5*MM; rim = [(r(zt) - t + rr - rr*math.cos(math.pi*i/10), zt + rr*math.sin(math.pi*i/10)) for i in range(11)]
    rev(prefix + 'Rim', [(r(zt), zt)] + [(x + t, z) for x, z in rim[1:]], rimM, seg, loc)
    rev(prefix + 'Inner', [(r(zt) - t, zt), (r(zb + 2*MM) - t, zb + 2*MM), (0, zb + 2*MM)], inM, seg, loc)
    top = zt + 2*rr*.5 + rr
    if lid:  # PS 盖：裙边内径 = 卷边外径，盖住卷边、上方浅穹顶 + 饮口凸台
        R0 = r(zt) + 2*rr + .2*MM
        rev(prefix + 'Lid', [(R0 - .4*MM, zt - 1.5*MM), (R0 + .5*MM, zt - 1.5*MM), (R0 + .8*MM, zt + 3.5*MM), (R0 - 1*MM, zt + 5*MM),
                             (R0 - 4*MM, zt + 6*MM), (R0 - 6*MM, zt + 9*MM), (R0*.55, zt + 10*MM), (0, zt + 10.5*MM)], lidM, seg, loc)
    return top

def mats_cup(kraft=False):
    if kraft:
        ps = paper_set('kraftcup', (0.28, 0.16, 0.08), .25, n=256, fib=.7, nstr=1.4, rough=(.88, .05))
        wrap = mat_print('ecoWrap', 'ecocup_wrap.png', ps, .85); inn = mat('kraftIn', texset=ps)
    else:
        ps = paper_set('cupboard', (0.96, 0.95, 0.92), .03, n=256, fib=.15, nstr=.6, rough=(.55, .04))
        wrap = mat_print('cupWrap', 'cup_wrap.png', ps, .45); inn = mat('cupIn', texset=ps, rough=.4)
    return ps, wrap, inn

def build_cup():
    reset(); ps, wrap, inn = mats_cup()
    lid = mat('lid', col=(0.9, 0.9, 0.88), rough=.3); rim = mat('cupRim', texset=ps, rough=.45)
    cup('Cup', wrap, inn, lid, rim)
    export_static('paper-cup.glb')

def build_ecocup():
    reset(); ps, wrap, inn = mats_cup(True)
    lid = mat('lidDark', col=(0.05, 0.05, 0.05), rough=.35); rim = mat('kraftRim', texset=ps)
    sl = paper_set('sleevep', (0.2, 0.11, 0.05), .3, n=128, fib=.6, nstr=1.6, rough=(.95, .03))
    sleeveM = mat_print('sleeve', 'sleeve.png', sl, .95)
    H, rb, rt, zb, zt = 110*MM, 28*MM, 45*MM, 8*MM, 108*MM
    cup('Eco', wrap, inn, lid, rim, H, rb, rt)
    # 瓦楞杯套 35..85mm，贴合杯身（内径 = 杯身半径 + 0.3mm），1.2mm 厚
    r = lambda z: rb + (rt - rb)*(z - zb)/(zt - zb) + .3*MM
    rev('Sleeve', [(r(35*MM) - .3*MM, 35*MM), (r(35*MM) + 1.2*MM, 35*MM), (r(85*MM) + 1.2*MM, 85*MM), (r(85*MM) - .3*MM, 85*MM)], sleeveM, 64, smooth=False)
    export_static('eco-paper-cup.glb')

def build_party():
    reset()
    ps = paper_set('partyboard', (0.97, 0.95, 0.9), .03, n=256, fib=.15, nstr=.6, rough=(.6, .04))
    dots = mat_print('plateDots', 'party_dots.png', ps, .6); stripes = mat_print('stripes', 'party_stripes.png', ps, .55)
    cupM = mat_print('partyCup', 'party_cup.png', ps, .5); white = mat('partyWhite', texset=ps)
    pom = mat('pompom', col=(0.65, 0.48, 0.85), rough=1.)
    # 纸盘 Ø230：平底 Ø150 + 斜边 + 卷边，底面贴地
    prof = [(0, 1*MM), (75*MM, 1*MM), (95*MM, 9*MM), (112*MM, 15*MM), (115*MM, 14.5*MM), (113*MM, 13*MM), (93*MM, 7.5*MM), (74*MM, 0), (0, 0)]
    o = rev('Plate', prof, dots, 72, loc=(40*MM, 20*MM, 0)); o.data.uv_layers.active.name = 'UVMap'
    # 平面贴图投影到盘面
    uvl = o.data.uv_layers['UVMap']
    for li, l in enumerate(o.data.loops):
        co = o.data.vertices[l.vertex_index].co; uvl.data[li].uv = (co.x/0.23 + .5, co.y/0.23 + .5)
    # 派对帽：底 Ø110 高 160 圆锥，0.4mm 纸壁 + 顶部绒球，底边贴地
    hx, hy = -150*MM, 90*MM
    rev('Hat', [(55*MM, 0), (1.5*MM, 158*MM)], stripes, 64, loc=(hx, hy, 0))
    rev('HatIn', [(54.6*MM, 0), (1.2*MM, 156*MM)], white, 64, loc=(hx, hy, 0))
    rev('Pompom', [(14*MM*math.sin(math.pi*i/16), 158*MM - 4*MM + 14*MM*(1 - math.cos(math.pi*i/16))) for i in range(17)], pom, 32, loc=(hx, hy, 0))
    # 9oz 派对纸杯 + 吸管（斜靠在杯沿、下端抵杯底）
    cx, cy = -120*MM, -90*MM
    top = cup('Party', cupM, white, None, white, 90*MM, 25*MM, 36*MM, loc=(cx, cy, 0), lid=False)
    p0 = Vector((cx + 10*MM, cy, 10*MM)); p1 = Vector((cx - 36*MM - 1*MM, cy, 88*MM)); d = (p1 - p0).normalized(); p2 = p0 + d*200*MM
    st = rev('Straw', [(3*MM, 0), (3*MM, 200*MM)], stripes, 16, loc=(0, 0, 0), vrange=(0, 200*MM))
    st.location = p0; st.rotation_euler = Vector((0, 0, 1)).rotation_difference(d).to_euler()
    export_static('party-supplies.glb')

{'cup': build_cup, 'ecocup': build_ecocup, 'party': build_party}[WHICH]()
print('DONE', WHICH)
