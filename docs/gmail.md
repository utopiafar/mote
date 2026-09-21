# Gmail 只读来源

在 Google Cloud 启用 Gmail API，配置现有的 `MOTE_GOOGLE_CLIENT_ID`、`MOTE_GOOGLE_CLIENT_SECRET` 和 `MOTE_GOOGLE_REDIRECT_URI`。回调仍是 `/oauth/google/callback`，必须与 Google Cloud 登记的完整地址一致。非 loopback 节点使用 HTTPS。密钥只放在节点私有配置中，不提交到仓库。

在 Mote 中打开 **连接 → 添加来源 → 连接服务 → 连接 Gmail（只读）**，开始授权，在 Google 页面完成后返回刷新。Gmail 与 Google Calendar 分别授权、分别保存凭据。Gmail 只请求 `https://www.googleapis.com/auth/gmail.readonly`，没有发送、删除、标记已读或修改标签的接口。

每轮最多读取一页 100 封历史邮件；后续页由定时同步或“继续同步”推进。历史同步完成后使用 Gmail history 游标获取新增、修改和删除。游标过期则重新完整扫描；只有完整扫描结束才确认遗漏的源端邮件，半轮失败不会生成全邮箱删除。分页确认保存在私有文件，记录提交和原件引用在 SQLite 事务中完成，重试不生成重复版本。

邮件正文按 32,000 字符分块，保留 message/thread ID、发件人、收件人、明确的邮件日期及接收时间，不推测截止时间或归属。原始 Gmail MIME JSON 存入归档并随备份导出；附件保留名称及原始 JSON 中的定位，不下载附件正文。每个 API 响应限制 8 MiB，提取正文限制 320 万字符；超限显示错误并保留同步游标供处理，不声称完成。邮件中的文字都是不可信资料，不是对 Mote 的指令。

断开账户会中止在途读取、删除本机 OAuth 凭据并暂停来源，已经归档的历史邮件保留。需要删除 Mote 中的历史资料时使用资料删除功能。Gmail 返回 401/403 时显示需要重新授权。

验证：`node --import tsx --test apps/server/test/gmail.test.ts` 使用 480 封跨 480 天的生成邮件，覆盖分页、重启、限流、增量重放、版本回退、删除、history 过期、原件备份恢复及在途撤销。`scripts/test-web-tasks-imports.cjs` 覆盖浏览器授权链接、继续同步和断开流程，Google 响应使用测试替身。尚未执行真实 Gmail OAuth/账户测试；没有读取任何个人邮件。

协议依据：[Google 同步指南](https://developers.google.com/workspace/gmail/api/guides/sync)、[messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 权限](https://developers.google.com/workspace/gmail/api/auth/scopes)。
