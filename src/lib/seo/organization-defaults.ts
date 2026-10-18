// Organization JSON-LD 的默认值（唯一出处）。后台对应字段为空时才使用；后台填了就以后台为准。
// 不放在 server 目录，后端的 getOrganizationSettings 也可以直接 import 这里。
// 只有这两个字段有默认值；legalName / email / telephone / address / foundingDate 没填就不输出。
// 不写任何数字：产能、面积、人数、认证、交期一律不出现在默认值里。
export const ORGANIZATION_DEFAULTS = {
  alternateName: '保乐优',
  description:
    'PackJoyU is a custom packaging manufacturer with its own factory, making printed corrugated and gift boxes, molded pulp and paper cups, from sample to bulk.'
} as const;
