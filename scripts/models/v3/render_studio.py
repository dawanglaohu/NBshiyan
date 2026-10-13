# blender -b --python render.py -- <glb> <outprefix> <angles: e.g. 35,-35,145> [frames 0,24]
import bpy, sys, math
from mathutils import Vector
a = sys.argv[sys.argv.index('--')+1:]
glb, outp = a[0], a[1]; angles = [float(x) for x in (a[2] if len(a) > 2 else '35').split(',')]
frames = [int(x) for x in (a[3] if len(a) > 3 else '0,24').split(',')]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=glb)
# 所有动画动作播放到场景
sc.frame_start = 0; sc.frame_end = 30
sc.render.engine = 'CYCLES'; sc.cycles.samples = int(__import__('os').environ.get('SAMPLES', 96)); sc.cycles.use_denoising = True; sc.cycles.device = 'CPU'
RES = int(__import__('os').environ.get('RES', 900)); sc.render.resolution_x = RES; sc.render.resolution_y = RES; sc.render.film_transparent = True
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
# world HDRI
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True; nt = w.node_tree
env = nt.nodes.new('ShaderNodeTexEnvironment'); env.image = bpy.data.images.load('/workspace/nb3d-v3/hdri/studio_small_09_1k.hdr')
nt.links.new(env.outputs['Color'], nt.nodes['Background'].inputs['Color']); nt.nodes['Background'].inputs['Strength'].default_value = .7
def bbox_all():
    mn = Vector((1e9,)*3); mx = Vector((-1e9,)*3)
    for o in sc.objects:
        if o.type != 'MESH': continue
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c); mn = Vector(map(min, mn, p)); mx = Vector(map(max, mx, p))
    return mn, mx
boxes = []
for f in frames: sc.frame_set(f); boxes.append(bbox_all())
mn = Vector([min(c) for c in zip(*[b[0] for b in boxes])]); mx = Vector([max(c) for c in zip(*[b[1] for b in boxes])])
ctr = (mn + mx)/2; size = (mx - mn).length
# shadow catcher floor
bpy.ops.mesh.primitive_plane_add(size=size*20, location=(ctr.x, ctr.y, mn.z)); fl = bpy.context.object; fl.is_shadow_catcher = True
# 3-point lights (relative to size)
def area(name, loc, energy, s, col=(1,1,1)):
    l = bpy.data.lights.new(name, 'AREA'); l.energy = energy*size*size*40; l.size = s*size; l.color = col
    o = bpy.data.objects.new(name, l); sc.collection.objects.link(o); o.location = ctr + Vector(loc)*size
    d = ctr - o.location; o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
area('Key', (-1.2, -1.6, 1.6), 9, .8, (1, .97, .92)); area('Fill', (1.8, -1.0, .6), 3, 1.2, (.92, .96, 1)); area('Rim', (.4, 2.0, 1.4), 7, .5)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam; cam.data.lens = 60
import os
CAMDIR = os.environ.get('CAMDIR')
if CAMDIR: cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(float(os.environ.get('FOV', 40)))
for ang in angles:
    r = size*1.9; t = math.radians(ang - 90)
    cam.location = ctr + Vector((r*math.cos(t), r*math.sin(t), r*.55))
    if CAMDIR:  # 与网站 3D 卡片默认相机同方向（three [2.4,1.6,2.6] → Blender (2.4,-2.6,1.6)），按包围球 margin 1.2 取景
        d = Vector([float(x) for x in CAMDIR.split(',')]).normalized()
        rad = size/2*float(os.environ.get('MARGIN', 1.2)); dist = rad/math.sin(cam.data.angle_y/2)
        cam.location = ctr + d*dist
    cam.rotation_euler = (ctr - cam.location).to_track_quat('-Z', 'Y').to_euler()
    for f in frames:
        sc.frame_set(f); sc.render.filepath = f'{outp}_a{int(ang)}_f{f}.png'; bpy.ops.render.render(write_still=True)
print('RENDERED')
