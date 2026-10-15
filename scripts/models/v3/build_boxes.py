# Blender 4.2 headless: blender -b --python build.py -- <which> <outdir>
import bpy, bmesh, math, sys, os
import numpy as np
from mathutils import Vector, Matrix
argv = sys.argv[sys.argv.index('--')+1:]
WHICH, OUT = argv[0], argv[1]
TEX = os.environ.get("TEX_DIR", os.path.join(os.path.dirname(__file__), "tex"))
rng = np.random.default_rng(7)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene; sc.name = 'Open'; sc.render.fps = 24; sc.frame_start = 0; sc.frame_end = 30

# ---------- procedural CC0 textures (numpy) ----------
def value_noise(n, cells):
    g = rng.random((cells+1, cells+1)); g[-1] = g[0]; g[:, -1] = g[:, 0]
    x = np.linspace(0, cells, n, endpoint=False); i = x.astype(int); f = x - i; f = f*f*(3-2*f)
    a = g[i][:, i]; b = g[i][:, i+1]; c = g[i+1][:, i]; d = g[i+1][:, i+1]
    fx = f[None, :]; fy = f[:, None]
    return (a*(1-fx)+b*fx)*(1-fy) + (c*(1-fx)+d*fx)*fy
def fbm(n, base=4, oct=5, beta=1.8):
    w = rng.standard_normal((n, n)); F = np.fft.fft2(w)
    fx = np.fft.fftfreq(n)[None, :]; fy = np.fft.fftfreq(n)[:, None]; f = np.sqrt(fx*fx + fy*fy); f[0, 0] = 1
    h = np.real(np.fft.ifft2(F / f**(beta/2) * (f > base/n/2)))
    h = (h - h.min())/(h.max() - h.min()); return h
def fibers(n, count, length, stretch=1.0):
    h = np.zeros((n, n))
    for _ in range(count):
        x, y = rng.random()*n, rng.random()*n; a = rng.normal(0, .35) if stretch else rng.random()*math.pi
        for t in range(length):
            h[int(y + t*math.sin(a)) % n, int(x + t*math.cos(a)) % n] += 1
    return h/ max(h.max(), 1)
def normal_from_h(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1))*strength; dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0))*strength
    nrm = np.stack([-dx, dy, np.ones_like(h)], -1); nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    return nrm*.5 + .5
def img(name, arr):
    n = arr.shape[0]
    if arr.ndim == 2: arr = np.stack([arr]*3, -1)
    rgba = np.concatenate([arr, np.ones((n, n, 1))], -1) if arr.shape[-1] == 3 else arr
    im = bpy.data.images.new(name, n, n, alpha=True); im.pixels.foreach_set(np.flipud(rgba).astype(np.float32).ravel())
    im.filepath_raw = f'/tmp/{name}.png'; im.file_format = 'PNG'; im.save(); return im
def paper_set(name, col, var, n=512, fib=0.5, nstr=3.0, rough=(.85, .05)):
    h = fbm(n, 6, 5)*.45 + fbm(n, 60, 5, 1.2)*.25 + fibers(n, 2500, 14)*fib
    c = np.array(col)[None, None, :]*(1 - var*.5 + var*(h[..., None]))
    r = np.clip(rough[0] + (h - .5)*rough[1], 0, 1)
    orm = np.stack([np.ones_like(r), r, np.zeros_like(r)], -1)
    return img(name+'_col', np.clip(c, 0, 1)), img(name+'_nrm', normal_from_h(h, nstr)), img(name+'_orm', orm)

def load(f):
    im = bpy.data.images.load(TEX + f); return im

