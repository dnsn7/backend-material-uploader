const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('连接 CDP 超时')), 10000);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };

      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.id && this.pending.has(payload.id)) {
          const { resolve: done, reject: fail } = this.pending.get(payload.id);
          this.pending.delete(payload.id);
          if (payload.error) {
            fail(new Error(payload.error.message || 'CDP 命令失败'));
          } else {
            done(payload.result || {});
          }
        }
      };

      ws.onerror = (error) => {
        clearTimeout(timer);
        reject(error);
      };

      ws.onclose = () => {
        for (const { reject: fail } of this.pending.values()) {
          fail(new Error('CDP 连接已关闭'));
        }
        this.pending.clear();
      };
    });
  }

  async send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时: ${method}`));
        }
      }, 15000);
    });
  }

  async close() {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.close();
    }
  }
}

function getArgValue(name, defaultValue) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) {
    return defaultValue;
  }
  return process.argv[index + 1];
}

function normalizeImageUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`;
  if (!/^https?:/i.test(url)) return '';
  return url.split('#')[0];
}

function normalizeLabelText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\([\d,\s]+\)\s*$/, '')
    .trim();
}

function getImageExtension(url, contentType) {
  try {
    const parsed = new URL(url);
    const format = parsed.searchParams.get('wx_fmt');
    if (format) {
      if (format === 'jpeg') return 'jpg';
      return format;
    }
  } catch (_) {
    // Ignore parse errors.
  }

  if (contentType) {
    if (contentType.includes('jpeg')) return 'jpg';
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('gif')) return 'gif';
    if (contentType.includes('webp')) return 'webp';
  }
  return 'jpg';
}

function clearIndexedOutputDir(outputDir) {
  for (const entry of fs.readdirSync(outputDir)) {
    if (/^\d+\.(jpg|jpeg|png|gif|webp)$/i.test(entry)) {
      fs.unlinkSync(path.join(outputDir, entry));
    }
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`请求失败: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function getBrowserWs(port, explicitWs) {
  if (explicitWs) {
    return explicitWs;
  }
  const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  return info.webSocketDebuggerUrl;
}

async function createPageSession(client, initialUrl) {
  const { targetId } = await client.send('Target.createTarget', { url: initialUrl });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('DOM.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function evaluate(client, sessionId, expression, returnByValue = true) {
  const result = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue,
    },
    sessionId
  );

  if (result.exceptionDetails) {
    const message =
      result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      '页面脚本执行失败';
    throw new Error(message);
  }

  return returnByValue ? result.result.value : result.result;
}

async function navigate(client, sessionId, url) {
  await client.send('Page.navigate', { url }, sessionId);
  await waitForPageReady(client, sessionId, 15000);
}

async function waitForPageReady(client, sessionId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const readyState = await evaluate(client, sessionId, 'document.readyState');
    if (readyState === 'interactive' || readyState === 'complete') {
      await sleep(1200);
      return;
    }
    await sleep(300);
  }
  throw new Error('等待页面加载超时');
}

async function waitForUrlContains(client, sessionId, keyword, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const href = await evaluate(client, sessionId, 'location.href');
    if (href && href.includes(keyword)) {
      return href;
    }
    await sleep(500);
  }
  throw new Error(`等待页面 URL 包含 ${keyword} 超时`);
}

async function clickByText(client, sessionId, targetText, exactMatch = false) {
  const script = `
    (() => {
      const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const target = normalize(${JSON.stringify(targetText)});
      const exact = ${exactMatch ? 'true' : 'false'};
      const isGroupMatch = (text) => {
        const plain = text.replace(/\\s*\\(\\d+\\)$/, '').trim();
        return text === target || plain === target;
      };
      const nodes = Array.from(document.querySelectorAll('a,button,span,div'));
      for (const node of nodes) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (!text) continue;
        const matched = exact
          ? isGroupMatch(text)
          : text === target || text.startsWith(target + ' (') || text.includes(target);
        if (matched) {
          node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }
      }
      return false;
    })()
  `;
  return evaluate(client, sessionId, script);
}

async function clickSelectorText(client, sessionId, selector, targetText, exactMatch = false) {
  const script = `
    (() => {
      const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const target = normalize(${JSON.stringify(targetText)});
      const exact = ${exactMatch ? 'true' : 'false'};
      const isGroupMatch = (text) => {
        const plain = text.replace(/\\s*\\(\\d+\\)$/, '').trim();
        return text === target || plain === target;
      };
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      for (const node of nodes) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const text = normalize(node.innerText || node.textContent || '');
        const matched = exact
          ? isGroupMatch(text)
          : text === target || text.includes(target);
        if (matched) {
          node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }
      }
      return false;
    })()
  `;
  return evaluate(client, sessionId, script);
}

async function queryObject(client, sessionId, expression) {
  const result = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: false,
    },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || '查询页面对象失败');
  }
  return result.result.objectId || null;
}

async function setInputFiles(client, sessionId, files) {
  const objectId = await queryObject(client, sessionId, "document.querySelector('input[type=file]')");
  if (!objectId) {
    throw new Error('页面上未找到文件输入框');
  }
  await client.send('DOM.setFileInputFiles', { files, objectId }, sessionId);
}

async function setInputFilesByExpression(client, sessionId, expression, files) {
  const objectId = await queryObject(client, sessionId, expression);
  if (!objectId) {
    return false;
  }
  await client.send('DOM.setFileInputFiles', { files, objectId }, sessionId);
  await evaluate(
    client,
    sessionId,
    `(() => {
      const input = ${expression};
      if (!input) return false;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  ).catch(() => false);
  return true;
}

