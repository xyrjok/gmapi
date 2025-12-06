export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 基础配置
    const ADMIN_PASS = env.ADMIN_PASS || "123456";
    const ADMIN_EMAIL = env.ADMIN_EMAIL || "your_email@gmail.com";

    const jsonResp = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' // 允许跨域(可选)
      }
    });

    // ============================================================
    // 🌍 公开 API (前台使用)
    // ============================================================

    // 1. 获取公开的联系渠道列表 (只返回 ID 和 名称，不返回 URL/Token)
    if (path === '/api/public/channels' && request.method === 'GET') {
      const { results } = await XYRJ-GMAILAPI.prepare(
        "SELECT id, name FROM gmail_apis WHERE is_active = 1 ORDER BY id ASC"
      ).run();
      return jsonResp(results);
    }

    // 2. 游客发送留言
    if (path === '/api/contact' && request.method === 'POST') {
      try {
        const { name, contact, message, channel_id } = await request.json();
        
        // 1. 确定使用哪个 API (如果指定了ID就用指定的，没指定就随机取一个)
        let apiConfig;
        if (channel_id) {
            apiConfig = await XYRJ-GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE id = ? AND is_active = 1").bind(channel_id).first();
        } else {
            // 负载均衡：随机取一个可用的
            apiConfig = await XYRJ-GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1").first();
        }

        if (!apiConfig) return jsonResp({ success: false, msg: "暂无可用发送渠道" }, 503);

        // 2. 构造邮件
        const subject = `[${apiConfig.name}] 来自 ${name} 的消息`;
        const body = `姓名: ${name}\n联系方式: ${contact}\n渠道: ${apiConfig.name}\n\n留言内容:\n${message}`;

        // 3. 调用 Google Script
        const params = new URLSearchParams({
          action: 'send', 
          token: apiConfig.token, 
          to: ADMIN_EMAIL, 
          subject: subject, 
          body: body
        });

        await fetch(`${apiConfig.script_url}?${params}`);
        
        // 4. 记日志
        await XYRJ-GMAILAPI.prepare("INSERT INTO email_logs (recipient, subject, status) VALUES (?, ?, ?)")
          .bind("ADMIN", subject, `成功(${apiConfig.name})`).run();

        return jsonResp({ success: true, msg: "发送成功" });
      } catch (e) {
        return jsonResp({ success: false, msg: "发送失败: " + e.message }, 500);
      }
    }

    // ============================================================
    // 🔐 管理员 API (需要 Token)
    // ============================================================

    // 登录
    if (path === '/api/login' && request.method === 'POST') {
      const { password } = await request.json();
      return password === ADMIN_PASS 
        ? jsonResp({ success: true, token: ADMIN_PASS }) 
        : jsonResp({ success: false, msg: "密码错误" }, 401);
    }

    // 鉴权中间件
    if (path.startsWith('/api/admin/')) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== ADMIN_PASS) return jsonResp({ success: false, msg: "无权访问" }, 401);
    }

    // --- Gmail API 管理 ---

    // 列表
    if (path === '/api/admin/gmails' && request.method === 'GET') {
      const { results } = await XYRJ-GMAILAPI.prepare("SELECT * FROM gmail_apis ORDER BY id DESC").run();
      return jsonResp(results);
    }

    // 添加单个
    if (path === '/api/admin/gmails' && request.method === 'POST') {
      const { name, url, token } = await request.json();
      await XYRJ-GMAILAPI.prepare("INSERT INTO gmail_apis (name, script_url, token) VALUES (?, ?, ?)")
        .bind(name, url, token).run();
      return jsonResp({ success: true });
    }

    // 批量添加 (支持多行文本解析)
    if (path === '/api/admin/gmails/batch' && request.method === 'POST') {
      const { content } = await request.json(); 
      // 格式假设: 名称,URL,Token (每行一个)
      const lines = content.split('\n');
      let count = 0;
      
      const stmt = XYRJ-GMAILAPI.prepare("INSERT INTO gmail_apis (name, script_url, token) VALUES (?, ?, ?)");
      const batch = [];
      
      for (let line of lines) {
        const parts = line.split(','); // 简单按逗号分隔
        if (parts.length >= 3) {
            batch.push(stmt.bind(parts[0].trim(), parts[1].trim(), parts[2].trim()));
            count++;
        }
      }
      if(batch.length > 0) await XYRJ-GMAILAPI.batch(batch);
      
      return jsonResp({ success: true, count });
    }

    // 删除单个
    if (path.startsWith('/api/admin/gmails/') && request.method === 'DELETE') {
      const id = path.split('/').pop();
      await XYRJ-GMAILAPI.prepare("DELETE FROM gmail_apis WHERE id = ?").bind(id).run();
      return jsonResp({ success: true });
    }
    
    // 批量删除
    if (path === '/api/admin/gmails/batch-delete' && request.method === 'POST') {
        const { ids } = await request.json(); // ids 是数组 [1, 2, 5]
        if(!ids || ids.length === 0) return jsonResp({success: true});
        
        // 构建 (?,?,?)
        const placeholders = ids.map(() => '?').join(',');
        await XYRJ-GMAILAPI.prepare(`DELETE FROM gmail_apis WHERE id IN (${placeholders})`)
            .bind(...ids).run();
        return jsonResp({ success: true });
    }

    // 切换状态 (启用/禁用)
    if (path === '/api/admin/gmails/toggle' && request.method === 'POST') {
        const { id, status } = await request.json();
        await XYRJ-GMAILAPI.prepare("UPDATE gmail_apis SET is_active = ? WHERE id = ?")
            .bind(status, id).run();
        return jsonResp({ success: true });
    }

    // --- 日志管理 ---
    if (path === '/api/admin/logs' && request.method === 'GET') {
      const { results } = await XYRJ-GMAILAPI.prepare("SELECT * FROM email_logs ORDER BY id DESC LIMIT 50").run();
      return jsonResp(results);
    }
    
    // 批量清空日志
    if (path === '/api/admin/logs/clear' && request.method === 'POST') {
        await XYRJ-GMAILAPI.prepare("DELETE FROM email_logs").run();
        return jsonResp({ success: true });
    }

    // 页面路由
    if (path === '/admin') return env.ASSETS.fetch(new Request(new URL('/admin.html', request.url), request));
    return env.ASSETS.fetch(request);
  }
};
