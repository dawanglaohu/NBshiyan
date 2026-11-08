import { mountCarrier } from './app';

// 负控 2：给「纯 poster」夹具塞真实 GLB；同一套 pure-poster 断言必须因此失败。
mountCarrier({ purePosterHasModel: true });
