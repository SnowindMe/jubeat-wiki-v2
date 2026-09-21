# 下一轮投票 API 预留

当前构建不部署 Functions、不读取环境变量且不保存任何密钥。Cloudflare Pages 可从 `functions/` 承载未来同源 API。

- `GET /api/difficulty/boards?board=hardest&limit=100`
- `GET /api/difficulty/:difficultyKey`
- `POST /api/difficulty/:difficultyKey/vote`

`difficultyKey` 的允许集合严格来自构建产物 `data/difficulty-index.json`，形式为 `<songId>:<diff>[:alt2]`。投票后端、D1、KV、匿名哈希与限流均属于下一轮，静态资料页不能依赖它们。
