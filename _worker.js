export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 0. 获取数据库和环境变量
    const XYRJ_GMAILAPI = env.XYRJ_GMAILAPI;
    const ADMIN_USER = env.ADMIN_USERNAME || "";
    const ADMIN_PASS = env.ADMIN_PASSWORD || ""; 

    // 辅助函数: JSON 返回
    const jsonResp = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      }
    });

    // === 新增辅助函数: 统一 HTML 返回 (包含字体和样式设置) ===
    const htmlResp = (content, status = 200) => {
        const html = `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>查询结果</title>
            <style>
.content-output {font-size: 15px; font-weight: 500; font-family: 'Microsoft YaHei Bold', 'Microsoft YaHei', sans-serif; word-wrap: break-word; white-space: normal; margin: 0; }
@media (max-width: 670px) { .content-output { font-size: 13px; } }
            </style>
        </head>
        <body>
            ${content}
        </body>
        </html>`;
        return new Response(html, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    };

    // ============================================================
    // 1. API 接口 (保持原有逻辑不变)
    // ============================================================

    if (path === '/api/public/channels' && request.method === 'GET') {
      try {
        const { results } = await XYRJ_GMAILAPI.prepare("SELECT id, name FROM gmail_apis WHERE is_active = 1 ORDER BY id ASC").run();
        return jsonResp(results);
      } catch (e) {
        return jsonResp({ error: "Database Error", details: e.message }, 500);
      }
    }

    if (path === '/api/contact' && request.method === 'POST') {
      try {
        const { name, contact, message, channel_id } = await request.json();
        let targetEmail = env.ADMIN_EMAIL; 
        try {
            const setting = await XYRJ_GMAILAPI.prepare("SELECT value FROM settings WHERE key = 'admin_email'").first();
            if (setting && setting.value) targetEmail = setting.value;
        } catch(e) { console.error("读取数据库配置失败", e); }

        if (!targetEmail) return jsonResp({ success: false, msg: "管理员未设置接收邮箱" }, 500);

        let apiConfig;
        if (channel_id) {
            apiConfig = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE id = ? AND is_active = 1").bind(channel_id).first();
        } else {
            apiConfig = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1").first();
        }

        if (!apiConfig) return jsonResp({ success: false, msg: "暂无可用发送渠道" }, 503);

        const subject = `[${apiConfig.name}] 来自 ${name} 的消息`;
        const body = `姓名: ${name}\n联系方式: ${contact}\n渠道: ${apiConfig.name}\n\n留言内容:\n${message}`;
        const params = new URLSearchParams({ action: 'send', token: apiConfig.token, to: targetEmail, subject, body });

        await fetch(`${apiConfig.script_url}?${params}`);
        await XYRJ_GMAILAPI.prepare("INSERT INTO email_logs (recipient, subject, status) VALUES (?, ?, ?)").bind("ADMIN", subject, `成功(${apiConfig.name})`).run();

        return jsonResp({ success: true, msg: "发送成功" });
      } catch (e) {
        return jsonResp({ success: false, msg: "发送失败: " + e.message }, 500);
      }
    }

    if (path === '/api/login' && request.method === 'POST') {
      const { username, password } = await request.json();
      if (username === ADMIN_USER && password === ADMIN_PASS) return jsonResp({ success: true, token: ADMIN_PASS });
      return jsonResp({ success: false, msg: "用户名或密码错误" }, 401);
    }

    if (path.startsWith('/api/admin/')) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== ADMIN_PASS) return jsonResp({ success: false, msg: "无权访问" }, 401);
    }

    if (path === '/api/admin/config') {
        if (request.method === 'GET') {
            const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM settings").run();
            const config = {}; results.forEach(r => config[r.key] = r.value);
            return jsonResp(config);
        }
        if (request.method === 'POST') {
            const { admin_email } = await request.json();
            await XYRJ_GMAILAPI.prepare("INSERT INTO settings (key, value) VALUES ('admin_email', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(admin_email).run();
            return jsonResp({ success: true });
        }
    }

    if (path === '/api/admin/receivers') {
        if (request.method === 'GET') {
            const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM receive_rules ORDER BY id DESC").run();
            return jsonResp(results);
        }
        if (request.method === 'POST') {
            const data = await request.json();
            if (!data.access_code || !data.name || !data.target_api_name) return jsonResp({ success: false, msg: "参数缺失" }, 400);
            const fetchCount = (data.fetch_count === undefined || data.fetch_count === '') ? 5 : parseInt(data.fetch_count);
            const validDays = (data.valid_days === undefined || data.valid_days === '') ? 0 : parseInt(data.valid_days);
            try {
                if (data.id) {
                    await XYRJ_GMAILAPI.prepare("UPDATE receive_rules SET name=?, access_code=?, fetch_count=?, valid_days=?, match_sender=?, match_body=?, target_api_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
                        .bind(data.name, data.access_code, fetchCount, validDays, data.match_sender||'', data.match_body||'', data.target_api_name, data.id).run();
                } else {
                    await XYRJ_GMAILAPI.prepare("INSERT INTO receive_rules (name, access_code, fetch_count, valid_days, match_sender, match_body, target_api_name) VALUES (?, ?, ?, ?, ?, ?, ?)")
                        .bind(data.name, data.access_code, fetchCount, validDays, data.match_sender||'', data.match_body||'', data.target_api_name).run();
                }
                return jsonResp({ success: true });
            } catch(e) { return jsonResp({ success: false, msg: e.message }, 500); }
        }
    }
    if (path.startsWith('/api/admin/receivers/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        await XYRJ_GMAILAPI.prepare("DELETE FROM receive_rules WHERE id = ?").bind(id).run();
        return jsonResp({ success: true });
    }

    if (path === '/api/admin/gmails') {
        if (request.method === 'GET') {
            const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis ORDER BY id DESC").run();
            return jsonResp(results);
        }
        if (request.method === 'POST') {
            const { name, url, token } = await request.json();
            await XYRJ_GMAILAPI.prepare("INSERT INTO gmail_apis (name, script_url, token) VALUES (?, ?, ?)").bind(name, url, token).run();
            return jsonResp({ success: true });
        }
    }
    if (path === '/api/admin/gmails/batch' && request.method === 'POST') {
      const { content } = await request.json(); 
      const lines = content.split('\n');
      const stmt = XYRJ_GMAILAPI.prepare("INSERT INTO gmail_apis (name, script_url, token) VALUES (?, ?, ?)");
      const batch = [];
      for (let line of lines) {
        const parts = line.split(/[|,，]/); 
        if (parts.length >= 3) batch.push(stmt.bind(parts[0].trim(), parts[1].trim(), parts[2].trim()));
      }
      if(batch.length > 0) await XYRJ_GMAILAPI.batch(batch);
      return jsonResp({ success: true });
    }
    if (path.startsWith('/api/admin/gmails/') && request.method === 'DELETE') {
      const id = path.split('/').pop();
      await XYRJ_GMAILAPI.prepare("DELETE FROM gmail_apis WHERE id = ?").bind(id).run();
      return jsonResp({ success: true });
    }
    if (path === '/api/admin/gmails/toggle' && request.method === 'POST') {
        const { id, status } = await request.json();
        await XYRJ_GMAILAPI.prepare("UPDATE gmail_apis SET is_active = ? WHERE id = ?").bind(status, id).run();
        return jsonResp({ success: true });
    }

    if (path === '/api/admin/logs') {
        if (request.method === 'GET') {
            const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM email_logs ORDER BY id DESC LIMIT 50").run();
            return jsonResp(results);
        }
    }
    if (path === '/api/admin/logs/clear' && request.method === 'POST') {
        await XYRJ_GMAILAPI.prepare("DELETE FROM email_logs").run();
        return jsonResp({ success: true });
    }

    // ============================================================
    // 2. 静态资源策略
    // ============================================================
    const isRoot = path === '/' || path === '/index.html';
    const looksLikeFile = path.includes('.') || path.startsWith('/admin');

    if (isRoot || looksLikeFile) {
        let assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status >= 200 && assetResponse.status < 400) {
            return assetResponse;
        }
    }

    // ============================================================
    // 3. 智能拦截 (查询码检查)
    // ============================================================
    const code = path.substring(1); // 去掉开头的 /
    
    if (code) {
        const rule = await XYRJ_GMAILAPI.prepare("SELECT * FROM receive_rules WHERE access_code = ?").bind(code).first();
        
        if (rule) {
            try {
                // 有效期检查
                if (rule.valid_days > 0) {
                    const startTime = new Date(rule.updated_at).getTime();
                    const now = Date.now();
                    const expireTime = startTime + (rule.valid_days * 86400000);
                    if (now > expireTime) {
                         // 过期也使用 htmlResp，只是文字不同
                        return htmlResp(`<div class="content-output error-box">查询码已过期 (Expired)<br><small>过期时间: ${new Date(expireTime).toLocaleString()}</small></div>`, 403);
                    }
                }

                // 节点查找
                const apiNode = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE name = ? AND is_active = 1").bind(rule.target_api_name).first();
                if (!apiNode) {
                    return htmlResp(`<div class="content-output error-box">配置错误: 指定的 API 节点 [${rule.target_api_name}] 不存在或已停用。</div>`, 503);
                }

                // 抓取邮件
                const fetchUrl = `${apiNode.script_url}?action=get&limit=${rule.fetch_count}&count=${rule.fetch_count}&token=${apiNode.token}`;
                const gasRes = await fetch(fetchUrl);
                let emails = [];
                try { emails = await gasRes.json(); } catch (err) { 
                    return htmlResp(`<div class="content-output error-box">解析邮件数据失败。<br>可能是 Token 错误或 GAS 脚本未返回 JSON。</div>`, 502); 
                }

                // 过滤
                const finalEmails = emails.filter(email => {
                    const content = (email.body || email.snippet || "").toLowerCase();
                    const sender = (email.from || "").toLowerCase();
                    let matchS = true, matchB = true;
                    if (rule.match_sender) {
                        const keys = rule.match_sender.split(/[|,，]/).filter(k=>k.trim());
                        matchS = keys.some(k => sender.includes(k.toLowerCase()));
                    }
                    if (rule.match_body) {
                        const keys = rule.match_body.split(/[|,，]/).filter(k=>k.trim());
                        matchB = keys.some(k => content.includes(k.toLowerCase()));
                    }
                    return matchS && matchB;
                });

                // ========================================================
                // 4. 格式化输出 (修改处)
                // ========================================================
                const contentHtml = finalEmails.map(e => {
                    const utcTime = new Date(e.date).getTime();
                    const cnTime = new Date(utcTime + 8 * 3600000); 

                    const y = cnTime.getUTCFullYear();
                    const m = String(cnTime.getUTCMonth() + 1).padStart(2, '0');
                    const d = String(cnTime.getUTCDate()).padStart(2, '0');
                    const h = String(cnTime.getUTCHours()).padStart(2, '0');
                    const min = String(cnTime.getUTCMinutes()).padStart(2, '0');
                    const s = String(cnTime.getUTCSeconds()).padStart(2, '0');
                    
                    const timeStr = `${y}-${m}-${d} ${h}:${min}:${s}`;
                    
                    // 修改：去除 [image:...] 并转义 HTML
                    const displayBody = (e.body || e.snippet || "")
                        .replace(/</g,'&lt;')
                        .replace(/\[image:[^\]]*\]/g, '')
                        .replace(/[\r\n]+/g, ' '); // 新增：将内容中的换行符替换为空格 

                    // 注意：这里应用 content-output 样式类
                    return `<div class="content-output">${timeStr} | ${displayBody}</div>`;
                }).join('');

                // 使用 htmlResp 返回，如果为空则显示提示
                return htmlResp(contentHtml || '<div class="content-output error-box">暂无符合条件的邮件</div>');

            } catch (e) {
                // 系统错误也使用统一样式
                return htmlResp(`<div class="content-output error-box">系统错误: ${e.message}</div>`, 500);
            }
        }
    }

    // ============================================================
    // 5. 最终兜底 (修改处)
    // ============================================================
    return htmlResp(`<div class="content-output error-box">查询码错！</div>`, 404);
  }
};
