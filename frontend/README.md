# NJU CodePilot 前端

`frontend/` 是零构建依赖的浏览器工作台，包含会话对话、需求澄清、可编辑计划、文件树与编辑器、终端、变更审核、SSE 实时事件和上下文压缩面板。它不保存 API key。

推荐从仓库根目录统一启动：

```text
python run.py
```

运行器会启动后端并打开 `http://127.0.0.1:8124/agent`，后端同时提供静态页面和 `/api/*` 接口。也可手动分离前后端：

```text
python -m backend --host 127.0.0.1 --port 8124
python -m http.server 5173 --directory frontend
```

随后访问 `http://127.0.0.1:5173/?api=http://127.0.0.1:8124`。没有凭据时后端使用 `DemoModel`，依然会执行本地目录检查和验证命令；配置真实模型请参见根目录 `README.md`，密钥只放在环境变量或被 Git 忽略的 `.env` 中。
