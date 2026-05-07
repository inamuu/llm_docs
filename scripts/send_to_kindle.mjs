#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  console.error("playwright が見つかりません。先に `npm install` を実行してください。");
  if (error?.message) {
    console.error(error.message);
  }
  process.exit(1);
}

const SEND_TO_KINDLE_URL = "https://www.amazon.co.jp/sendtokindle/";
const DEFAULT_PROFILE_DIR = path.join(
  os.homedir(),
  ".cache",
  "llm_docs-send-to-kindle"
);
const S2K_SIGN_IN_BUTTON_SELECTOR = "#s2k-dnd-sign-in-button";
const S2K_SIGN_IN_VIEW_SELECTORS = [
  "#s2k-home-wrapper-sign-in-view",
  "#s2k-dnd-area-sign-in-view",
  S2K_SIGN_IN_BUTTON_SELECTOR,
];
const S2K_UPLOADER_SELECTORS = [
  "#s2k-dnd-area",
  ".s2k-dnd-box",
  ".s2k-dnd-add-your-files-button",
  "#s2k-dnd-container",
  "#s2k-r2s-send-button",
];
const S2K_ADD_FILES_BUTTON_SELECTOR = ".s2k-dnd-add-your-files-button";
const S2K_DROP_AREA_SELECTOR = ".s2k-dnd-box";
const S2K_SEND_BUTTON_SELECTOR = "#s2k-r2s-send-button";
const S2K_MAINTENANCE_BANNER_SELECTOR = "#s2k-tip-banner";
const S2K_MAINTENANCE_PATTERNS = [
  /サービスは一時的にご利用いただけません/i,
  /技術的な問題/i,
  /メンテナンス中/i,
  /service unavailable/i,
];

const SUCCESS_PATTERNS = [
  /送信されました/i,
  /送信しました/i,
  /ライブラリに追加されました/i,
  /アップロードが完了/i,
  /completed/i,
  /uploaded/i,
  /added to your library/i,
  /sent to your kindle/i,
];

const SEND_BUTTON_PATTERNS = [
  /送信$/i,
  /^送信/i,
  /^send$/i,
  /send to kindle/i,
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = resolveFiles(options.files);

  if (files.length === 0) {
    printHelp();
    process.exit(1);
  }

  const browserOptions = {
    headless: options.headless,
    channel: options.channel,
    viewport: { width: 1440, height: 1100 },
    args: ["--disable-blink-features=AutomationControlled"],
  };

  const context = await chromium.launchPersistentContext(
    options.profileDir,
    browserOptions
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(options.timeoutMs);
    page.setDefaultNavigationTimeout(options.timeoutMs);

    console.log(`Send to Kindle を開きます: ${SEND_TO_KINDLE_URL}`);
    await page.goto(SEND_TO_KINDLE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await dismissCommonPrompts(page);

    const uploader = await waitForUploader(page, options.loginTimeoutMs);

    console.log(`アップロード対象: ${files.join(", ")}`);
    await setFiles(uploader, files);

    if (!options.noSend) {
      const sendResultPromise = waitForSendResult(page, options.successTimeoutMs);
      await clickSend(page);
      await sendResultPromise;
      console.log("Send to Kindle への送信完了を確認しました。");
    } else {
      console.log("--no-send が指定されているため、ファイル指定後で停止しました。");
    }

    if (options.keepOpen) {
      console.log("ブラウザを開いたままにします。終了するときは手動で閉じてください。");
      return;
    }
  } finally {
    if (!options.keepOpen) {
      await context.close();
    }
  }
}

function parseArgs(argv) {
  const options = {
    files: [],
    headless: false,
    profileDir: DEFAULT_PROFILE_DIR,
    loginTimeoutMs: 10 * 60 * 1000,
    successTimeoutMs: 5 * 60 * 1000,
    timeoutMs: 30 * 1000,
    keepOpen: false,
    noSend: false,
    channel: "chrome",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--keep-open":
        options.keepOpen = true;
        break;
      case "--no-send":
        options.noSend = true;
        break;
      case "--profile-dir":
        options.profileDir = path.resolve(expectValue(argv, ++i, arg));
        break;
      case "--login-timeout":
        options.loginTimeoutMs = parseDuration(expectValue(argv, ++i, arg));
        break;
      case "--success-timeout":
        options.successTimeoutMs = parseDuration(expectValue(argv, ++i, arg));
        break;
      case "--timeout":
        options.timeoutMs = parseDuration(expectValue(argv, ++i, arg));
        break;
      case "--channel":
        options.channel = expectValue(argv, ++i, arg);
        break;
      default:
        options.files.push(arg);
        break;
    }
  }

  return options;
}

function expectValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} の値がありません。`);
  }
  return value;
}

function parseDuration(value) {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) {
    throw new Error(`時間指定の形式が不正です: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  return amount * 60 * 1000;
}

function resolveFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
      throw new Error(`ファイルが見つかりません: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`ファイルではありません: ${resolved}`);
    }
    files.push(resolved);
  }
  return files;
}

async function dismissCommonPrompts(page) {
  const buttons = [
    "button:has-text('閉じる')",
    "button:has-text('後で')",
    "button:has-text('閉じる')",
    "button:has-text('Skip')",
  ];

  for (const selector of buttons) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click().catch(() => {});
    }
  }
}

async function waitForUploader(page, loginTimeoutMs) {
  const deadline = Date.now() + loginTimeoutMs;
  let announcedLogin = false;
  let clickedSendToKindleSignIn = false;

  while (Date.now() < deadline) {
    await assertServiceAvailable(page);

    const s2kUploader = await findSendToKindleUploader(page);
    if (s2kUploader) {
      return s2kUploader;
    }

    const input = await findFileInput(page);
    if (input) {
      return input;
    }

    if (await looksLikeLoginPage(page)) {
      if (!announcedLogin) {
        announcedLogin = true;
        console.log("Amazon ログイン待ちです。開いた Chrome でログインと 2 段階認証を完了してください。");
      }
      if (!clickedSendToKindleSignIn) {
        const signInButton = page.locator(S2K_SIGN_IN_BUTTON_SELECTOR).first();
        if (await signInButton.isVisible().catch(() => false)) {
          console.log("Send to Kindle のサインイン画面を開きます。");
          await signInButton.click().catch(() => {});
          clickedSendToKindleSignIn = true;
        }
      }
    } else if (!announcedLogin && (await looksLikeAmazonLoginForm(page))) {
      announcedLogin = true;
      console.log("Amazon ログイン待ちです。開いた Chrome でログインと 2 段階認証を完了してください。");
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("アップロード画面を見つけられませんでした。ログイン状態やページ構成を確認してください。");
}

async function looksLikeLoginPage(page) {
  for (const selector of S2K_SIGN_IN_VIEW_SELECTORS) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return true;
    }
  }
  return looksLikeAmazonLoginForm(page);
}

async function looksLikeAmazonLoginForm(page) {
  const selectors = [
    "#ap_email",
    "#ap_password",
    "input[name='email']",
    "input[name='password']",
    "text=/サインイン/i",
    "text=/Sign in/i",
  ];

  for (const selector of selectors) {
    const locator = selector.startsWith("text=")
      ? page.locator(selector)
      : page.locator(selector);
    if (await locator.first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function findSendToKindleUploader(page) {
  let hasUploaderShell = false;

  for (const selector of S2K_UPLOADER_SELECTORS) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      hasUploaderShell = true;
      break;
    }
  }

  if (!hasUploaderShell) {
    return null;
  }

  return {
    type: "send-to-kindle",
    page,
    addButton: page.locator(S2K_ADD_FILES_BUTTON_SELECTOR).first(),
    dropArea: page.locator(S2K_DROP_AREA_SELECTOR).first(),
  };
}

async function findFileInput(page) {
  for (const scope of scopes(page)) {
    const locator = scope.locator("input[type='file']").first();
    if ((await locator.count()) > 0) {
      return { type: "input", locator };
    }
  }
  return null;
}

function scopes(page) {
  return [page, ...page.frames()];
}

async function setFiles(target, files) {
  if (target.type === "input") {
    await target.locator.setInputFiles(files);
    return;
  }

  if (target.type === "send-to-kindle") {
    await setFilesOnSendToKindle(target, files);
    return;
  }

  throw new Error("未対応のアップロードターゲットです。");
}

async function clickSend(page) {
  const deadline = Date.now() + 2 * 60 * 1000;

  while (Date.now() < deadline) {
    const sendButton = page.locator(S2K_SEND_BUTTON_SELECTOR).first();
    if (await sendButton.isVisible().catch(() => false)) {
      const disabled = await sendButton.isDisabled().catch(() => false);
      if (!disabled) {
        await sendButton.click();
        return;
      }
    }

    for (const scope of scopes(page)) {
      for (const pattern of SEND_BUTTON_PATTERNS) {
        const button = scope.getByRole("button", { name: pattern }).first();
        if (await button.isVisible().catch(() => false)) {
          const disabled = await button.isDisabled().catch(() => false);
          if (!disabled) {
            await button.click();
            return;
          }
        }
      }
    }
    await page.waitForTimeout(1000);
  }

  throw new Error("送信ボタンを見つけられませんでした。画面構成が変わっている可能性があります。");
}

async function setFilesOnSendToKindle(target, files) {
  const input = await waitForFileInput(target.page, 1_000).catch(() => null);
  if (input) {
    await input.setInputFiles(files);
    return;
  }

  if (await target.addButton.isVisible().catch(() => false)) {
    const chooserPromise = target.page
      .waitForEvent("filechooser", { timeout: 5_000 })
      .catch(() => null);

    await target.addButton.click();

    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(files);
      return;
    }

    const dynamicInput = await waitForFileInput(target.page, 5_000).catch(
      () => null
    );
    if (dynamicInput) {
      await dynamicInput.setInputFiles(files);
      return;
    }
  }

  if (await target.dropArea.isVisible().catch(() => false)) {
    await dispatchDropFiles(target.page, target.dropArea, files);
    return;
  }

  throw new Error("Send to Kindle のファイル投入ポイントを見つけられませんでした。");
}

async function waitForFileInput(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const locator = page.locator("input[type='file']").first();
    if ((await locator.count()) > 0) {
      return locator;
    }
    await page.waitForTimeout(200);
  }

  throw new Error("input[type='file'] が見つかりませんでした。");
}

async function dispatchDropFiles(page, dropArea, files) {
  const payloads = files.map((filePath) => ({
    name: path.basename(filePath),
    mimeType: guessMimeType(filePath),
    base64: fs.readFileSync(filePath).toString("base64"),
  }));

  const dataTransfer = await page.evaluateHandle((items) => {
    const transfer = new DataTransfer();

    for (const item of items) {
      const binary = atob(item.base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const file = new File([bytes], item.name, { type: item.mimeType });
      transfer.items.add(file);
    }

    return transfer;
  }, payloads);

  await dropArea.dispatchEvent("dragenter", { dataTransfer });
  await dropArea.dispatchEvent("dragover", { dataTransfer });
  await dropArea.dispatchEvent("drop", { dataTransfer });
}

function guessMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".epub":
      return "application/epub+zip";
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".txt":
      return "text/plain";
    case ".html":
    case ".htm":
      return "text/html";
    case ".rtf":
      return "text/rtf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

async function waitForSendResult(page, successTimeoutMs) {
  const responsePromise = page
    .waitForResponse(
      (response) => response.url().includes("/sendtokindle/send-v2"),
      { timeout: successTimeoutMs }
    )
    .then((response) => {
      if (!response.ok()) {
        throw new Error(
          `Send to Kindle の送信APIが失敗しました: ${response.status()}`
        );
      }
    });

  const successTextPromise = waitForSuccessText(page, successTimeoutMs);

  try {
    await Promise.any([responsePromise, successTextPromise]);
  } catch (error) {
    throw new Error(
      "送信完了を確認できませんでした。サービス状態または画面表示を確認してください。"
    );
  }
}

async function waitForSuccessText(page, successTimeoutMs) {
  const deadline = Date.now() + successTimeoutMs;
  while (Date.now() < deadline) {
    await assertServiceAvailable(page);

    for (const scope of scopes(page)) {
      for (const pattern of SUCCESS_PATTERNS) {
        const text = scope.getByText(pattern).first();
        if (await text.isVisible().catch(() => false)) {
          return;
        }
      }
    }
    await page.waitForTimeout(1000);
  }

  throw new Error("送信完了メッセージを確認できませんでした。手動で画面を確認してください。");
}

async function assertServiceAvailable(page) {
  const banner = page.locator(S2K_MAINTENANCE_BANNER_SELECTOR).first();
  if (!(await banner.isVisible().catch(() => false))) {
    return;
  }

  const text = await banner.innerText().catch(() => "");
  if (S2K_MAINTENANCE_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Send to Kindle 側が利用不可です: ${text.trim()}`);
  }
}

function printHelp() {
  console.log(`使い方:
  npm run send-to-kindle -- <epubファイル>
  node scripts/send_to_kindle.mjs <epubファイル>

例:
  npm run send-to-kindle -- books/2026年4月2日から4月9日までの国内ニューストップ20.epub
  node scripts/send_to_kindle.mjs books/sample.epub --keep-open

主なオプション:
  --profile-dir <dir>       Chrome のログイン状態を保存するディレクトリ
  --login-timeout <time>    ログイン待ち時間。例: 10m, 90s, 30000
  --success-timeout <time>  送信完了待ち時間。例: 5m
  --timeout <time>          通常操作のタイムアウト。例: 30s
  --headless                ヘッドレス実行
  --keep-open               完了後もブラウザを閉じない
  --no-send                 ファイル選択までで停止
  --channel <name>          利用ブラウザ。既定値は chrome

初回利用:
  1. npm install
  2. スクリプトを実行
  3. 開いた Chrome で Amazon にログイン
  4. 以後は保存されたログイン状態を再利用
`);
}

main().catch((error) => {
  console.error("Send to Kindle 自動化に失敗しました。");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
