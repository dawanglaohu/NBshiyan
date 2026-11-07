/** 负控 1：旧的空节点短路实现。真实场景组件不会被打进/挂载，模型链路必须因此不可达。 */
export default function dynamic() {
  return function Empty(): null {
    return null;
  };
}
