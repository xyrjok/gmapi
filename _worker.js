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

    // === 辅助函数: 统一 HTML 返回 (包含字体和样式设置) ===
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
    // 1. API 接口
    // ============================================================

    // 公开接口：获取可用渠道列表 (仅 Gmail，如果想让 Outlook 也支持公开留言可修改此处 SQL)
    if (path === '/api/public/channels' && request.method === 'GET') {
      try {
        const { results } = await XYRJ_GMAILAPI.prepare("SELECT id, name FROM gmail_apis WHERE is_active = 1 ORDER BY id ASC").run();
        return jsonResp(results);
      } catch (e) {
        return jsonResp({ error: "Database Error", details: e.message }, 500);
      }
    }

    // 公开接口：发送留言 (目前仅支持 Gmail 渠道)
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

    // 后台登录
    if (path === '/api/login' && request.method === 'POST') {
      const { username, password } = await request.json();
      if (username === ADMIN_USER && password === ADMIN_PASS) return jsonResp({ success: true, token: ADMIN_PASS });
      return jsonResp({ success: false, msg: "用户名或密码错误" }, 401);
    }

    // --- 管理员权限检查 ---
    if (path.startsWith('/api/admin/')) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== ADMIN_PASS) return jsonResp({ success: false, msg: "无权访问" }, 401);
    }

    // 管理接口：配置
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

    // 管理接口：收信规则
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

    // 管理接口：Gmail 节点
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

    // === 新增：管理接口：Outlook (微软) 节点 ===
    if (path === '/api/admin/outlooks') {
        if (request.method === 'GET') {
            const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM outlook_apis ORDER BY id DESC").run();
            return jsonResp(results);
        }
        if (request.method === 'POST') {
            const { name, client_id, client_secret, refresh_token } = await request.json();
            await XYRJ_GMAILAPI.prepare("INSERT INTO outlook_apis (name, client_id, client_secret, refresh_token) VALUES (?, ?, ?, ?)")
                .bind(name, client_id, client_secret, refresh_token).run();
            return jsonResp({ success: true });
        }
    }
    if (path.startsWith('/api/admin/outlooks/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        await XYRJ_GMAILAPI.prepare("DELETE FROM outlook_apis WHERE id = ?").bind(id).run();
        return jsonResp({ success: true });
    }
    if (path === '/api/admin/outlooks/toggle' && request.method === 'POST') {
        const { id, status } = await request.json();
        await XYRJ_GMAILAPI.prepare("UPDATE outlook_apis SET is_active = ? WHERE id = ?").bind(status, id).run();
        return jsonResp({ success: true });
    }

    // 管理接口：日志
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
    const isEmailPage = path === '/email' || path === '/email.html'; 
    const looksLikeFile = path.includes('.') || path.startsWith('/admin');

    if (isRoot || looksLikeFile || isEmailPage) {
        let assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status >= 200 && assetResponse.status < 400) {
            return assetResponse;
        }
    }

    // ============================================================
    // 3. 智能拦截 (查询码检查 - 支持 Gmail 和 Outlook)
    // ============================================================
    const code = path.substring(1); // 去掉开头的 /
    
    // 确保不是 API 请求也不是文件请求
    if (code && !path.startsWith('/api/') && !looksLikeFile) {
        const rule = await XYRJ_GMAILAPI.prepare("SELECT * FROM receive_rules WHERE access_code = ?").bind(code).first();
        
        if (rule) {
            try {
                // --- 1. 有效期检查 ---
                if (rule.valid_days > 0) {
                    const startTime = new Date(rule.updated_at).getTime();
                    const now = Date.now();
                    const expireTime = startTime + (rule.valid_days * 86400000);
                    if (now > expireTime) {
                        return htmlResp(`<div class="content-output error-box">查询码已过期 (Expired)<br><small>过期时间: ${new Date(expireTime).toLocaleString()}</small></div>`, 403);
                    }
                }

                let emails = [];
                let fetchError = null;

                // --- 2. 查找 API 节点 (先 Gmail 后 Outlook) ---
                
                // A. 尝试获取 Gmail 节点
                const gmailNode = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE name = ? AND is_active = 1").bind(rule.target_api_name).first();
                
                // B. 尝试获取 Outlook 节点
                const outlookNode = await XYRJ_GMAILAPI.prepare("SELECT * FROM outlook_apis WHERE name = ? AND is_active = 1").bind(rule.target_api_name).first();

                if (gmailNode) {
                    // === GMAIL 抓取逻辑 ===
                    const fetchUrl = `${gmailNode.script_url}?action=get&limit=${rule.fetch_count}&count=${rule.fetch_count}&token=${gmailNode.token}`;
                    const gasRes = await fetch(fetchUrl);
                    try { 
                        emails = await gasRes.json(); 
                    } catch (err) { fetchError = "Gmail 解析失败 (JSON Error)"; }

                } else if (outlookNode) {
                    // === OUTLOOK 抓取逻辑 ===
                    try {
                        // 1. 刷新 Token
                        const tokenParams = new URLSearchParams();
                        tokenParams.append('client_id', outlookNode.client_id);
                        tokenParams.append('client_secret', outlookNode.client_secret);
                        tokenParams.append('refresh_token', outlookNode.refresh_token);
                        tokenParams.append('grant_type', 'refresh_token');
                        tokenParams.append('scope', 'https://graph.microsoft.com/.default');

                        const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: tokenParams
                        });
                        const tokenData = await tokenRes.json();

                        if (!tokenData.access_token) {
                            throw new Error("刷新 Token 失败: " + (tokenData.error_description || "未知错误"));
                        }

                        // 2. 读取邮件
                        // 使用 $select 减少数据量，使用 $top 控制条数
                        const graphUrl = `https://graph.microsoft.com/v1.0/me/messages?$top=${rule.fetch_count}&$select=subject,from,bodyPreview,receivedDateTime,body`;
                        const msgRes = await fetch(graphUrl, {
                            headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
                        });
                        const msgData = await msgRes.json();

                        if (!msgData.value) {
                            throw new Error("Graph API 读取失败");
                        }

                        // 3. 数据格式标准化 (转为与 Gmail 相同的格式)
                        emails = msgData.value.map(m => ({
                            date: m.receivedDateTime,
                            from: `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address}>`,
                            // 优先用 bodyPreview (纯文本)，如果没有则尝试取 HTML 内容
                            snippet: m.bodyPreview,
                            body: m.bodyPreview || (m.body ? m.body.content : "") || "No Content"
                        }));

                    } catch (err) {
                        fetchError = "Outlook 错误: " + err.message;
                        console.error(err);
                    }

                } else {
                    return htmlResp(`<div class="content-output error-box">配置错误: 未找到名为 [${rule.target_api_name}] 的 Gmail 或 Outlook 节点。</div>`, 503);
                }

                if (fetchError) {
                    return htmlResp(`<div class="content-output error-box">${fetchError}</div>`, 502);
                }

                // --- 3. 统一过滤逻辑 ---
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

                // --- 4. 格式化输出 HTML ---
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
                    
                    // 去除干扰字符
                    const displayBody = (e.body || e.snippet || "")
                        .replace(/</g,'&lt;')
                        .replace(/\[image:[^\]]*\]/g, '')
                        .replace(/[\r\n]+/g, ' '); 

                    return `<div class="content-output">${timeStr} | ${displayBody}</div>`;
                }).join('');

                return htmlResp(contentHtml || '<div class="content-output error-box">暂无符合条件的邮件</div>');

            } catch (e) {
                return htmlResp(`<div class="content-output error-box">系统错误: ${e.message}</div>`, 500);
            }
        }
    }

    // ============================================================
    // 4. 最终兜底 (404)
    // ============================================================
    return htmlResp(`<div class="content-output error-box">查询码错误！</div>`, 404);
  }
};
