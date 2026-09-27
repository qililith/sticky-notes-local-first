# Sticky Notes — local-first

一款优先在本机保存的个人便签应用：轻量排版、离线读写、文件夹、搜索、回收站、历史版本、JSON 备份，以及 Supabase 账号同步。

当前为开发测试版，尚未完成实体双设备和目标网络的连续试用。不要只在这里保存唯一的重要资料。

## 本地体验

需要 Node.js 和 pnpm，浏览器测试另需 Chrome。

```sh
pnpm install --frozen-lockfile
```

复制 `.env.example` 为 `.env.local`，把 `VITE_DEMO_MODE` 改为 `true`，然后运行：

```sh
pnpm dev
```

打开终端显示的网址。本地演示的数据只留在当前浏览器，不上传云端；演示模式只在开发服务器生效，生产构建不能跳过登录。

## 配置自己的云端

1. 在 Supabase 创建测试项目。把 Project URL 和 Publishable key 填入 `.env.local`，并设置 `VITE_DEMO_MODE=false`。不要填写 secret 或 service-role key。
2. 运行以下命令，核对项目及待执行迁移后，再部署：

```sh
pnpm exec supabase login
pnpm exec supabase link --project-ref YOUR_PROJECT_REF
pnpm exec supabase migration list
pnpm exec supabase db push --dry-run
pnpm exec supabase db push
```

3. 数据库迁移不会自动修改 Auth 设置。关闭公开注册，保留邮箱密码登录；对应 CLI 配置为 `auth.enable_signup=false`、`auth.email.enable_signup=true`。如使用 `config push`，先用 `config diff` 核对。不要把 `app_private` 加入 Data API 的 Exposed schemas。
4. 通过 Supabase 管理员控制台创建账号，再到应用中登录。

生产部署需要构建时注入上述 URL 和 Publishable key，构建命令为 `pnpm build`，静态输出目录为 `dist`。环境文件不应提交到仓库。

## 检查

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:pwa
pnpm test:pwa-upgrade
```

只读检查已配置的测试云端：`pnpm check:cloud`。

真实云端联调（需 CLI 登录）：

```sh
pnpm test:cloud --project-ref YOUR_PROJECT_REF
pnpm test:cloud:browser --project-ref YOUR_PROJECT_REF
```

这两项会创建临时测试账号和数据，结束后按本轮账号 ID 清理。网页联调会构建生产 PWA，使用隔离的 Chrome 环境和本机 4186 端口；包含离线冲突、备份恢复、会话撤销与临时账号禁用测试。管理员凭据只在本机测试进程内使用，不进入网页或日志。若提示 `CLEANUP NEEDED`，按输出的测试账号 ID 检查，不要清空项目。

## 数据与边界

- 输入首先保存到当前浏览器的 IndexedDB，正文和待上传队列在同一事务提交。
- 同步使用版本检查和幂等请求；两端内容不同时保留冲突供选择，不自动覆盖。
- 普通退出隐藏但保留本机数据；重新登录原账号可恢复。另设明确的“清除本机数据”。
- 认证服务临时不可达时可继续使用先前已登录账号的本地副本；确认会话失效后锁定界面，未上传内容不删除。
- 本地副本不加密。退出、禁用账号不保证已签发的 JWT 立即失效；本地可读也不代表云端已授权。
- 清除浏览器数据或更换网址可能丢失未同步内容；定期导出 JSON，并验证能恢复。代码仓库不是便签备份。
- 备份导入先校验便签、文件夹、待上传项、冲突和历史；损坏文件整份拒绝，写入失败整笔回滚。已有不同内容不覆盖，文件夹与冲突的不同版本分别保留，重复导入去重。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
