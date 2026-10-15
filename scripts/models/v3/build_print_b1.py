# #77 batch 1（Blender 4.2.3 LTS）：礼品卡+信封 / 精装胶印画册 / 三折页+传单
# blender -b --python build_print_b1.py -- <giftcard|offset|colorprint> <outdir>   (TEX_DIR=tex-b1/)
# 复用 build_boxes.py 的程序纸纹（paper_set）/材质/导出工具；印刷贴图来自 decals-b1.mjs
import bpy, bmesh, math, os, sys
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_boxes.py')).read()
exec(_src[:_src.rindex("{'corrugated'")])
TEX = os.environ.get('TEX_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tex-b1/'))
MM = .001

def mat_print(name, image, paper, rough=.5, coat=0.):
    """印刷面：贴图底色 + 纸纹法线；coat>0 为覆膜（clearcoat）"""
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = load(image) if isinstance(image, str) else image
    nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = paper[1]; nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = .35
    nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    rough = min(1., rough + float(os.environ.get('PRINT_ROUGH_ADD', .25))); coat *= float(os.environ.get('PRINT_COAT_SCALE', 0))
    b.inputs['Roughness'].default_value = rough
    b.inputs['Specular IOR Level'].default_value = float(os.environ.get('PRINT_SPEC', .25))  # #252：印刷面哑光（无覆膜 coat、粗糙度 +0.25、反射 0.25），藏青/牛皮色不再发灰
    if coat: b.inputs['Coat Weight'].default_value = coat; b.inputs['Coat Roughness'].default_value = .25
    return m

def rrect(w, d, r, seg=6):
    if r <= 0: return [(-w/2, -d/2), (w/2, -d/2), (w/2, d/2), (-w/2, d/2)]
    pts = []
    for cx, cy, a0 in [(w/2-r, -d/2+r, -90), (w/2-r, d/2-r, 0), (-w/2+r, d/2-r, 90), (-w/2+r, -d/2+r, 180)]:
        for i in range(seg+1):
            a = math.radians(a0 + 90*i/seg); pts.append((cx + r*math.cos(a), cy + r*math.sin(a)))
    return pts

def slab(name, outline, t, mats, top_uv=(0, 0, 1, 1), bot_uv=None, z0=0., bevel=0., parent=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    """厚度 t 的平板：顶面 mats[1]（UV 按包围盒映射到 top_uv）、底面 mats[2]（镜像）、侧边 mats[0]"""
    me = bpy.data.meshes.new(name); bm = bmesh.new(); n = len(outline)
    xs = [p[0] for p in outline]; ys = [p[1] for p in outline]; x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    bot = [bm.verts.new((x, y, z0)) for x, y in outline]; top = [bm.verts.new((x, y, z0 + t)) for x, y in outline]
    ft = bm.faces.new(top); ft.material_index = 1
    fb = bm.faces.new(list(reversed(bot))); fb.material_index = 2
    for i in range(n):
        j = (i+1) % n; f = bm.faces.new((bot[i], bot[j], top[j], top[i])); f.material_index = 0
    uvl = bm.loops.layers.uv.new('UVMap'); bu = bot_uv or top_uv
    for f in bm.faces:
        for l in f.loops:
            x, y, z = l.vert.co; u = (x - x0)/(x1 - x0); v = (y - y0)/(y1 - y0)
            if f.material_index == 1: l[uvl].uv = (top_uv[0] + u*(top_uv[2]-top_uv[0]), top_uv[1] + v*(top_uv[3]-top_uv[1]))
            elif f.material_index == 2: l[uvl].uv = (bu[0] + (1-u)*(bu[2]-bu[0]), bu[1] + v*(bu[3]-bu[1]))
            else: l[uvl].uv = (u*4 + v*4, (z - z0)/max(t, 1e-6)*.05)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    for m in mats: o.data.materials.append(m)
    o.location = loc; o.rotation_euler = rot
    if parent: o.parent = parent
    if bevel:
        md = o.modifiers.new('bev', 'BEVEL'); md.width = bevel; md.segments = 2; md.limit_method = 'ANGLE'; md.harden_normals = True
        o.modifiers.new('wn', 'WEIGHTED_NORMAL')
    return o

def export_static(name):
    for o in [o for o in bpy.data.objects if o.type == 'MESH']:
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name), export_format='GLB', export_apply=True, export_animations=False,
                              export_yup=True, export_image_format='AUTO', export_texcoords=True, export_normals=True, export_extras=False)

