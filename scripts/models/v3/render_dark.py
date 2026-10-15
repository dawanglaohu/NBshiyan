# #252 深色海报（premium 区块 #121214）：blender -b --python render_dark.py -- <glb> <out.png> [angle]
# 柔和轮廓光（左右后方）让黑色盒体与深色背景分离；HDRI 压低避免白边/光晕；阴影捕捉器只留淡阴影
import bpy, sys, math, os
from mathutils import Vector
a = sys.argv[sys.argv.index('--')+1:]; glb, outp = a[0], a[1]; ang = float(a[2]) if len(a) > 2 else 35
bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=glb); sc.frame_set(0)
sc.render.engine = 'CYCLES'; sc.cycles.samples = int(os.environ.get('SAMPLES', 128)); sc.cycles.use_denoising = True; sc.cycles.device = 'CPU'
sc.render.resolution_x = sc.render.resolution_y = int(os.environ.get('RES', 1000)); sc.render.film_transparent = True
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True; nt = w.node_tree
env = nt.nodes.new('ShaderNodeTexEnvironment'); env.image = bpy.data.images.load('/workspace/nb3d-v3/hdri/studio_small_09_1k.hdr')
nt.links.new(env.outputs['Color'], nt.nodes['Background'].inputs['Color']); nt.nodes['Background'].inputs['Strength'].default_value = .12
mn = Vector((1e9,)*3); mx = Vector((-1e9,)*3)
for o in sc.objects:
    if o.type == 'MESH':
        for c in o.bound_box: p = o.matrix_world @ Vector(c); mn = Vector(map(min, mn, p)); mx = Vector(map(max, mx, p))
ctr = (mn + mx)/2; size = (mx - mn).length
bpy.ops.mesh.primitive_plane_add(size=size*20, location=(ctr.x, ctr.y, mn.z)); bpy.context.object.is_shadow_catcher = True
def area(name, loc, energy, s, col=(1, 1, 1)):
    l = bpy.data.lights.new(name, 'AREA'); l.energy = energy*size*size*40; l.size = s*size; l.color = col
    o = bpy.data.objects.new(name, l); sc.collection.objects.link(o); o.location = ctr + Vector(loc)*size
    o.rotation_euler = (ctr - o.location).to_track_quat('-Z', 'Y').to_euler()
t = math.radians(ang - 90); cd = Vector((math.cos(t), math.sin(t), 0))  # 相机水平方向
side = Vector((-cd.y, cd.x, 0))
area('Key', tuple(cd*1.4 + side*1.2 + Vector((0, 0, 1.8))), 1.6, 1.4, (1, .97, .92))          # 大面积柔光主光（偏上）
area('RimL', tuple(-cd*1.6 + side*1.3 + Vector((0, 0, .9))), 7, .9, (1, .93, .82))         # 暖色轮廓光
area('RimR', tuple(-cd*1.6 - side*1.3 + Vector((0, 0, .9))), 6, .9, (.9, .93, 1))
area('Top', (0, 0, 2.2), .4, 1.6)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam; cam.data.lens = 60
r = size*1.9; cam.location = ctr + Vector((r*math.cos(t), r*math.sin(t), r*.55)); cam.rotation_euler = (ctr - cam.location).to_track_quat('-Z', 'Y').to_euler()
sc.render.filepath = outp; bpy.ops.render.render(write_still=True); print('RENDERED')