# ---------- materials ----------
def c_dark(ts): return ts[0].name.startswith(('darkpaper', 'winepaper'))
def mat(name, col=None, rough=.6, metal=0., texset=None, uvscale=1., alpha_img=None, base_img=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if col: b.inputs['Base Color'].default_value = (*col, 1)
    if texset:
        if c_dark(texset): b.inputs['Specular IOR Level'].default_value = .35
        c, n, o = texset
        tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = c; nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = n; n.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
        to = nt.nodes.new('ShaderNodeTexImage'); to.image = o; o.colorspace_settings.name = 'Non-Color'
        sp = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(to.outputs['Color'], sp.inputs['Color'])
        nt.links.new(sp.outputs['Green'], b.inputs['Roughness']); nt.links.new(sp.outputs['Blue'], b.inputs['Metallic'])
    if base_img:
        tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = base_img; nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
    if alpha_img:
        ta = nt.nodes.new('ShaderNodeTexImage'); ta.image = alpha_img; nt.links.new(ta.outputs['Alpha'], b.inputs['Alpha'])
        m.blend_method = 'CLIP'; m.alpha_threshold = .5
    return m

# ---------- geometry helpers ----------
def obj_from(name, verts, faces, m, parent=None, origin=(0, 0, 0), uv='world', uvs=1.0):
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.update()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(m)
    bm = bmesh.new(); bm.from_mesh(me); lay = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        nx, ny, nz = (abs(v) for v in f.normal)
        for l in f.loops:
            p = l.vert.co
            if uv == 'world':
                u, v = ((p.y, p.z) if nx >= ny and nx >= nz else (p.x, p.z) if ny >= nz else (p.x, p.y))
                l[lay].uv = (u*uvs, v*uvs)
    bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = False
    if parent: o.parent = parent
    return o
def box_geo(cx, cy, cz, sx, sy, sz, off=0):
    x0, x1, y0, y1, z0, z1 = cx-sx/2, cx+sx/2, cy-sy/2, cy+sy/2, cz-sz/2, cz+sz/2
    v = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    f = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    return v, [tuple(i+off for i in q) for q in f]
def boxes(name, specs, m, parent=None, uvs=1.0, bevel=0):
    V, F = [], []
    for s in specs: v, f = box_geo(*s, off=len(V)); V += v; F += f
    o = obj_from(name, V, F, m, parent, uvs=uvs)
    if bevel:
        md = o.modifiers.new('bev', 'BEVEL'); md.width = bevel; md.segments = 3; md.limit_method = 'ANGLE'; md.harden_normals = True
        o.modifiers.new('wn', 'WEIGHTED_NORMAL')
    return o
def plane(name, center, normal_axis, sign, w, h, m, parent=None):
    # textured decal plane: u along w, v along h, uv 0..1
    cx, cy, cz = center
    if normal_axis == 'y':
        d = [(cx + sign*w/2, cy, cz - h/2), (cx - sign*w/2, cy, cz - h/2), (cx - sign*w/2, cy, cz + h/2), (cx + sign*w/2, cy, cz + h/2)]
    elif normal_axis == 'x':
        d = [(cx, cy - sign*w/2, cz - h/2), (cx, cy + sign*w/2, cz - h/2), (cx, cy + sign*w/2, cz + h/2), (cx, cy - sign*w/2, cz + h/2)]
    else:  # z up
        d = [(cx - w/2, cy - h/2, cz), (cx + w/2, cy - h/2, cz), (cx + w/2, cy + h/2, cz), (cx - w/2, cy + h/2, cz)]
    if normal_axis == 'y' and sign < 0: f = [(0, 1, 2, 3)]
    elif normal_axis == 'y': f = [(0, 1, 2, 3)]
    else: f = [(0, 1, 2, 3)]
    me = bpy.data.meshes.new(name); me.from_pydata(d, [], f); me.update()
    uvl = me.uv_layers.new(name='UVMap')
    uvsq = [(0, 0), (1, 0), (1, 1), (0, 1)]
    for li, loop in enumerate(me.loops): uvl.data[li].uv = uvsq[d.index(me.vertices[loop.vertex_index].co[:]) if False else loop.vertex_index]
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); o.data.materials.append(m)
    if parent: o.parent = parent
    return o
def lathe(name, prof, m, seg=48, parent=None, loc=(0, 0, 0), vrange=None):
    V, F, UV = [], [], []
    P = len(prof); L = [0]
    for j in range(1, P): L.append(L[-1] + math.dist(prof[j], prof[j-1]))
    for s in range(seg+1):
        a = 2*math.pi*s/seg
        for (r, z) in prof: V.append((loc[0] + r*math.cos(a), loc[1] + r*math.sin(a), loc[2] + z))
    for s in range(seg):
        for j in range(P-1):
            a = s*P + j; b = a + P; F.append((a, b, b+1, a+1))
    me = bpy.data.meshes.new(name); me.from_pydata(V, [], F); me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        poly.use_smooth = True
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index; s, j = divmod(vi, P)
            if vrange: z0, z1 = vrange; vv = (prof[j][1] - z0)/(z1 - z0)
            else: vv = L[j]/L[-1]
            uvl.data[li].uv = (1 - s/seg, vv)
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); o.data.materials.append(m)
    if parent: o.parent = parent
    return o