def build_giftcard():
    reset()
    paper = paper_set('envpaper', (0.95, 0.92, 0.86), .06, n=512, fib=.35, nstr=1.2, rough=(.86, .05))
    pvc = paper_set('cardcore', (0.97, 0.96, 0.95), .02, n=128, fib=0, nstr=.3, rough=(.35, .02))
    edge = mat('cardEdge', texset=pvc, rough=.35)
    front = mat_print('cardFront', 'giftcard_front.png', pvc, .28, coat=.6); back = mat_print('cardBack', 'giftcard_back.png', pvc, .4)
    env = mat('envelope', texset=paper); envp = mat_print('envelopePrint', 'envelope_print.png', paper, .85)
    # 信封 110×75mm（容纳 85.6×54 卡），背面朝上：主体 0.5mm + 封舌三角（叠在上面，与主体齐平贴合）
    EW, ED, ET = 110*MM, 75*MM, .5*MM
    slab('Envelope', rrect(EW, ED, 1.5*MM), ET, [env, env, env], bevel=.15*MM)
    flap = [(-EW/2 + 1.5*MM, ED/2 - .5*MM), (-EW/2 + 1*MM, ED/2 - 4*MM), (-6*MM, -ED*.12), (6*MM, -ED*.12), (EW/2 - 1*MM, ED/2 - 4*MM), (EW/2 - 1.5*MM, ED/2 - .5*MM)]
    slab('Flap', flap, .25*MM, [env, envp, env], z0=ET, bevel=.08*MM)
    # 卡 85.6×53.98×0.76mm，R3.18；斜放在信封上（底面贴合信封顶面）
    card = slab('Card', rrect(85.6*MM, 53.98*MM, 3.18*MM, 8), .76*MM, [edge, front, back], bevel=.2*MM)
    card.location = (6*MM, -5*MM, ET + .25*MM); card.rotation_euler = (0, 0, math.radians(-14))
    export_static('gift-card.glb')

