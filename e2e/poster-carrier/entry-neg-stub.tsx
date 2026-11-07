import { mountCarrier } from './app';

// 负控 1：dynamic 边界换回空节点替身；正控必须因此拿不到 ready/GLB/canvas。
mountCarrier({ purePosterHasModel: false });