def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None); e.location = loc; bpy.context.scene.collection.objects.link(e)
    if parent: e.parent = parent
    return e
def key_rot(o, frames, axis, degs):
    o.rotation_mode = 'XYZ'
    for fr, d in zip(frames, degs):
        r = [0, 0, 0]; r['xyz'.index(axis)] = math.radians(d); o.rotation_euler = r; o.keyframe_insert('rotation_euler', frame=fr)
def key_loc(o, frames, locs):
    for fr, l in zip(frames, locs): o.location = l; o.keyframe_insert('location', frame=fr)
def ease(n, total):  # eased fractions
    return [ (1 - math.cos(math.pi*i/(n-1)))/2 for i in range(n)]
def flatten_static(root):
    # 不动的部件（没有动画的 empty）下的网格挂回 root，便于合并成一个网格
    bpy.context.view_layer.update()
    for e in [o for o in root.children if o.type == 'EMPTY' and not (o.animation_data and o.animation_data.action)]:
        for c in list(e.children):
            mw = c.matrix_world.copy(); c.parent = root; c.matrix_world = mw
        bpy.data.objects.remove(e)
def join_children():
    # 每个运动部件（empty）下的网格合并为一个对象（多材质→多 primitive），减少 mesh 数量
    for e in [o for o in bpy.data.objects if o.type == 'EMPTY']:
        kids = [c for c in e.children if c.type == 'MESH']
        if len(kids) < 2: continue
        for o in bpy.context.selected_objects: o.select_set(False)
        for k in kids:
            k.select_set(True)
            bpy.context.view_layer.objects.active = k
            for m in list(k.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.context.view_layer.objects.active = kids[0]
        bpy.ops.object.join(); kids[0].name = e.name + '_mesh'
def export(name):
    for r in [o for o in bpy.data.objects if o.type == 'EMPTY' and o.parent is None]: flatten_static(r)
    join_children()
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name), export_format='GLB', export_apply=True, export_animation_mode='SCENE',
                              export_yup=True, export_image_format='AUTO', export_texcoords=True, export_normals=True, export_extras=False,
                              export_force_sampling=False, export_optimize_animation_size=True, export_def_bones=False, export_frame_range=True)

# ---------- corrugated panel (two liners + sine fluting), panel in local XY, thickness along Z ----------
def corr_panel(name, w, h, outer_m, inner_m, flute_m, parent=None, pitch=.008, t=.004, flute_along='y', origin=(0,0,0), flutes=True):
    lt = .0004; ox, oy, oz = origin
    outer = boxes(name+'_out', [(ox + w/2, oy + h/2, oz + t/2 - lt/2, w, h, lt)], outer_m, parent, uvs=1/0.5)
    inner = boxes(name+'_in', [(ox + w/2, oy + h/2, oz - t/2 + lt/2, w, h, lt)], inner_m, parent, uvs=4)
    if not flutes:
        # 无切边的面：两层面纸之间用平整芯层封边
        return outer, inner, boxes(name+'_core', [(ox + w/2, oy + h/2, oz, w, h, t - 2*lt)], flute_m, parent, uvs=60)
    # fluting strip: waves along x (if flutes run along y)
    L = w if flute_along == 'y' else h; E = h if flute_along == 'y' else w
    n = max(8, int(L/pitch*4)); V = []; F = []
    for i in range(n+1):
        s = L*i/n; z = (t/2 - lt)*.92*math.sin(2*math.pi*s/pitch)
        for e in (0, E):
            V.append((ox + s, oy + e, oz + z) if flute_along == 'y' else (ox + e, oy + s, oz + z))
    for i in range(n): a = 2*i; F.append((a, a+2, a+3, a+1))
    fl = obj_from(name+'_flute', V, F, flute_m, parent, uvs=60)
    fl.data.materials[0].use_backface_culling = False
    return outer, inner, fl

