# #77 batch 2（Blender 4.2.3 LTS）：反插式彩盒（顶盖打开见插舌/防尘翼）/ 圣诞纸罐+挂球 / 30 枚纸浆蛋托
# blender -b --python build_b2.py -- <color|xmas|pulp> <outdir>   (TEX_DIR=tex-b2/)
import bpy, bmesh, math, os, sys
_d = os.path.dirname(os.path.abspath(__file__))
_src = open(os.path.join(_d, 'build_print_b1.py')).read()
exec(_src[:_src.rindex("{'giftcard'")])
TEX = os.environ.get('TEX_DIR', os.path.join(_d, 'tex-b2/'))

def cuboid(name, size, center, mats, face_mat, parent=None):
    """长方体；face_mat: {'+x':idx,...} 未列出的面用 0；每面 UV 0..1（从外侧看正向）"""
    me = bpy.data.meshes.new(name); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x*size[0] + center[0], v.co.y*size[1] + center[1], v.co.z*size[2] + center[2]))
    uvl = bm.loops.layers.uv.new('UVMap'); bm.normal_update()
    lo = [center[k] - size[k]/2 for k in range(3)]
    for f in bm.faces:
        n = f.normal; ax = max(range(3), key=lambda k: abs(n[k])); key = ('+' if n[ax] > 0 else '-') + 'xyz'[ax]
        f.material_index = face_mat.get(key, 0)
        for l in f.loops:
            p = [(l.vert.co[k] - lo[k])/max(size[k], 1e-9) for k in range(3)]
            if ax == 0: u, v = (p[1] if n[0] > 0 else 1 - p[1]), p[2]
            elif ax == 1: u, v = (1 - p[0] if n[1] > 0 else p[0]), p[2]
            else: u, v = p[0], (p[1] if n[2] > 0 else 1 - p[1])
            l[uvl].uv = (u, v)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    for m in mats: o.data.materials.append(m)
    if parent: o.parent = parent
    md = o.modifiers.new('bev', 'BEVEL'); md.width = min(size)*.35; md.segments = 2; md.limit_method = 'ANGLE'; md.harden_normals = True
    o.modifiers.new('wn', 'WEIGHTED_NORMAL')
    return o

def build_color():
    reset()
    board = paper_set('sbs', (0.95, 0.94, 0.91), .03, n=256, fib=.15, nstr=.6, rough=(.8, .04))
    inner = mat('boardInner', texset=board)
    front = mat_print('boxFront', 'colorbox_front.png', board, .42, coat=.3); side = mat_print('boxSide', 'colorbox_side.png', board, .42, coat=.3)
    lidM = mat_print('boxLid', 'colorbox_lid.png', board, .42, coat=.3)
    W, D, H, t = 80*MM, 40*MM, 160*MM, .45*MM   # 350g SBS 白卡
    M = [inner, front, side, lidM]
    cuboid('Front', (W, t, H), (0, -D/2 + t/2, H/2), M, {'-y': 1})
    cuboid('Back', (W, t, H), (0, D/2 - t/2, H/2), M, {'+y': 1})
    cuboid('Right', (t, D - 2*t, H), (W/2 - t/2, 0, H/2), M, {'+x': 2})
    cuboid('Left', (t, D - 2*t, H), (-W/2 + t/2, 0, H/2), M, {'-x': 2})
    cuboid('Bottom', (W - 2*t, D - 2*t, t), (0, 0, t/2), M, {'-z': 2})
    # 顶盖：铰接在背板上沿，向后打开 115°；前端插舌（12mm，带圆角感由倒角体现）与盖板 90° 相接
    lid = empty('Lid', (0, D/2, H)); lid.rotation_euler = (math.radians(-115), 0, 0)
    cuboid('LidPanel', (W, D, t), (0, -D/2, t/2), M, {'+z': 3}, parent=lid)
    cuboid('Tuck', (W - 1.5*MM, t, 12*MM), (0, -D + t/2, -6*MM + t), M, {'-y': 2}, parent=lid)
    # 防尘翼：铰接在侧板上沿，外翻 25°
    for s in (1, -1):
        e = empty(f'Dust{s}', (s*(W/2 - t), 0, H)); e.rotation_euler = (0, math.radians(s*25), 0)
        cuboid(f'DustFlap{s}', (t, D - 3*MM, 13*MM), (s*t/2, 0, 6.5*MM), M, {('+x' if s > 0 else '-x'): 2}, parent=e)
    export_static('color-box.glb')

