# Sanity 导入（Refs #99）

`import.ndjson` 里有 14 个文档，结构按 `sanity/schemas/index.ts`（main 上的版本；#199 没有改 schema）：

| 来源 | Sanity `_type` | `_id` | 数量 |
|---|---|---|---|
| 12 个品类落地页（#188 的 `docs/content/<en-slug>.md`） | `product` | `product-<内部 key>` | 12 |
| 英俄文章（#196 英文版 + 本 PR 的俄语版） | `article` | `article-<英文 slug>` | 2 |

## 字段怎么对应
- schema 是一个文档里同时放两种语言：`title`、`excerpt`、`body`、`seo.title`、`seo.description` 都是 `{ en, ru }`，`slug` 是 `{ en: {current}, ru: {current} }`。俄语文章不单独建文档，和英文版合成一个文档，两种语言的 slug 分开填。
- 落地页：`title` 用 H1，`excerpt` 用导语段，`body` 是卖点、规格（表格转成列表）和流程，`seo` 来自 `categoryMeta.ts`，`category` 填内部 key（例如 `color-boxes`）。
- **FAQ 草稿没有导入**，等 Ryan 定稿后再加，到时 FAQPage JSON-LD 也一起打开（#192）。
- 正文是 Portable Text：normal、h2、h3、列表、strong，加上 `link` 标记（`markDefs: [{_type:'link', href}]`）。href 只会是 `/en/…` 或 `/ru/…` 的相对路径，其他链接一律转成纯文本。渲染链接要等全栈在 #91 之后给渲染器加上支持；在那之前链接文字会照常显示，只是不能点。
- 落地页正文末尾会根据 `../internal-links.json` 自动加上"相关产品"和"延伸阅读"两节，内链地图见 `../internal-links.md`，由 `linkmap.py` 生成。
- `seo.noindex` 全部设为 `true`：内容里还有 TBD，俄语也没校对。Ryan 确认后逐个改成 false。
- 行业方案页（`solution` 类型）还没写正文，只有 `industries.md` 里的关键词，所以没有导入。

## 导入步骤（需要 Ryan 登录 Sanity，在私聊里做）
1. #188 和 #196 合并后，重新生成：`python3 docs/content/sanity-import/linkmap.py && python3 docs/content/sanity-import/build.py`（默认读 `docs/content/`）。
2. 检查 JSON：`python3 -c "import json;[json.loads(l) for l in open('docs/content/sanity-import/import.ndjson')]"`
3. 先导入测试数据集：`npx sanity dataset import docs/content/sanity-import/import.ndjson staging --replace`（`--replace` 按 `_id` 覆盖，可以重复导）。
4. 在 Studio 里检查几篇，然后导入 `production`。导入会触发 `/api/sanity/revalidate`。