def build_offset():
    reset()
    cloth = paper_set('coverpaper', (0.14, 0.2, 0.29), .12, n=512, fib=.2, nstr=.8, rough=(.55, .06))
    pagep = paper_set('pageedge', (0.95, 0.93, 0.88), .04, n=256, fib=0, nstr=.4, rough=(.9, .03))
    coverM = mat_print('catCover', 'catalog_cover.png', cloth, .42, coat=.25); backM = mat_print('catBack', 'catalog_back.png', cloth, .5)
    edgeM = mat('boardEdge', texset=cloth, rough=.55); spineM = mat_print('catSpine', 'catalog_spine.png', cloth, .45)
    # 页边：程序化细横纹
    h = np.tile((np.sin(np.arange(256)[:, None]*math.pi/2)*.5 + .5)*.06, (1, 256)); h = 1 - h
    pg = img('pagelines', np.stack([h*.95, h*.93, h*.88], -1)); pagesM = mat('pages', rough=.9, base_img=pg)
    PW, PH, PT = 207*MM, 280*MM, 16*MM; SQ, BT = 3*MM, 2.5*MM; BW, BH = PW + SQ, PH + 2*SQ
    root = empty('Book', (0, 0, 0))
    # 底板 / 书芯 / 面板：书脊在 -X；书芯离书脊 2mm（书槽），三层上下面完全贴合
    slab('BackBoard', rrect(BW, BH, 1*MM), BT, [edgeM, edgeM, backM], parent=root, loc=(BW/2 - PW/2 - SQ/2 + 1*MM, 0, 0), bevel=.4*MM)
    blk = slab('Pages', rrect(PW, PH, .3*MM), PT, [pagesM, pagesM, pagesM], z0=BT, parent=root, loc=(1*MM, 0, 0))
    slab('FrontBoard', rrect(BW, BH, 1*MM), BT, [edgeM, coverM, edgeM], z0=BT + PT, parent=root, loc=(BW/2 - PW/2 - SQ/2 + 1*MM, 0, 0), bevel=.4*MM)
    # 圆脊：半圆弧壳，正好包住两块板的外缘
    X0 = -PW/2 - SQ/2 + 1*MM - BW/2 + BW/2  # 板左缘 x
    X0 = (BW/2 - PW/2 - SQ/2 + 1*MM) - BW/2; R = (2*BT + PT)/2; zc = R
    prof = []; bmv = []
    me = bpy.data.meshes.new('Spine'); bm = bmesh.new(); uv = bm.loops.layers.uv.new('UVMap'); N = 16; rows = []
    for k in (0, 1):
        r = R if k == 0 else R - 1.2*MM
        rows.append([[bm.verts.new((X0 + .8*MM - .35*r*math.sin(math.pi*i/N), y, zc - r*math.cos(math.pi*i/N))) for i in range(N+1)] for y in (-BH/2, BH/2)])
    for i in range(N):
        f = bm.faces.new((rows[0][0][i], rows[0][0][i+1], rows[0][1][i+1], rows[0][1][i]))
        for l in f.loops: l[uv].uv = ((rows[0][0].index(l.vert) if l.vert in rows[0][0] else rows[0][1].index(l.vert))/N, 0 if l.vert in rows[0][0] else 1)
    for e in (0, 1):  # 端盖
        f = bm.faces.new(rows[0][e] + list(reversed(rows[1][e])))
    bm.normal_update(); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new('Spine', me); bpy.context.scene.collection.objects.link(o); o.data.materials.append(spineM); o.parent = root
    for p in me.polygons: p.use_smooth = True
    root.rotation_euler = (0, 0, math.radians(18))
    export_static('offset-catalog.glb')

def build_colorprint():
    reset()
    paper = paper_set('coated', (0.97, 0.95, 0.91), .03, n=256, fib=.1, nstr=.6, rough=(.45, .04))
    edgeM = mat('sheetEdge', texset=paper, rough=.6)
    inM = mat_print('triInside', 'tri_in.png', paper, .38); outM = mat_print('triOutside', 'tri_out.png', paper, .38)
    flyM = mat_print('flyer', 'flyer.png', paper, .35); flyB = mat('flyerBack', texset=paper)
    PW, PH, T = 99*MM, 210*MM, .3*MM
    # 三折页（关门折半展开）立在台面：面板竖直（局部 Y→世界 Z），内页朝镜头；折痕处面板边对齐、无缝隙
    def vpanel(name, i, x, y, ang):
        o = slab(name, rrect(PW, PH, 0), T, [edgeM, inM, outM], top_uv=(i/3, 0, (i+1)/3, 1), bot_uv=((2-i)/3, 0, (3-i)/3, 1))
        bpy.context.view_layer.update()
        o.rotation_euler = (math.radians(90), 0, math.radians(ang)); o.location = (x, y, PH/2); return o
    a = math.radians(32)
    vpanel('PanelCenter', 1, 0, 0, 0)
    vpanel('PanelLeft', 0, -PW/2 - PW/2*math.cos(a), -PW/2*math.sin(a), 32)
    vpanel('PanelRight', 2, PW/2 + PW/2*math.cos(a), -PW/2*math.sin(a), -32)
    # A5 传单一叠：5 张平铺略错开，彼此上下贴合
    for k in range(5):
        slab(f'Flyer{k}', rrect(148*MM, 210*MM, 0), .2*MM, [edgeM, flyM, flyB], z0=k*.2*MM,
             loc=(.06 + k*.6*MM, -.17 + k*.4*MM, 0), rot=(0, 0, math.radians(-22 + k*1.6)))
    export_static('color-printing.glb')

{'giftcard': build_giftcard, 'offset': build_offset, 'colorprint': build_colorprint}[WHICH]()
print('DONE', WHICH)
