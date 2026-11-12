# Folio MCP 快速接入

请为当前客户端添加名为 `folio` 的远程 MCP：连接地址为获取本文的同一站点加 `/mcp`，传输使用 **Streamable HTTP**，认证为 `Authorization: Bearer <Access Token>`。

令牌由用户在 Folio「用户设置 → 应用」生成，通过客户端安全凭据配置提供，不在聊天中索取，不写入 URL、日志或仓库，不向其他站点或重定向转发。客户端须支持远程 HTTP 与自定义请求头；不支持 OAuth、旧式 SSE 或 stdio。自动配置取决于客户端权限，不能自动配置时提供步骤，不绕过审批。

## JSON 配置

以下为 `mcpServers` 格式示例；将站点替换为获取本文的来源，令牌由用户安全填写。按客户端格式合并 `folio` 条目，不覆盖已有服务或其他设置。

```json
{
  "mcpServers": {
    "folio": {
      "type": "http",
      "url": "https://你的站点/mcp",
      "headers": {
        "Authorization": "Bearer <Access Token>"
      }
    }
  }
}
```

保存后连接并通过 `tools/list` 发现当前权限允许的工具；使用 MCP 初始化说明和工具定义，不必另读操作手册。此公开说明不授予文件权限，连接成功也不代表获得额外任务授权。