def build_corrugated():
    reset()
    W, D, H, t = .40, .30, .30, .004
    white = paper_set('whitetop', (0.93, 0.89, 0.82), .08, fib=.3, nstr=1.0)
    kraft = paper_set('kraft', (0.66, 0.47, 0.30), .22, fib=.7, nstr=1.6)
    m_out = mat('WhiteTopLiner', texset=white); m_in = mat('KraftLiner', texset=kraft)
    m_fl = m_in  # 芯层与内层面纸同材质（同为牛皮纸），减少 primitive
    m_flap_k = mat('Fluting', texset=kraft)  # 摇盖的内层+瓦楞芯（预览中压平）
    m_print = mat('CoralInk', col=(0.80, 0.20, 0.13), rough=.7, alpha_img=load('corr_print.png'))
    m_label = mat('Label', rough=.5, base_img=load('corr_label.png'))
    root = empty('CorrugatedBox', (0, 0, 0))
    def wall(name, loc, rot, w, h):
        e = empty(name, loc, root); e.rotation_euler = rot
        corr_panel(name, w, h, m_out, m_in, m_fl, e, origin=(0, 0, 0), flutes=False)
        return e
    # walls: panel local x=width, y=height, z=outward
    wall('WallFront', (-W/2, -D/2 + t/2, 0), (math.radians(90), 0, 0), W, H)
    e = wall('WallBack', (W/2, D/2 - t/2, 0), (math.radians(90), 0, math.radians(180)), W, H)
    wall('WallRight', (W/2 - t/2, -D/2 + t, 0), (math.radians(90), 0, math.radians(90)), D - 2*t, H)
    wall('WallLeft', (-W/2 + t/2, D/2 - t, 0), (math.radians(90), 0, math.radians(-90)), D - 2*t, H)
    # bottom (closed flaps, simplified as a panel)
    b = empty('Bottom', (-W/2 + t, -D/2 + t, t/2), root); corr_panel('Bottom', W - 2*t, D - 2*t, m_in, m_in, m_fl, b, flutes=False)
    # top flaps: hinge at top edge of each wall; flap local: x along hinge, y away from hinge, z normal (up when closed)
    flaps = []
    def flap(name, hinge, rotz, w, L, zoff):
        e = empty(name, hinge, root); e.rotation_euler = (0, 0, rotz)
        corr_panel(name, w, L, m_out, m_flap_k, m_flap_k, e, origin=(-w/2, 0, zoff))
        return e
    # minor flaps (left/right) underneath, major flaps (front/back) on top, meeting in middle
    fL = flap('FlapLeft', (-W/2 + t/2, 0, H), math.radians(-90), D - 2*t - .002, D/2 - .002, t/2)  # minor flap depth = D/2，压在箱壁顶边上
    fR = flap('FlapRight', (W/2 - t/2, 0, H), math.radians(90), D - 2*t - .002, D/2 - .002, t/2)
    fF = flap('FlapFront', (0, -D/2 + t/2, H), 0, W, D/2 - t/2 - .001, 1.5*t)
    fB = flap('FlapBack', (0, D/2 - t/2, H), math.radians(180), W, D/2 - t/2 - .001, 1.5*t)
    # closed: flaps lie flat (rotation about local x = 0). Our flap local y points inward. Open: rotate outward about hinge.
    # store rotation via parent euler: hinge axis is local X; use rotation_mode with delta via child empties
    for e in (fL, fR, fF, fB):
        e.rotation_mode = 'XYZ'
    fr = [0, 6, 12, 18, 24]
    def anim(e, deg, delay):
        rz = e.rotation_euler[2]
        for f, k in zip(fr, ease(5, 1)):
            ff = f + delay
            e.rotation_euler = (math.radians(deg*k), 0, rz); e.keyframe_insert('rotation_euler', frame=ff)
    anim(fF, 200, 0); anim(fB, 200, 2); anim(fL, 195, 6); anim(fR, 195, 6)
    # print decals on long sides + label + tape strip (on closed major flaps; tape moves with front flap half)
    plane('PrintFront', (0, -D/2 - .0004, H*.55), 'y', -1, .36, .18, m_print, root)
    plane('PrintBack', (0, D/2 + .0004, H*.55), 'y', 1, .36, .18, m_print, root)
    plane('Label', (W/2 + .0006, 0, H*.45), 'x', 1, .12, .09, m_label, root)
    # 封箱胶带：两片在大摇盖上，开箱时随摇盖分开（像被划开）；前后壁各一段下垂胶带
    m_tape = mat('KraftTape', col=(0.50, 0.33, 0.17), rough=.32)
    LF = D/2 - t/2 - .001
    for e in (fF, fB): boxes(e.name + '_tape', [(0, LF/2, 2*t + .0004, .048, LF, .0004)], m_tape, e, uvs=1)
    boxes('TapeTabs', [(0, -D/2 - .0004, H - .03, .048, .0004, .06), (0, D/2 + .0004, H - .03, .048, .0004, .06)], m_tape, root, uvs=1)
    export('corrugated-box.glb')

