const FIELD = 'input, textarea, select';

/** 错误条前面的输入框。整张表或一节里有多个框时，取文档顺序上的第一个。 */
function precedingField(err: Element): HTMLElement | null {
  let node: Element | null = err;
  while (node) {
    let prev = node.previousElementSibling;
    while (prev) {
      if (prev.matches(FIELD)) return prev as HTMLElement;
      const found = prev.querySelector(FIELD);
      if (found) return found as HTMLElement;
      prev = prev.previousElementSibling;
    }
    const parent: Element | null = node.parentElement;
    if (!parent || parent.matches('form')) break;
    node = parent;
  }
  return null;
}

/** 字段错误已经画进 DOM 之后：滚到第一个出错输入框或第一条 `.spec-err`，再聚焦，不再滚一次。 */
export function revealFirstSpecError(root: ParentNode | null): void {
  const err = root?.querySelector<HTMLElement>('.spec-err') ?? null;
  if (!err) return;
  const target = precedingField(err) ?? err;
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
}
