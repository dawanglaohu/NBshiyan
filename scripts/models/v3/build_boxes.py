# Blender 4.2 headless: blender -b --python build.py -- <which> <outdir>
import bpy, bmesh, math, sys, os
import numpy as np
from mathutils import Vector, Matrix
argv = sys.argv[sys.argv.index('--')+1:]
WHICH, OUT = argv[0], argv[1]
TEX = os.environ.get('TEX_DIR', 'tex/')
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
    h = fbm(n, 6, 5)*.6 + fibers(n, 2500, 14)*fib
    c = np.array(col)[None, None, :]*(1 - var*.5 + var*(h[..., None]))
    r = np.clip(rough[0] + (h - .5)*rough[1], 0, 1)
    orm = np.stack([np.ones_like(r), r, np.zeros_like(r)], -1)
    return img(name+'_col', np.clip(c, 0, 1)), img(name+'_nrm', normal_from_h(h, nstr)), img(name+'_orm', orm)

def load(f):
    im = bpy.data.images.load(TEX + f); return im

# ---------- materials ----------
def mat(name, col=None, rough=.6, metal=0., texset=None, uvscale=1., alpha_img=None, base_img=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if col: b.inputs['Base Color'].default_value = (*col, 1)
    if texset:
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
        md = o.modifiers.new('bev', 'BEVEL'); md.width = bevel; md.segments = 2; md.limit_method = 'ANGLE'
        o.modifiers.new('wn', 'WEIGHTED_NORMAL')
    return o
def plane(name, center, normal_axis, sign, w, h, m, parent=None):
    # textured decal plane: u along w, v along h, uv 0..1
    cx, cy, cz = center
    if normal_axis == 'y':
        d = [(cx + sign*w/2, cy, cz - h/2), (cx - sign*w/2, cy, cz - h/2), (cx - sign*w/2, cy, cz + h/2), (cx + sign*w/2, cy, cz + h/2)]
    elif normal_axis == 'x':
        d = [(cx, cy + sign*w/2, cz - h/2), (cx, cy - sign*w/2, cz - h/2), (cx, cy - sign*w/2, cz + h/2), (cx, cy + sign*w/2, cz + h/2)]
        d = [(cx, cy - sign*w/2 * -1, z) if False else p for p, z in zip(d, [0]*4)]
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
    wall('WallRight', (W/2 - t/2, -D/2, 0), (math.radians(90), 0, math.radians(90)), D, H)
    wall('WallLeft', (-W/2 + t/2, D/2, 0), (math.radians(90), 0, math.radians(-90)), D, H)
    # bottom (closed flaps, simplified as a panel)
    b = empty('Bottom', (-W/2, -D/2, t/2), root); corr_panel('Bottom', W, D, m_in, m_in, m_fl, b, flutes=False)
    # top flaps: hinge at top edge of each wall; flap local: x along hinge, y away from hinge, z normal (up when closed)
    flaps = []
    def flap(name, hinge, rotz, w, L, zoff):
        e = empty(name, hinge, root); e.rotation_euler = (0, 0, rotz)
        corr_panel(name, w, L, m_out, m_flap_k, m_flap_k, e, origin=(-w/2, 0, zoff))
        return e
    # minor flaps (left/right) underneath, major flaps (front/back) on top, meeting in middle
    fL = flap('FlapLeft', (-W/2 + t/2, 0, H), math.radians(-90), D - .004, W/2*0 + D/2 - .002, -t)  # minor flap depth = D/2
    fR = flap('FlapRight', (W/2 - t/2, 0, H), math.radians(90), D - .004, D/2 - .002, -t)
    fF = flap('FlapFront', (0, -D/2 + t/2, H), 0, W, D/2 - .001, 0)
    fB = flap('FlapBack', (0, D/2 - t/2, H), math.radians(180), W, D/2 - .001, 0)
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
    plane('Label', (W*.22, -D/2 - .0006, H*.28), 'y', -1, .12, .09, m_label, root)
    export('corrugated-box.glb')

def rigid_tray(name, W, D, H, wall, m_outer, m_inner, parent, bevel=.0015, top_down=False):
    # open-top tray (or open-bottom lid when top_down); outer wrap + inner paper as separate objects
    s = -1 if top_down else 1
    z0 = 0
    outer = boxes(name+'_wrap', [
        (0, 0, s*wall/2, W, D, wall),
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
    dark = paper_set('darkpaper', (0.035, 0.035, 0.04), .4, fib=.25, nstr=.2, rough=(.6, .08))
    m_dark = mat('DarkTexturedPaper', texset=dark)
    m_inner = mat('InnerPaper', col=(0.02, 0.02, 0.022), rough=.95)
    velvet = paper_set('velvet', (0.07, 0.065, 0.07), .4, fib=0, nstr=1.0, rough=(.95, .05))
    m_vel = mat('BlackVelvetInsert', texset=velvet)
    m_gold = mat('GoldFoil', col=(0.95, 0.76, 0.40), rough=.3, metal=1, alpha_img=load('gift_foil.png'))
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
    # lid (天地盖): origin at top surface, walls hang down
    lid = empty('Lid', (0, 0, H + wall + .0005), root)
    rigid_tray('Lid', LW, LW, LH, wall, m_dark, m_inner, lid, top_down=False)
    # flip: lid tray built open-top; mirror so it's open-bottom
    for c in lid.children: c.scale.z = -1; c.location.z = wall
    plane('LidFoil', (0, 0, wall + .0003), 'z', 1, LW*.92, LW*.92, m_gold, lid)
    # ribbon band around lid + flat bow at corner
    rw = .018
    boxes('Ribbon', [(LW*.32, 0, wall + .0006, rw, LW + .002, .0008), (LW*.32, -LW/2 - .0005, wall - LH/2, rw, .0008, LH), (LW*.32, LW/2 + .0005, wall - LH/2, rw, .0008, LH)], m_satin, lid)
    # bow: two flattened loops made from lathe torus-ish
    for sgn in (-1, 1):
        prof = [(.012 + .006*math.cos(a), .003*math.sin(a)) for a in np.linspace(0, 2*math.pi, 10)]
        o = lathe('BowLoop', prof, m_satin, seg=24, parent=lid, loc=(0, 0, 0))
        o.scale = (1.5, .55, 1); o.location = (LW*.32, sgn*.022, wall + .004); o.rotation_euler = (sgn*math.radians(12), 0, math.radians(90))
    boxes('BowKnot', [(LW*.32, 0, wall + .004, .02, .012, .007)], m_satin, lid, bevel=.002)
    # animation: lift, tilt, set aside
    fr = [0, 6, 12, 18, 24]
    top = H + wall + .0005
    locs = [(0, 0, top), (0, 0, top + .03), (0, 0, top + .09), (.10, .07, top + .08), (.25, .10, LH - top*0 + .0)]
    locs[-1] = (.20, .14, LH)  # resting beside base, top face up
    key_loc(lid, fr, locs); key_rot(lid, fr, 'x', [0, 0, -6, -10, 0])
    export('gift-box.glb')

def build_wine():
    reset()
    W, D, H, wall = .115, .115, .36, .0025
    BH = .29; LH = H - BH  # base height; lid = top cap + back + front flap
    dark = paper_set('winepaper', (0.03, 0.028, 0.03), .4, fib=.3, nstr=.2, rough=(.56, .08))
    m_dark = mat('DarkTexturedPaper', texset=dark)
    m_inner = mat('InnerPaper', col=(0.025, 0.02, 0.02), rough=.95)
    m_gold = mat('GoldFoil', col=(0.95, 0.76, 0.40), rough=.3, metal=1, alpha_img=load('wine_foil.png'))
    satin = paper_set('cream', (0.92, 0.87, 0.78), .1, fib=.1, nstr=1.0, rough=(.6, .05))
    m_satin = mat('CreamSatinInsert', texset=satin)
    root = empty('WineBox', (0, 0, 0))
    base = empty('Base', (0, 0, 0), root)
    rigid_tray('Base', W, D, BH, wall, m_dark, m_inner, base)
    # bottle insert: card board block with round cradle + neck support
    ins = boxes('Insert', [(0, 0, wall + .04, W - 2*wall - .001, D - 2*wall - .001, .08)], m_satin, base, uvs=8)
    cyl = lathe('cutter', [(0, 0), (.0385, 0), (.0385, .2), (0, .2)], m_satin, seg=48, loc=(0, 0, wall + .02))
    bo = ins.modifiers.new('cav', 'BOOLEAN'); bo.object = cyl; bo.operation = 'DIFFERENCE'; bo.solver = 'EXACT'
    bpy.context.view_layer.objects.active = ins; ins.select_set(True); bpy.ops.object.modifier_apply(modifier='cav'); bpy.data.objects.remove(cyl)
    # bottle (750ml Bordeaux, ~300mm tall, 75mm dia) standing in cradle
    z0 = wall + .02
    glass = mat('BottleGlass', col=(0.02, 0.07, 0.035), rough=.07)
    prof = [(0, 0), (.035, 0), (.0372, .006), (.0372, .205), (.034, .225), (.022, .245), (.0145, .265), (.0142, .29), (.0155, .293), (.0155, .30), (0, .301)]
    lathe('Bottle', prof, glass, seg=48, parent=base, loc=(0, 0, z0))
    foil = mat('Capsule', col=(0.45, 0.06, 0.1), rough=.35, metal=.7)
    lathe('Capsule', [(.0146, .255), (.0146, .29), (.0158, .293), (.0158, .3015), (0, .302)], foil, seg=32, parent=base, loc=(0, 0, z0))
    lab = mat('BottleLabel', rough=.7, base_img=load('bottle_label.png'))
    lathe('Label', [(.0376, .11), (.0376, .19)], lab, seg=48, parent=base, loc=(0, 0, z0), vrange=(.11, .19))
    # front foil on base front
    plane('BaseFoil', (0, -D/2 - .0003, BH/2), 'y', -1, W*.9, BH*.95, m_gold, base)
    # lid: hinge at back-top edge of base; lid closed = cap covering top LH + front flap overlapping base front by 60mm
    lid = empty('Lid', (0, D/2 + wall, BH), root)
    lw = W + 2*wall + .001; ld = D + 2*wall + .001
    boxes('Lid_wrap', [
        (0, -ld/2, LH - wall/2, lw, ld, wall),                       # top
        (0, -wall/2, LH/2, lw, wall, LH),                             # back
        (-lw/2 + wall/2, -ld/2, LH/2, wall, ld, LH), (lw/2 - wall/2, -ld/2, LH/2, wall, ld, LH),  # sides
        (0, -ld + wall/2, (LH - .06)/2, lw, wall, LH + .06),          # front flap extends 60mm down
    ], m_dark, lid, uvs=2, bevel=.0012)
    m_gold2 = mat('GoldFoilLid', col=(0.95, 0.76, 0.40), rough=.3, metal=1, alpha_img=load('wine_lid_foil.png'))
    plane('LidFoil', (0, -ld - .0003, (LH - .06)/2), 'y', -1, LH + .05, LH + .05, m_gold2, lid)
    fr = [0, 6, 12, 18, 24]
    lid.rotation_mode = 'XYZ'
    for f, k in zip(fr, ease(5, 1)): lid.rotation_euler = (math.radians(-115*k), 0, 0); lid.keyframe_insert('rotation_euler', frame=f)
    export('wine-box.glb')

{'corrugated': build_corrugated, 'gift': build_gift, 'wine': build_wine}[WHICH]()
print('DONE', WHICH)
