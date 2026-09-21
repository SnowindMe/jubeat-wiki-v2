# 未来投票 API / Pages Functions 预留

本轮站点为纯静态 SSG，**此目录不含可执行 Functions，也没有密钥或部署逻辑**。

下一轮可在此放入 Cloudflare Pages Functions，并按 `docs/future-voting-api.md` 实现 `/api/difficulty/*`：服务端仅接受由 `data/difficulty-index.json` 导出的稳定 `difficultyKey`。静态页面必须保持在 API 不可用时可读。