def rigid_tray(name, W, D, H, wall, m_outer, m_inner, parent, bevel=.0015, top_down=False):
    # open-top tray (or open-bottom lid when top_down); outer wrap + inner paper as separate objects
    s = -1 if top_down else 1
    z0 = 0
    outer = boxes(name+'_wrap', [
        (0, 0, s*wall/2, W - 2*wall, D - 2*wall, wall),
        (0, -D/2 + wall/2, s*H/2, W, wall, H), (0, D/2 - wall/2, s*H/2, W, wall, H),
        (-W/2 + wall/2, 0, s*H/2, wall, D - 2*wall, H), (W/2 - wall/2, 0, s*H/2, wall, D - 2*wall, H)], m_outer, parent, uvs=2, bevel=bevel)
    inner = boxes(name+'_lining', [
        (0, 0, s*(wall + .0002), W - 2*wall - .0002, D - 2*wall - .0002, .0004),
        (0, -D/2 + wall + .0002, s*H/2, W - 2*wall, .0004, H - .002), (0, D/2 - wall - .0002, s*H/2, W - 2*wall, .0004, H - .002),
        (-W/2 + wall + .0002, 0, s*H/2, .0004, D - 2*wall, H - .002), (W/2 - wall - .0002, 0, s*H/2, .0004, D - 2*wall, H - .002)], m_inner, parent, uvs=4)
    return outer, inner

def build_gift():
    reset()
    W, D, H, wall = .26, .26, .10, .0025
    LH = .045; gap = .0012; LW = W + 2*(wall + gap)
    dark = paper_set('darkpaper', (0.12, 0.117, 0.125), .35, fib=.25, nstr=.5, rough=(.66, .12))
    m_dark = mat('DarkTexturedPaper', texset=dark)
    m_inner = mat('InnerPaper', col=(0.02, 0.02, 0.022), rough=.95)
    velvet = paper_set('velvet', (0.07, 0.065, 0.07), .4, fib=0, nstr=1.0, rough=(.95, .05))
    m_vel = mat('BlackVelvetInsert', texset=velvet)
    m_gold = mat('GoldFoil', col=(0.69, 0.40, 0.075), rough=.30, metal=1, alpha_img=load('gift_foil.png'))
    m_satin = mat('GoldSatinRibbon', col=(0.78, 0.56, 0.24), rough=.35, metal=1)
    root = empty('GiftBox', (0, 0, 0))
    base = empty('Base', (0, 0, 0), root)
    rigid_tray('Base', W, D, H, wall, m_dark, m_inner, base)
    # insert: velvet board with recessed cavity (boolean)
    ins = boxes('Insert', [(0, 0, wall + .015, W - 2*wall - .001, D - 2*wall - .001, .03)], m_vel, base, uvs=6)
    cut = boxes('cut', [(0, 0, wall + .03, .15, .15, .03)], m_vel)
    bo = ins.modifiers.new('cav', 'BOOLEAN'); bo.object = cut; bo.operation = 'DIFFERENCE'; bo.solver = 'EXACT'
    cut.hide_set(True); cut.hide_render = True
    bpy.context.view_layer.objects.active = ins; ins.select_set(True); bpy.ops.object.modifier_apply(modifier='cav'); bpy.data.objects.remove(cut)
    # lid (天地盖)：empty 在盖顶面；顶板 z∈[-wall,0]，裙边向下 LH；顶板下表面正好压在底盒口沿 z=H 上
    lid = empty('Lid', (0, 0, H + wall + .0003), root)
    rigid_tray('Lid', LW, LW, LH, wall, m_dark, m_inner, lid, top_down=True, bevel=.002)
    plane('LidFoil', (0, 0, .0003), 'z', 1, LW*.86, LW*.86, m_gold, lid)
    rw = .018; rx = LW*.38
    boxes('Ribbon', [(rx, 0, .0005, rw, LW + .0016, .0008), (rx, -LW/2 - .0004, -LH/2, rw, .0008, LH), (rx, LW/2 + .0004, -LH/2, rw, .0008, LH)], m_satin, lid)
    for sgn in (-1, 1):
        prof = [(.012 + .0045*math.cos(a), .0025*math.sin(a)) for a in np.linspace(0, 2*math.pi, 10)]
        o = lathe('BowLoop', prof, m_satin, seg=24, parent=lid)
        o.scale = (1.4, .6, 1); o.location = (rx, sgn*.021, .0045); o.rotation_euler = (sgn*math.radians(14), 0, math.radians(90))
    boxes('BowKnot', [(rx, 0, .004, .021, .013, .007)], m_satin, lid, bevel=.002)
    # 动画：抬起 → 后移翻转 → 立靠在底盒后方（盖面朝前，全程在画面内，不与底盒相交）
    fr = [0, 6, 12, 18, 24]; top = H + wall + .0003
    key_loc(lid, fr, [(0, 0, top), (0, 0, top + .05), (0, .06, top + .10), (0, .13, .19), (0, .157, .1415)])
    key_rot(lid, fr, 'x', [0, 0, 25, 60, 80])
    export('gift-box.glb')

