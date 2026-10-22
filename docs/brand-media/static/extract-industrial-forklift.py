"""Extract the forklift group for the fixed 1737x905 industrial-city v3 illustration."""
import cv2
import numpy as np

POLYGON = np.array([
    (1331,773),(1341,766),(1341,725),(1366,718),(1386,722),(1392,734),
    (1390,692),(1387,687),(1388,682),(1418,677),(1457,682),(1459,720),
    (1478,723),(1481,753),(1472,769),(1458,775),(1446,772),(1435,776),
    (1426,783),(1411,785),(1401,779),(1384,782),(1358,781)
],np.int32)


def extract_forklift(rgb):
    """Return clean scene, full-size RGBA group, and source-space motion metadata.

    The driver, forks, payload and wheels are one group. The replacement floor
    is reconstructed only beneath the removed group; fixed foreground cargo is
    protected. This deterministic clean plate is an animation aid, not a claim
    to recover scene pixels that the forklift originally occluded.
    """
    if rgb.shape != (905,1737,3):
        raise ValueError('Recalibrate this mask for any image other than industrial-city v3')
    h,w=rgb.shape[:2]
    region=np.zeros((h,w),np.uint8);cv2.fillPoly(region,[POLYGON],255)
    segmentation=np.full((h,w),cv2.GC_BGD,np.uint8)
    segmentation[cv2.dilate(region,np.ones((7,7),np.uint8))>0]=cv2.GC_PR_BGD
    segmentation[region>0]=cv2.GC_PR_FGD
    for x0,y0,x1,y1 in [(1349,731,1380,759),(1394,690,1401,757),
                          (1415,682,1448,686),(1433,699,1449,744),
                          (1421,740,1464,754),(1411,759,1425,773),
                          (1459,745,1467,760)]:
        segmentation[y0:y1,x0:x1]=cv2.GC_FGD
    cv2.setRNGSeed(45291)
    cv2.grabCut(cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR),segmentation,None,
                np.zeros((1,65),np.float64),np.zeros((1,65),np.float64),5,cv2.GC_INIT_WITH_MASK)
    subject=((segmentation==cv2.GC_FGD)|(segmentation==cv2.GC_PR_FGD)).astype(np.uint8)
    subject*=region>0
    subject=cv2.morphologyEx(subject,cv2.MORPH_CLOSE,np.ones((2,2),np.uint8))
    # Enforce the metal roof silhouette: nearby warehouse/carton pixels do not move.
    roof_cap=np.zeros((h,w),np.uint8)
    cv2.fillPoly(roof_cap,[np.array([(1383,676),(1418,672),(1463,676),(1463,691),
                                     (1457,682),(1418,677),(1388,682),(1387,687)],np.int32)],255)
    subject[roof_cap>0]=0
    alpha=cv2.GaussianBlur(subject.astype(np.float32),(3,3),.42)
    sprite=np.dstack([rgb,(alpha*255).astype(np.uint8)])
    erase=cv2.dilate(region,np.ones((7,7),np.uint8))
    shadow=np.zeros((h,w),np.uint8)
    cv2.fillPoly(shadow,[np.array([(1340,775),(1410,770),(1473,754),(1510,765),
                                   (1507,783),(1464,792),(1410,791),(1398,786),
                                   (1370,781)],np.int32)],255)
    keep=np.zeros((h,w),np.uint8)
    cv2.fillPoly(keep,[np.array([(1292,783),(1336,774),(1395,784),(1395,822),
                                  (1346,838),(1290,820)],np.int32)],255)
    shadow[keep>0]=0
    erase=np.maximum(erase,shadow)
    # Start with local inpainting, then continue the facade vertically and the
    # bare concrete by same-depth row sampling. No red or black vehicle pixels
    # remain as a stationary second forklift or cast shadow.
    clean=cv2.inpaint(rgb,erase,5,cv2.INPAINT_NS).astype(np.float32)
    replacement=clean.copy()
    profile=np.median(rgb[659:672,1320:1520].astype(np.float32),axis=0)
    for y in range(671,722):
        replacement[y,1320:1520]=profile
    # Sample actual bare concrete on both sides. Rectangles containing crates,
    # pallets, trees and the old forklift/cast shadow are deliberately excluded.
    samples=np.zeros((h,w),np.uint8)
    floor_sample_polys=[[(1270,735),(1331,738),(1328,768),(1283,770),(1271,758)],
                        [(1482,746),(1514,748),(1509,756),(1501,758),(1496,774),(1483,774)],
                        [(1397,790),(1423,791),(1422,801),(1396,800)]]
    for polygon in floor_sample_polys:
        cv2.fillPoly(samples,[np.array(polygon,np.int32)],255)
    channels=rgb.astype(np.int16)
    samples[(channels[...,0]-channels[...,1]>34)|
            (channels[...,1]-channels[...,2]>29)|(channels.mean(axis=2)<185)]=0
    samples[erase>0]=0
    weight=samples.astype(np.float32)/255
    numerator=cv2.GaussianBlur(rgb.astype(np.float32)*weight[...,None],(0,0),42)
    denominator=cv2.GaussianBlur(weight,(0,0),42)
    floor=numerator/np.maximum(denominator[...,None],1e-6)
    # Reuse residual texture from bare same-plane concrete, rather than a flat
    # painted polygon. This low-amplitude residual does not move or flicker.
    donor=rgb[742:771,1280:1325].astype(np.float32)
    detail=donor-cv2.GaussianBlur(donor,(0,0),3)
    tile=cv2.resize(detail,(224,116),interpolation=cv2.INTER_LINEAR)
    y0,y1,x0,x1=680,812,1320,1525
    tile=cv2.resize(tile,(x1-x0,y1-y0),interpolation=cv2.INTER_LINEAR)
    floor[y0:y1,x0:x1]+=np.clip(tile,-3.5,3.5)*.55
    yy,xx=np.mgrid[0:h,0:w].astype(np.float32)
    wall_base=717-.08*(xx-1400)
    floor_mix=np.clip((yy-wall_base+3)/8,0,1)
    local=erase.astype(np.float32)/255
    patch_mix=cv2.GaussianBlur(local,(7,7),1.1)[...,None]
    replacement=replacement*(1-floor_mix[...,None])+floor*floor_mix[...,None]
    clean=rgb.astype(np.float32)*(1-patch_mix)+replacement*patch_mix
    clean=np.clip(clean,0,255).astype(np.uint8)
    # Move the actual ground cast shadow with the same group, leaving none at
    # the original parking position. Foreground pallet pixels stay protected.
    local_shadow=cv2.GaussianBlur(shadow.astype(np.float32)/255,(5,5),.8)
    floor_luma=np.maximum(clean.astype(np.float32).mean(axis=2),1)
    source_luma=rgb.astype(np.float32).mean(axis=2)
    shadow_alpha=np.clip((floor_luma-source_luma)/floor_luma*.7,0,.3)*local_shadow*(1-alpha)
    combined=alpha+shadow_alpha
    colour=(rgb.astype(np.float32)*alpha[...,None]+np.array([40,35,30],np.float32)*shadow_alpha[...,None])/np.maximum(combined[...,None],1e-6)
    colour[combined==0]=rgb[combined==0]
    sprite=np.dstack([np.clip(colour,0,255).astype(np.uint8),(combined*255).astype(np.uint8)])
    metadata={'polygon':POLYGON.tolist(),'groupBbox':[1331,677,1481,785], 'groundShadowBbox':[1340,754,1510,792], 'foregroundOccluderPolygon':[(1292,783),(1336,774),(1395,784),(1395,822),(1346,838),(1290,820)],
              'translationRangeSourcePixels':[[-70,0],[0,0]],
              'recommendedTranslationSourcePixels':[-64,0], 'floorReconstruction':'Normalized sampling of explicitly selected bare-concrete polygons plus static source texture; no carton colours used', 'floorSamplePolygons':floor_sample_polys,
              'pathNote':'Leftward 64px remains just ahead of parked trailer and above foreground pallet. Positive downshift10px risks overlapping foreground cargo; use occluder restoration if chosen.',
              'caveat':'Occluded factory/floor reconstructed; inspect original parking position at farthest travel before accepting.'}
    return clean,sprite,metadata
