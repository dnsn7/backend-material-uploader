const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

function printUsage() {
  console.log(`
用法:
  node scripts/backend-material-upload-cli.js <url> <类别> [可选参数]

示例:
  node scripts/backend-material-upload-cli.js "https://example.com/article-link" "动漫女头"
  node scripts/backend-material-upload-cli.js "https://example.com/article-link" "动漫男头" --batch-size 9
  node scripts/backend-material-upload-cli.js "" "动漫男头" --action upload-only --start-from 10

可选参数:
  --action <sync-and-upload|upload-only|select-group-only>
  --output-dir <目录>
  --batch-size <每批数量>
  --start-from <起始编号>
  --port <调试端口>
  --ws <webSocketDebuggerUrl>
  --screenshot <截图路径>
`);
}

function getOption(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) {
    return fallback;
  }
  return process.argv[index + 1];
}

function hasOption(name) {
  return process.argv.includes(name);
}

function main() {
  const positionalArgs = process.argv.slice(2).filter((arg, index, all) => {
    if (!arg.startsWith('--')) {
      const prev = all[index - 1];
      return !prev || !prev.startsWith('--');
    }
    return false;
  });

  if (hasOption('--help') || hasOption('-h')) {
    printUsage();
    process.exit(0);
  }

  const action = getOption('--action', 'sync-and-upload');
  const url = positionalArgs[0] || '';
  const group = positionalArgs[1] || '';

  if ((!url && action !== 'upload-only') || !group) {
    printUsage();
    throw new Error('必须提供 url 和 类别；如果是 upload-only，url 可以留空字符串');
  }

  const mainScript = path.join(__dirname, 'sync_backend_materials_cdp.js');
  if (!fs.existsSync(mainScript)) {
    throw new Error(`未找到主脚本: ${mainScript}`);
  }

  const outputDir = getOption('--output-dir', 'D:\\wxgzh-picture');
  const batchSize = getOption('--batch-size', '9');
  const startFrom = getOption('--start-from', '1');
  const port = getOption('--port', '9222');
  const explicitWs = getOption('--ws', '');
  const screenshot = getOption(
    '--screenshot',
    path.resolve(process.cwd(), 'picture', `backend-upload-${Date.now()}.png`)
  );

  const args = [
    mainScript,
    '--action',
    action,
    '--group',
    group,
    '--output-dir',
    outputDir,
    '--batch-size',
    batchSize,
    '--start-from',
    startFrom,
    '--port',
    port,
    '--screenshot',
    screenshot,
  ];

  if (url) {
    args.push('--url', url);
  }
  if (explicitWs) {
    args.push('--ws', explicitWs);
  }

  const result = childProcess.spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }
  if (result.error) {
    throw result.error;
  }
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