def build_wine():
    reset()
    W, D, H, wall = .115, .115, .36, .0025
    BH = .29; LH = H - BH  # base height; lid = top cap + back + front flap
    dark = paper_set('winepaper', (0.12, 0.117, 0.125), .35, fib=.3, nstr=.5, rough=(.72, .08))
    m_dark = mat('DarkTexturedPaper', texset=dark)
    m_inner = mat('InnerPaper', col=(0.025, 0.02, 0.02), rough=.95)
    m_gold = mat('GoldFoil', col=(0.69, 0.40, 0.075), rough=.30, metal=1, alpha_img=load('wine_foil.png'))
    satin = paper_set('cream', (0.92, 0.87, 0.78), .1, fib=.1, nstr=1.0, rough=(.6, .05))
    m_satin = mat('CreamSatinInsert', texset=satin)
    root = empty('WineBox', (0, 0, 0))
    base = empty('Base', (0, 0, 0), root)
    rigid_tray('Base', W, D, H - .12, wall, m_dark, m_inner, base, bevel=.0015)
    # bottle insert: card board block with round cradle + neck support
    # 酒瓶托：底托把瓶子抬高，瓶口距盖板约 12mm（开盖即可看到瓶颈、瓶封）
    z0 = H - .012 - .302
    ins = boxes('Insert', [(0, 0, (wall + z0 + .05)/2, W - 2*wall - .001, D - 2*wall - .001, z0 + .05 - wall)], m_satin, base, uvs=8)
    cyl = lathe('cutter', [(0, 0), (.0385, 0), (.0385, .2), (0, .2)], m_satin, seg=48, loc=(0, 0, z0))
    bo = ins.modifiers.new('cav', 'BOOLEAN'); bo.object = cyl; bo.operation = 'DIFFERENCE'; bo.solver = 'EXACT'
    bpy.context.view_layer.objects.active = ins; ins.select_set(True); bpy.ops.object.modifier_apply(modifier='cav'); bpy.data.objects.remove(cyl)
    # bottle (750ml Bordeaux, ~300mm tall, 75mm dia) standing in cradle
    glass = mat('BottleGlass', col=(0.02, 0.07, 0.035), rough=.07)
    prof = [(0, 0), (.035, 0), (.0372, .006), (.0372, .205), (.034, .225), (.022, .245), (.0145, .265), (.0142, .29), (.0155, .293), (.0155, .30), (0, .301)]
    bl = empty('BottleLift', (0, 0, 0), base)
    lathe('Bottle', prof, glass, seg=48, parent=bl, loc=(0, 0, z0))
    foil = mat('Capsule', col=(0.69, 0.40, 0.075), rough=.32, metal=1)
    lathe('Capsule', [(.0146, .255), (.0146, .29), (.0158, .293), (.0158, .3015), (0, .302)], foil, seg=32, parent=bl, loc=(0, 0, z0))
    lab = mat('BottleLabel', rough=.7, base_img=load('bottle_label.png'))
    lathe('Label', [(.0376, .11), (.0376, .19)], lab, seg=48, parent=bl, loc=(0, 0, z0), vrange=(.11, .19))
    # 天地盖：盖为深罩，四面裙边向下罩住盒身上部 LS，裙边内壁与盒身外壁留 0.8mm 间隙
    clr = .0008; LW, LD = W, D; LS = .12
    # 肩颈内衬：内颈从盒身内侧伸出，盖套在内颈上，闭合时盖外壁与盒身外壁齐平，仅留一道细缝
    Wc, Dc = W - 2*wall - 2*clr, D - 2*wall - 2*clr; z1, z2 = H - LS - .04, H - wall - .002
    boxes('Collar', [
        (0, -(Dc/2 - wall/2), (z1 + z2)/2, Wc, wall, z2 - z1), (0, (Dc/2 - wall/2), (z1 + z2)/2, Wc, wall, z2 - z1),
        (-(Wc/2 - wall/2), 0, (z1 + z2)/2, wall, Dc - 2*wall, z2 - z1), ((Wc/2 - wall/2), 0, (z1 + z2)/2, wall, Dc - 2*wall, z2 - z1),
    ], m_dark, base, uvs=2, bevel=0)
    lid = empty('Lid', (0, 0, H - LS + .0004), root)
    boxes('Lid_wrap', [
        (0, -(LD/2 - wall/2), (LS - wall)/2, LW, wall, LS - wall),
        (0, (LD/2 - wall/2), (LS - wall)/2, LW, wall, LS - wall),
        (-(LW/2 - wall/2), 0, (LS - wall)/2, wall, LD - 2*wall, LS - wall),
        ((LW/2 - wall/2), 0, (LS - wall)/2, wall, LD - 2*wall, LS - wall),
    ], m_dark, lid, uvs=2, bevel=0)
    boxes('Lid_top', [(0, 0, LS - wall/2, LW, LD, wall)], m_dark, lid, uvs=2, bevel=.002)
    boxes('Lid_lining', [(0, 0, LS - wall - .0002, LW - 2*wall, LD - 2*wall, .0004)], m_inner, lid, uvs=4)
    # 连续环绕金带（盖裙边下部，四面闭合）
    m_band = mat('GoldBand', col=(0.69, 0.40, 0.075), rough=.38, metal=1)
    bz, bh, bt = .022, .010, .0005
    boxes('Lid_band', [
        (0, -(LD/2 + bt/2), bz, LW + 2*bt, bt, bh), (0, (LD/2 + bt/2), bz, LW + 2*bt, bt, bh),
        (-(LW/2 + bt/2), 0, bz, bt, LD, bh), ((LW/2 + bt/2), 0, bz, bt, LD, bh),
    ], m_band, lid, uvs=1, bevel=0)
    m_gold2 = mat('GoldFoilLid', col=(0.69, 0.40, 0.075), rough=.28, metal=1, alpha_img=load('wine_lid_foil.png'))
    plane('LidFoil', (0, 0, LS + .0003), 'z', 1, LW*.8, LD*.8, m_gold2, lid)
    z0l = H - LS + .0004; up = z0l + LS + .03; side = (W/2 + LW/2 + .03)
    key_loc(lid, [0, 8, 14, 20, 24], [(0, 0, z0l), (0, 0, up), (side*.55, 0, up + .01), (side, 0, .06), (side, 0, 0)])
    key_loc(bl, [0, 20, 28], [(0, 0, 0), (0, 0, 0), (0, 0, .07)])  # 取盖后酒瓶随托抬起 7cm，瓶颈和瓶封露出
    export('wine-box.glb')

{'corrugated': build_corrugated, 'gift': build_gift, 'wine': build_wine}[WHICH]()
print('DONE', WHICH)