async function extractArticleUrls(client, sessionId) {
  const script = `
    (() => {
      const normalize = (rawUrl) => {
        if (!rawUrl) return '';
        let url = rawUrl.trim();
        if (!url) return '';
        if (url.startsWith('//')) url = 'https:' + url;
        if (url.startsWith('http://')) url = 'https://' + url.slice('http://'.length);
        if (!/^https?:/i.test(url)) return '';
        return url.split('#')[0];
      };
      const container =
        document.querySelector('#js_content') ||
        document.querySelector('.rich_media_content') ||
        document.body;
      const seen = new Set();
      const urls = [];
      for (const img of Array.from(container.querySelectorAll('img'))) {
        const url = normalize(img.getAttribute('data-src') || img.getAttribute('src') || '');
        if (!url || !/mmbiz\\.qpic\\.cn/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
      return urls;
    })()
  `;
  return evaluate(client, sessionId, script);
}

async function downloadImage(url, filePath) {
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
      referer: 'https://mp.weixin.qq.com/',
    },
  });
  if (!response.ok) {
    throw new Error(`下载失败: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return response.headers.get('content-type') || '';
}

async function downloadAllButLastImage(client, outputDir, articleUrl) {
  fs.mkdirSync(outputDir, { recursive: true });
  clearIndexedOutputDir(outputDir);

  const articlePage = await createPageSession(client, articleUrl);
  await waitForPageReady(client, articlePage.sessionId, 15000);
  await sleep(1500);
  const urls = await extractArticleUrls(client, articlePage.sessionId);
  if (!Array.isArray(urls) || urls.length < 2) {
    throw new Error(`提取到的正文图片数量不足，当前数量: ${Array.isArray(urls) ? urls.length : 0}`);
  }

  const keptUrls = urls.slice(0, -1);
  const savedFiles = [];
  for (let i = 0; i < keptUrls.length; i += 1) {
    const url = normalizeImageUrl(keptUrls[i]);
    const baseName = String(i + 1).padStart(2, '0');
    const tempPath = path.join(outputDir, `${baseName}.tmp`);
    const contentType = await downloadImage(url, tempPath);
    const extension = getImageExtension(url, contentType);
    const finalPath = path.join(outputDir, `${baseName}.${extension}`);
    fs.renameSync(tempPath, finalPath);
    savedFiles.push(finalPath);
    console.log(`已保存: ${finalPath}`);
  }

  return {
    articleUrl,
    totalExtracted: urls.length,
    totalSaved: savedFiles.length,
    savedFiles,
  };
}

function listOutputFiles(outputDir, startFrom = 1) {
  return fs
    .readdirSync(outputDir)
    .filter((entry) => /^\d+\.(jpg|jpeg|png|gif|webp)$/i.test(entry))
    .filter((entry) => {
      const index = Number.parseInt(entry, 10);
      return Number.isFinite(index) && index >= startFrom;
    })
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((entry) => path.join(outputDir, entry));
}

async function ensureLoggedIn(client, sessionId) {
  const bodyText = await evaluate(client, sessionId, 'document.body ? document.body.innerText : ""');
  if (/扫码登录|请使用扫描二维码登录|登录/i.test(bodyText) && !/首页|内容管理|素材库/.test(bodyText)) {
    throw new Error('检测到后台未登录，请先在可见 Edge 窗口完成登录后再重试');
  }
}

async function openMaterialLibrary(client, sessionId) {
  await navigate(client, sessionId, 'https://mp.weixin.qq.com/');
  await ensureLoggedIn(client, sessionId);

  if (!(await clickSelectorText(client, sessionId, 'span.weui-desktop-menu__name', '内容管理', true))) {
    throw new Error('未找到“内容管理”菜单');
  }
  await sleep(800);

  if (!(await clickSelectorText(client, sessionId, 'a.weui-desktop-menu__link', '素材库', true))) {
    throw new Error('未找到“素材库”菜单');
  }
  await waitForUrlContains(client, sessionId, 'filepage', 15000);
  await sleep(1500);
}

async function getSelectedGroupLabel(client, sessionId) {
  const script = `
    (() => {
      const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const tags = Array.from(document.querySelectorAll('li.weui-desktop-tag, .weui-desktop-tag'));
      const current = tags.find((node) => {
        const cls = String(node.className || '');
        return (
          node.getAttribute('aria-selected') === 'true' ||
          /selected|current|active|on|weui-desktop-tag_current|weui-desktop-tag_selected/i.test(cls)
        );
      });
      return current ? normalize(current.innerText || current.textContent || '') : '';
    })()
  `;
  return evaluate(client, sessionId, script);
}

async function getGroupState(client, sessionId) {
  const script = `
    (() => {
      const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const plain = (value) => normalize(value).replace(/\\s*\\([\\d,\\s]+\\)\\s*$/, '').trim();
      const tags = Array.from(document.querySelectorAll('li.weui-desktop-tag, .weui-desktop-tag'))
        .map((node, index) => {
          const text = normalize(node.innerText || node.textContent || '');
          const cls = String(node.className || '');
          const visible = (() => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && !!rect.width && !!rect.height;
          })();
          return {
            index,
            text,
            plainText: plain(text),
            className: cls,
            ariaSelected: node.getAttribute('aria-selected'),
            visible,
            current:
              node.getAttribute('aria-selected') === 'true' ||
              /selected|current|active|on|weui-desktop-tag_current|weui-desktop-tag_selected/i.test(cls),
          };
        })
        .filter((item) => item.visible && item.text);
      const current = tags.find((item) => item.current) || null;
      return {
        currentLabel: current ? current.text : '',
        currentPlainLabel: current ? current.plainText : '',
        labels: tags.map((item) => item.text),
      };
    })()
  `;
  return evaluate(client, sessionId, script);
}

async function getMaterialCount(client, sessionId) {
  const count = await evaluate(
    client,
    sessionId,
    "(() => { const node = document.querySelector('#js_count'); return node ? Number((node.textContent || '').trim()) : null; })()"
  ).catch(() => null);
  return Number.isFinite(count) ? count : null;
}

async function listVisibleMaterialNames(client, sessionId) {
  return evaluate(
    client,
    sessionId,
    `(() => {
      const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('a,span,div,p'))
        .map((node) => normalize(node.innerText || node.textContent || ''))
        .filter((text) => /^\\d+\\.(jpg|jpeg|png|gif|webp)$/i.test(text))
        .slice(0, 100);
    })()`
  ).catch(() => []);
}

async function waitForUploadSuccess(client, sessionId, beforeCount, expectedNames, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentCount = await getMaterialCount(client, sessionId);
    const visibleNames = await listVisibleMaterialNames(client, sessionId);
    const matchedNames = expectedNames.filter((name) => visibleNames.includes(name));
    if ((beforeCount !== null && currentCount !== null && currentCount > beforeCount) || matchedNames.length > 0) {
      return { currentCount, visibleNames, matchedNames };
    }
    await sleep(1500);
  }
  return null;
}

async function reloadAndVerifyUpload(client, sessionId, beforeCount, expectedNames) {
  await client.send('Page.reload', { ignoreCache: false }, sessionId);
  await waitForPageReady(client, sessionId, 20000);
  await sleep(2000);
  const currentCount = await getMaterialCount(client, sessionId);
  const visibleNames = await listVisibleMaterialNames(client, sessionId);
  const matchedNames = expectedNames.filter((name) => visibleNames.includes(name));
  const persisted = (beforeCount !== null && currentCount !== null && currentCount > beforeCount) || matchedNames.length > 0;
  return { persisted, currentCount, visibleNames, matchedNames };
}

async function listVisibleGroupLabels(client, sessionId) {
  const script = `
    (() => {
      const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('a,button,span,div,li'))
        .map((node) => {
          const text = normalize(node.innerText || node.textContent || '');
          const cls = String(node.className || '');
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return { text, cls, visible: style.display !== 'none' && style.visibility !== 'hidden' && !!rect.width && !!rect.height };
        })
        .filter((item) => item.visible && item.text && /头像|壁纸|动漫|简约|展开更多/.test(item.text))
        .slice(0, 80);
    })()
  `;
  return evaluate(client, sessionId, script);
}

async function waitForGroupPopover(client, sessionId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const visible = await evaluate(
      client,
      sessionId,
      `(() => {
        const popovers = Array.from(document.querySelectorAll('.weui-desktop-popover__wrp, .weui-desktop-popover_img-opr-group'));
        return popovers.some((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && !!rect.width && !!rect.height;
        });
      })()`
    ).catch(() => false);
    if (visible) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function openGroupPopover(client, sessionId) {
  const clicked = await clickByText(client, sessionId, '展开更多', true);
  if (!clicked) {
    throw new Error('未找到“展开更多”按钮');
  }
  const visible = await waitForGroupPopover(client, sessionId, 5000);
  if (!visible) {
    throw new Error('点击“展开更多”后未看到分组弹层');
  }
}

async function clickGroupInPopover(client, sessionId, groupName) {
  const script = `
    (() => {
      const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const target = normalize(${JSON.stringify(groupName)});
      const isGroupMatch = (text) => {
        const plain = text.replace(/\\s*\\([\\d,\\s]+\\)$/, '').trim();
        return text === target || plain === target;
      };
      const isVisible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && !!rect.width && !!rect.height;
      };
      const popovers = Array.from(document.querySelectorAll('.weui-desktop-popover__wrp, .weui-desktop-popover_img-opr-group')).filter(isVisible);
      const nodes = popovers.flatMap((popover) => Array.from(popover.querySelectorAll('*')));
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (!text) continue;
        if (isGroupMatch(text)) {
          const clickable = node.closest('li,button,a,label,span,div') || node;
          clickable.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
          clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }
      }
      return false;
    })()
  `;
  return evaluate(client, sessionId, script);
}

async function waitForSelectedGroup(client, sessionId, groupName, timeoutMs = 8000) {
  const target = normalizeLabelText(groupName);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getGroupState(client, sessionId).catch(() => null);
    if (state && normalizeLabelText(state.currentPlainLabel || state.currentLabel) === target) {
      return state;
    }
    await sleep(400);
  }
  return null;
}

async function confirmGroupPopover(client, sessionId) {
  const clicked = await clickGroupInPopover(client, sessionId, '确定');
  if (!clicked) {
    return false;
  }
  await sleep(800);
  return true;
}

async function selectGroup(client, sessionId, groupName) {
  const normalizedTarget = normalizeLabelText(groupName);
  const currentState = await getGroupState(client, sessionId).catch(() => null);
  if (currentState && normalizeLabelText(currentState.currentPlainLabel || currentState.currentLabel) === normalizedTarget) {
    console.log(`当前分组已确认: ${currentState.currentLabel}`);
    return currentState;
  }

  let selectedState = null;

  const clickedVisibleTag =
    (await clickSelectorText(client, sessionId, 'li.weui-desktop-tag, .weui-desktop-tag', groupName, true).catch(() => false)) ||
    (await clickByText(client, sessionId, groupName, true).catch(() => false));
  if (clickedVisibleTag) {
    selectedState = await waitForSelectedGroup(client, sessionId, groupName, 6000);
  }

  if (!selectedState) {
    await openGroupPopover(client, sessionId);
    const clickedInPopover = await clickGroupInPopover(client, sessionId, groupName);
    if (!clickedInPopover) {
      const labels = await listVisibleGroupLabels(client, sessionId).catch(() => []);
      throw new Error(`未找到素材分组: ${groupName}。当前可见分组: ${JSON.stringify(labels)}`);
    }
    await sleep(500);
    await confirmGroupPopover(client, sessionId).catch(() => false);
    selectedState = await waitForSelectedGroup(client, sessionId, groupName, 6000);
  }

  if (!selectedState) {
    const state = await getGroupState(client, sessionId).catch(() => ({ currentLabel: '', labels: [] }));
    throw new Error(
      `素材分组切换失败。目标分组: ${groupName}，当前高亮: ${state.currentLabel || '未知'}，当前可见分组: ${JSON.stringify(
        state.labels || []
      )}`
    );
  }
  console.log(`当前分组已确认: ${selectedState.currentLabel}`);
  return selectedState;
}

async function clickUploadTrigger(client, sessionId) {
  const clicked =
    (await clickSelectorText(client, sessionId, '.weui-desktop-upload_global-media a, .weui-desktop-upload_global-media button, .weui-desktop-upload_global-media span, .weui-desktop-upload_global-media div', '上传', true).catch(
      () => false
    )) || (await clickByText(client, sessionId, '上传', true).catch(() => false));
  if (!clicked) {
    throw new Error('未找到“上传”按钮');
  }
  await sleep(1200);
}

async function waitForUploadInputReady(client, sessionId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evaluate(
      client,
      sessionId,
      `(() => {
        const container = document.querySelector('.weui-desktop-upload_global-media') || document;
        const inputs = Array.from(container.querySelectorAll('input[type=file]'))
          .filter((input) => (input.accept || '').includes('image'))
          .map((input, index) => ({
            index,
            accept: input.accept || '',
            disabled: !!input.disabled,
            connected: input.isConnected,
          }));
        return {
          total: inputs.length,
          ready: inputs.some((item) => item.connected && !item.disabled),
        };
      })()`
    ).catch(() => ({ total: 0, ready: false }));

    if (state.ready) {
      await sleep(800);
      return state;
    }
    await sleep(300);
  }
  throw new Error('上传输入框未就绪，已超时');
}

async function attachFilesToUploadInput(client, sessionId, files) {
  const expression = `
    (() => {
      const container = document.querySelector('.weui-desktop-upload_global-media') || document;
      const inputs = Array.from(container.querySelectorAll('input[type=file]'))
        .filter((input) => (input.accept || '').includes('image') && !input.disabled && input.isConnected);
      return inputs[inputs.length - 1] || null;
    })()
  `;
  const attached = await setInputFilesByExpression(client, sessionId, expression, files).catch(() => false);
  if (attached) {
    await sleep(1800);
  }
  return attached;
}

async function verifyUploadPersistedInGroup(client, sessionId, groupName, beforeCount, timeoutMs) {
  const target = normalizeLabelText(groupName);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getGroupState(client, sessionId).catch(() => null);
    if (!state || normalizeLabelText(state.currentPlainLabel || state.currentLabel) !== target) {
      await selectGroup(client, sessionId, groupName);
    }
    const currentCount = await getMaterialCount(client, sessionId);
    if (beforeCount !== null && currentCount !== null && currentCount > beforeCount) {
      return { currentCount };
    }
    await sleep(2000);
    await client.send('Page.reload', { ignoreCache: false }, sessionId);
    await waitForPageReady(client, sessionId, 20000);
    await ensureLoggedIn(client, sessionId);
    await waitForUrlContains(client, sessionId, 'filepage', 15000);
    await sleep(1500);
  }
  return null;
}

async function waitForCountStableIncrease(client, sessionId, groupName, beforeCount, timeoutMs) {
  const target = normalizeLabelText(groupName);
  const start = Date.now();
  let maxCount = beforeCount;
  let lastChangedAt = Date.now();

  while (Date.now() - start < timeoutMs) {
    const state = await getGroupState(client, sessionId).catch(() => null);
    if (!state || normalizeLabelText(state.currentPlainLabel || state.currentLabel) !== target) {
      await selectGroup(client, sessionId, groupName);
    }

    const currentCount = await getMaterialCount(client, sessionId);
    if (currentCount !== null && currentCount > maxCount) {
      maxCount = currentCount;
      lastChangedAt = Date.now();
    }

    if (maxCount > beforeCount && Date.now() - lastChangedAt >= 5000) {
      return { currentCount: maxCount, increasedBy: maxCount - beforeCount };
    }

    await sleep(2000);
    await client.send('Page.reload', { ignoreCache: false }, sessionId);
    await waitForPageReady(client, sessionId, 20000);
    await ensureLoggedIn(client, sessionId);
    await waitForUrlContains(client, sessionId, 'filepage', 15000);
    await sleep(1500);
  }

  return maxCount > beforeCount ? { currentCount: maxCount, increasedBy: maxCount - beforeCount } : null;
}

async function uploadFiles(client, sessionId, outputDir, groupName, startFrom = 1, batchSize = 9) {
  const files = listOutputFiles(outputDir, startFrom);
  if (!files.length) {
    throw new Error(`目录中没有可上传的图片: ${outputDir}，起始编号: ${startFrom}`);
  }

  const selectedState = await getGroupState(client, sessionId).catch(() => null);
  if (!selectedState || normalizeLabelText(selectedState.currentPlainLabel || selectedState.currentLabel) !== normalizeLabelText(groupName)) {
    throw new Error(`上传前未停留在目标素材分组。目标分组: ${groupName}，当前分组: ${selectedState?.currentLabel || '未知'}`);
  }

  const beforeCount = await getMaterialCount(client, sessionId);
  if (beforeCount === null) {
    throw new Error(`无法识别当前分组素材数量，已中止上传以避免误传。目标分组: ${groupName}`);
  }

  const batches = chunkArray(files, Math.max(1, batchSize));
  let currentBeforeCount = beforeCount;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.log(`开始上传第 ${index + 1} 批，共 ${batches.length} 批，本批 ${batch.length} 张`);

    await clickUploadTrigger(client, sessionId);
    await waitForUploadInputReady(client, sessionId, 10000);

    const attached = await attachFilesToUploadInput(client, sessionId, batch);
    if (!attached) {
      if (batch.length !== files.length) {
        throw new Error(`当前批次无法通过文件输入框上传，已中止以避免重复上传。批次: ${index + 1}/${batches.length}`);
      }
      await clickUploadTrigger(client, sessionId);
      await waitForUploadInputReady(client, sessionId, 10000);
      const dialogScript = path.join(__dirname, 'select-files-in-open-dialog.ps1');
      childProcess.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          dialogScript,
          '-FolderPath',
          outputDir,
        ],
        { stdio: 'inherit' }
      );
    }

    const successState = await waitForCountStableIncrease(
      client,
      sessionId,
      groupName,
      currentBeforeCount,
      Math.max(50000, batch.length * 8000)
    );

    if (!successState) {
      const state = await getGroupState(client, sessionId).catch(() => ({ currentLabel: '' }));
      const afterCount = await getMaterialCount(client, sessionId);
      throw new Error(
        `第 ${index + 1} 批上传未确认成功。目标分组: ${groupName}，当前分组: ${state.currentLabel || '未知'}，上传前数量: ${
          currentBeforeCount ?? '未知'
        }，上传后数量: ${afterCount ?? '未知'}`
      );
    }

    currentBeforeCount = successState.currentCount;
    console.log(`第 ${index + 1} 批完成，当前数量: ${successState.currentCount}，本批新增: ${successState.increasedBy}`);
    if (index < batches.length - 1) {
      console.log('等待上传控件冷却后继续下一批...');
      await sleep(2500);
    }
  }

  return files;
}


async function saveScreenshot(client, sessionId, screenshotPath) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(data, 'base64'));
}

async function run() {
  const articleUrl = getArgValue('--url', '');
  const groupName = getArgValue('--group', '');
  const outputDir = getArgValue('--output-dir', 'D:\\wxgzh-picture');
  const startFrom = Number(getArgValue('--start-from', '1'));
  const batchSize = Number(getArgValue('--batch-size', '9'));
  const screenshotPath = getArgValue(
    '--screenshot',
    path.resolve(process.cwd(), 'picture', 'backend-material-upload.png')
  );
  const port = Number(getArgValue('--port', '9222'));
  const explicitWs = getArgValue('--ws', '');
  const action = getArgValue('--action', 'sync-and-upload');

  if ((!articleUrl && action !== 'upload-only') || !groupName) {
    throw new Error('请通过 --group 传入素材分类名；除 upload-only 外，还需要通过 --url 传入文章链接');
  }

  const browserWs = await getBrowserWs(port, explicitWs);
  const client = new CDPClient(browserWs);
  await client.connect();

  try {
    let downloadResult = null;
    if (action !== 'upload-only') {
      downloadResult = await downloadAllButLastImage(client, outputDir, articleUrl);
    }
    const materialPage = await createPageSession(client, 'https://mp.weixin.qq.com/');
    await openMaterialLibrary(client, materialPage.sessionId);
    await selectGroup(client, materialPage.sessionId, groupName);
    if (action === 'select-group-only') {
      await saveScreenshot(client, materialPage.sessionId, screenshotPath);
      console.log(`已选择分组: ${groupName}`);
      console.log(`截图已保存: ${screenshotPath}`);
      return;
    }
    const uploadedFiles = await uploadFiles(
      client,
      materialPage.sessionId,
      outputDir,
      groupName,
      Number.isFinite(startFrom) ? startFrom : 1,
      Number.isFinite(batchSize) ? batchSize : 9
    );
    await saveScreenshot(client, materialPage.sessionId, screenshotPath);

    if (downloadResult) {
      console.log(`文章页面: ${articleUrl}`);
      console.log(`提取图片: ${downloadResult.totalExtracted}`);
      console.log(`保存图片: ${downloadResult.totalSaved}`);
    } else {
      console.log(`文章页面: 跳过采图，直接上传目录`);
    }
    console.log(`素材分组: ${groupName}`);
    console.log(`起始编号: ${Number.isFinite(startFrom) ? startFrom : 1}`);
    console.log(`批次大小: ${Number.isFinite(batchSize) ? batchSize : 9}`);
    console.log(`上传数量: ${uploadedFiles.length}`);
    console.log(`输出目录: ${outputDir}`);
    console.log(`截图已保存: ${screenshotPath}`);
    console.log(`调试地址: ${browserWs}`);
  } finally {
    await client.close().catch(() => { });
  }
}

run().catch((error) => {
  console.error('脚本执行失败:');
  console.error(error);
  process.exit(1);
});
