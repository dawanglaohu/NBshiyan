import cv2,json,numpy as np
from pathlib import Path
from PIL import Image
BASE=Path(__file__).resolve().parent
ROOT=BASE.parents[3]
refs_quads=np.float32([[[238,543],[979,742],[862,816],[133,607]],[[1213,165],[1700,277],[1608,333],[1122,217]],[[1196,756],[1972,998],[1832,1088],[1071,819]]])
logo=np.array(Image.open(ROOT/'docs/brand-media/static/evidence/exact-logo-reference.png').convert('RGBA'))
logo=logo[:,:,[2,1,0,3]]
canvas=np.zeros((200,1100,4),np.uint8)
w=640;h=round(w*logo.shape[0]/logo.shape[1]);small=cv2.resize(logo,(w,h),interpolation=cv2.INTER_AREA);canvas[8:8+h,230:230+w]=small
canvas=cv2.GaussianBlur(canvas,(0,0),.65)
source_rect=np.float32([[0,0],[1100,0],[1100,200],[0,200]])
anchors=json.loads((BASE/'late-anchors.json').read_text(encoding='utf-8'))['keyframes']

def red_mask(f):
 b,g,r=[f[:,:,k].astype(np.float32) for k in range(3)]
 return ((r>g*1.2)&(r>b*1.15)&(r-g>18)&(r>75)&(b>g*.6)).astype(np.uint8)*255

def machine_mask(f,index):
 keys=sorted(map(int,anchors));low=max([k for k in keys if k<=index],default=keys[0]);hi=min([k for k in keys if k>=index],default=keys[-1]);t=0 if low==hi else (index-low)/(hi-low)
 a,b=anchors[str(low)],anchors[str(hi)]
 m=np.zeros(f.shape[:2],np.uint8)
 for key in ['clamp','posts']:
  aa=[a[key]] if key=='clamp' else a[key];bb=[b[key]] if key=='clamp' else b[key]
  for left,right in zip(aa,bb):
   if len(left)!=len(right):right=(np.array(left)+np.mean(np.array(right),axis=0)-np.mean(np.array(left),axis=0)).tolist()
   q=np.float32(left)*(1-t)+np.float32(right)*t
   cv2.fillPoly(m,[q.astype(np.int32)],255)
 hsv=cv2.cvtColor(f,cv2.COLOR_BGR2HSV)
 neutral=((hsv[:,:,1]<68)|(hsv[:,:,2]<88)).astype(np.uint8)*255
 return cv2.dilate(m,np.ones((3,3),np.uint8))

def compose(f,index,rows):
 out=f.copy();red=red_mask(f);protect=machine_mask(f,index)
 b,g,r=[f[:,:,k].astype(np.float32) for k in range(3)]
 paper=((r-b>18)&(g-b>6)&(g>r*.77)&(r>95))|(red>0)
 skin=(r>g*1.24)&(g>b*1.24)&(r>80)
 hand=skin & (r<125)
 hand[225:]=False
 hand[:,:1000]=False
 visible=((protect==0)&~hand).astype(np.float32)
 debug=[]
 for row in rows:
  q=np.float32(row['quad'])
  # Expand the clean region around the original brand; the new wordmark uses the checked strip itself.
  mid=(q[0]+q[1]+q[2]+q[3])/4
  u=(q[1]-q[0]+q[2]-q[3])/4;v=(q[3]-q[0]+q[2]-q[1])/4
  horizontal=1.45 if np.mean(q,axis=0)[0]>1000 and np.mean(q,axis=0)[1]>800 else 1.06
  center=mid+v*.75
  cleanq=np.float32([center-u*horizontal-v*1.9,center+u*horizontal-v*1.9,center+u*horizontal+v*1.9,center-u*horizontal+v*1.9])
  m=np.zeros(f.shape[:2],np.uint8);cv2.fillConvexPoly(m,cleanq.astype(int),255)
  old=cv2.bitwise_and(m,red);old=cv2.dilate(old,np.ones((5,5),np.uint8));old[(protect>0)|hand]=0
  ys,xs=np.where(old>0)
  if len(xs):
   x0=max(int(xs.min())-10,0);x1=min(int(xs.max())+11,1920);y0=max(int(ys.min())-10,0);y1=min(int(ys.max())+11,1080)
   patch=cv2.inpaint(out[y0:y1,x0:x1],old[y0:y1,x0:x1],4,cv2.INPAINT_TELEA)
   out[y0:y1,x0:x1]=patch
  H=cv2.getPerspectiveTransform(source_rect,q)
  layer=cv2.warpPerspective(canvas,H,(1920,1080),flags=cv2.INTER_LINEAR)
  layer=cv2.GaussianBlur(layer,(0,0),1.0 if np.linalg.norm(q[1]-q[0])>600 else 1.5)
  alpha=layer[:,:,3].astype(np.float32)/255*visible*.94
  out=np.uint8(out.astype(np.float32)*(1-alpha[:,:,None])+layer[:,:,:3].astype(np.float32)*alpha[:,:,None])
  debug.append({'quad':q.tolist(),'clearedRedPixels':int(len(xs))})
 out[protect>0]=f[protect>0]
 out[hand]=f[hand]
 return out,debug
