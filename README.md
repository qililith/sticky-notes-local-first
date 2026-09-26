# Sticky Notes — local-first

一款以本地保存为优先的便签应用，支持富文本编辑、离线使用，以及可选的 Supabase 账号同步。

## 本地运行

需要 Node.js 与 pnpm：

```sh
pnpm install
pnpm dev
```

不配置云端服务时，可在本地体验应用；要使用账号同步，请复制 `.env.example` 为 `.env.local`，填写自己的 Supabase 项目 URL 和 publishable key，再按 `supabase/migrations` 中的迁移文件初始化数据库。不要把 service-role 密钥放进前端环境变量。

构建和测试：

```sh
pnpm build
pnpm test
pnpm test:e2e
```

## 数据说明

便签首先保存在当前浏览器的本地数据库。清除浏览器数据、卸载浏览器或更换设备可能影响本地内容；重要内容请定期导出备份。登录同步依赖你自己的 Supabase 配置。

`VITE_DEMO_MODE` 仅用于本地演示，不要在生产部署中启用。

## 许可证

本项目采用 Apache License 2.0，见 [LICENSE](LICENSE)。