def build_xmas():
    reset()
    board = paper_set('tubeboard', (0.9, 0.88, 0.84), .04, n=256, fib=.2, nstr=.8, rough=(.6, .05))
    tubeM = mat_print('xmasTube', 'xmas_tube.png', board, .5, coat=.2); topM = mat_print('xmasCapTop', 'xmas_captop.png', board, .55)
    capM = mat('xmasCap', col=(0.03, 0.2, 0.1), rough=.55); edgeM = mat('tubeEdge', texset=board)
    gold = mat('bauble', col=(0.85, 0.6, 0.25), rough=.18, metal=1.)
    capMetal = mat('baubleCap', col=(0.8, 0.78, 0.72), rough=.3, metal=1.)
    R, H, Rc, Hc = 50*MM, 160*MM, 51*MM, 45*MM   # 纸罐 Ø100×160，盖 Ø102 高 45，盖住筒身上部、内壁贴合
    lathe('TubeBody', [(R, 0), (R, H - Hc)], tubeM, seg=64, vrange=(0, H - Hc))
    lathe('TubeBottom', [(0, 0), (R - 1*MM, 0), (R, .8*MM)], edgeM, seg=64)
    lathe('CapWall', [(Rc - 1*MM, H - Hc + 1.5*MM), (Rc - .3*MM, H - Hc), (Rc, H - Hc + .5*MM), (Rc, H + 1.8*MM), (Rc - .4*MM, H + 2.6*MM), (Rc - 1.6*MM, H + 3*MM)], capM, seg=64)
    o = slab('CapTop', rrect(2*(Rc - 1.6*MM), 2*(Rc - 1.6*MM), Rc - 1.6*MM - .01*MM, 16), .2*MM, [capM, topM, capM], z0=H + 2.8*MM)
    # 挂球 Ø70 放在台面上（底部接地），金属挂帽 + 吊环
    br, bx, by = 35*MM, 95*MM, -40*MM
    prof = [(br*math.sin(math.pi*i/24), br - br*math.cos(math.pi*i/24)) for i in range(25)]
    lathe('Bauble', prof, gold, seg=48, loc=(bx, by, 0))
    lathe('BaubleCap', [(0, 2*br - 1*MM), (6*MM, 2*br - 1*MM), (6.2*MM, 2*br + 6*MM), (0, 2*br + 6*MM)], capMetal, seg=24, loc=(bx, by, 0))
    bpy.ops.mesh.primitive_torus_add(major_radius=3.5*MM, minor_radius=.7*MM, location=(bx, by, 2*br + 9*MM), rotation=(math.radians(90), 0, 0))
    bpy.context.object.data.materials.append(capMetal)
    export_static('christmas-tube.glb')

def build_pulp():
    reset()
    pulp = paper_set('pulp', (0.74, 0.71, 0.65), .35, n=512, fib=1.0, nstr=4.0, rough=(.95, .03))
    m = mat('pulp', texset=pulp)
    # 30 枚蛋托 300×300：6×5 蛋窝（节距 48mm）+ 窝间锥柱 + 8mm 平边；高度场 + 1.6mm 实体化
    NX, NY, P, RIM = 6, 5, 48*MM, 8*MM; Wx, Wy = 300*MM, 300*MM
    nx, ny = 66, 66; V = []; F = []
    import numpy as _np
    for j in range(ny + 1):
        for i in range(nx + 1):
            x = -Wx/2 + Wx*i/nx; y = -Wy/2 + Wy*j/ny
            u = (x + NX*P/2)/P; v = (y + NY*P*1.2/2)/(P*1.2)   # Y 方向窝距略大，铺满 300mm
            inside = 0 <= u <= NX and 0 <= v <= NY
            if inside:
                cu = (math.cos(2*math.pi*(u - .5)) + math.cos(2*math.pi*(v - .5)))/2   # 窝心 = -1，锥柱顶 = +1
                h = 24*MM + (cu*22*MM if cu > 0 else -((-cu)**.7)*22*MM)
            else: h = 24*MM
            V.append((x, y, h))
    for j in range(ny):
        for i in range(nx):
            a = j*(nx + 1) + i; F.append((a, a + 1, a + nx + 2, a + nx + 1))
    o = obj_from('Tray', V, F, m, uvs=3.0)
    for p in o.data.polygons: p.use_smooth = True
    md = o.modifiers.new('sol', 'SOLIDIFY'); md.thickness = 1.6*MM; md.offset = 1
    bpy.context.view_layer.update(); zmin = min((o.matrix_world @ Vector(c)).z for c in o.bound_box)
    o.location.z = -zmin  # 蛋窝底贴合台面
    export_static('pulp-egg-tray.glb')

{'color': build_color, 'xmas': build_xmas, 'pulp': build_pulp}[WHICH]()
print('DONE', WHICH)
