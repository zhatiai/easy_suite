import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { testToken, testCsrf, testPassword, testUserId } from './runtime';

const origin = 'http://127.0.0.1:8792';
const headers = { Origin: origin, 'X-CSRF-Token': testCsrf };
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'easynote_dev', value: testToken, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
});
async function newNote(page: Page, title: string, content = '') {
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(title);
  await page.getByRole('textbox', { name: '笔记正文' }).fill(content);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
}
async function addNoteTags(page: Page, tags: string[]) {
  await page.getByLabel('添加标签').click();
  const input = page.getByRole('textbox', { name: '搜索或回车新建标签…' });
  for (const tag of tags) {
    await input.fill(tag);
    await input.press('Enter');
  }
}
async function disableOfflineLibrary(page: Page) {
  await page.locator('.account').click();
  const offline = page.getByRole('switch', { name: '离线笔记库' });
  await expect(offline).toHaveAttribute('aria-checked', 'true');
  const refreshed = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/notes' && response.request().method() === 'GET');
  await offline.click();
  await refreshed;
  await expect(offline).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
}
async function openMobileNavigation(page: Page) {
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'EasyNote', exact: true })).toBeVisible();
  return dialog;
}
async function openMobileNoteActions(page: Page) {
  await page.getByRole('button', { name: '更多笔记操作', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '笔记操作', exact: true })).toBeVisible();
  return dialog;
}

test('adds and removes existing tags for the current note', async ({ page }) => {
  const tag = `已有标签-${randomUUID().slice(0, 8)}`;
  const id = randomUUID();
  expect((await page.request.post(`/api/notes/${id}`, {
    headers, data: { title: tag, content: '', tags: [tag], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByLabel('添加标签').click();
  const existingTag = page.getByRole('checkbox', { name: tag });
  await existingTag.check();
  await expect(existingTag).toBeChecked();
  await existingTag.uncheck();
  await expect(existingTag).not.toBeChecked();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
});

test('nested folders create notes, move notes, and keep notes on deletion', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const parent = `项目-${suffix}`;
  const child = `资料-${suffix}`;
  await page.goto('/');
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByRole('textbox', { name: '文件夹名称' }).fill(parent);
  await page.getByRole('button', { name: '保存', exact: true }).click();

  const parentRow = page.locator('.folder-tree-row').filter({ hasText: parent }).first();
  await parentRow.getByLabel('文件夹操作').click();
  await parentRow.getByRole('menuitem', { name: '新建文件夹' }).click();
  await page.getByRole('textbox', { name: '文件夹名称' }).fill(child);
  await expect(page.getByRole('combobox', { name: '上级文件夹' })).toHaveValue(/.+/);
  await page.getByRole('button', { name: '保存', exact: true }).click();

  const childRow = page.locator('.folder-tree-row').filter({ hasText: child }).first();
  await expect(childRow).toBeVisible();
  await parentRow.getByRole('button', { name: '折叠文件夹' }).click();
  await expect(childRow).toBeHidden();
  await page.reload();
  await expect(childRow).toBeHidden();
  await parentRow.getByRole('button', { name: '展开文件夹' }).click();
  await childRow.getByLabel('文件夹操作').click();
  await childRow.getByRole('menuitem', { name: '新建文件', exact: true }).click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(`目录笔记-${suffix}`);
  await page.getByRole('textbox', { name: '笔记正文' }).fill('文件夹正文');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const folderPicker = page.locator('.note-folder-picker');
  await expect(folderPicker.locator('select')).toHaveCount(0);
  await expect(folderPicker.locator('.folder-picker-summary')).toContainText(child);
  await folderPicker.locator('.folder-picker-summary').click();
  const folderPopover = folderPicker.getByRole('menu', { name: '所属文件夹' });
  await expect(folderPopover).toBeVisible();
  await expect(folderPopover.getByRole('menuitemradio')).toContainText(['根目录', parent, child]);
  await page.screenshot({ path: 'test-results/document-folder-picker-context.png' });
  await folderPopover.screenshot({ path: 'test-results/document-folder-picker.png' });
  await page.getByRole('textbox', { name: '笔记标题' }).click();
  await expect(folderPopover).toBeHidden();
  await folderPicker.locator('.folder-picker-summary').click();
  await page.keyboard.press('Escape');
  await expect(folderPopover).toBeHidden();
  await expect(folderPicker.locator('.folder-picker-summary')).toBeFocused();
  await folderPicker.locator('.folder-picker-summary').click();
  await folderPopover.getByRole('menuitemradio', { name: parent, exact: true }).click();
  await expect(folderPopover).toBeHidden();
  await expect(folderPicker.locator('.folder-picker-summary')).toContainText(parent);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();

  await parentRow.getByLabel('文件夹操作').click();
  await parentRow.getByRole('menuitem', { name: '删除文件夹' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(`目录笔记-${suffix}`);
  await expect(folderPicker.locator('.folder-picker-summary')).toContainText('根目录');
});

test('folder actions merge notes and subfolders into another collapsed tree branch', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const childId = randomUUID();
  const deepId = randomUUID();
  const emptyId = randomUUID();
  const source = `来源-${suffix}`;
  const target = `目标-${suffix}`;
  const child = `子目录-${suffix}`;
  const deep = `嵌套目录-${suffix}`;
  const empty = `空目录-${suffix}`;
  const title = `合并笔记-${suffix}`;
  const childTitle = `嵌套笔记-${suffix}`;
  const deepTitle = `深层笔记-${suffix}`;
  const rootTitle = `根目录笔记-${suffix}`;
  const tag = `项目标签-${suffix}`;
  const otherTag = `备用标签-${suffix}`;
  for (const data of [
    { id: sourceId, name: source, parentId: null },
    { id: targetId, name: target, parentId: null },
    { id: childId, name: child, parentId: sourceId },
    { id: deepId, name: deep, parentId: childId },
    { id: emptyId, name: empty, parentId: null },
  ]) expect((await page.request.post('/api/folders', { headers, data })).status()).toBe(201);
  expect((await page.request.post(`/api/notes/${randomUUID()}`, {
    headers,
    data: { title, content: '合并内容', tags: [tag, otherTag], pinned: false, archived: false, folderId: sourceId, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);
  expect((await page.request.post(`/api/notes/${randomUUID()}`, {
    headers,
    data: { title: childTitle, content: '嵌套内容', tags: [], pinned: false, archived: false, folderId: childId, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);
  expect((await page.request.post(`/api/notes/${randomUUID()}`, {
    headers,
    data: { title: deepTitle, content: '深层内容', tags: [], pinned: false, archived: false, folderId: deepId, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);
  expect((await page.request.post(`/api/notes/${randomUUID()}`, {
    headers,
    data: { title: rootTitle, content: '根目录内容', tags: [], pinned: false, archived: false, folderId: null, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);

  await page.setViewportSize({ width: 1447, height: 1087 });
  await page.goto('/');
  const sourceRow = page.locator('.folder-tree-row').filter({ hasText: source }).first();
  await expect(page.locator('.folder-tree-row').filter({ hasText: child })).toBeHidden();
  await sourceRow.getByLabel('文件夹操作').click();
  const folderMenu = sourceRow.getByRole('menu');
  await expect(folderMenu).toBeVisible();
  await page.locator('.explorer-header h1').click();
  await expect(folderMenu).toBeHidden();
  await sourceRow.getByLabel('文件夹操作').click();
  await page.keyboard.press('Escape');
  await expect(folderMenu).toBeHidden();
  await expect(sourceRow.getByLabel('文件夹操作')).toBeFocused();
  await sourceRow.getByLabel('文件夹操作').click();
  await expect(folderMenu.getByRole('menuitem')).toHaveText(['新建文件夹', '新建文件', '删除文件夹', '合并文件到...']);
  await expect(folderMenu.getByRole('menuitem', { name: '重命名文件夹' })).toHaveCount(0);
  const [menuBox, menuTriggerBox] = await Promise.all([folderMenu.boundingBox(), sourceRow.getByLabel('文件夹操作').boundingBox()]);
  expect(menuBox).not.toBeNull();
  expect(menuTriggerBox).not.toBeNull();
  expect(menuBox!.width).toBeGreaterThanOrEqual(183);
  expect(menuBox!.width).toBeLessThanOrEqual(185);
  expect(menuBox!.height).toBeGreaterThanOrEqual(180);
  expect(menuBox!.height).toBeLessThanOrEqual(192);
  expect(Math.abs(menuBox!.x - (menuTriggerBox!.x - 10))).toBeLessThanOrEqual(1);
  expect(menuBox!.y).toBeGreaterThan(menuTriggerBox!.y);
  await page.screenshot({ path: 'test-results/folder-tree-menu-context.png' });
  await folderMenu.screenshot({ path: 'test-results/folder-action-menu.png' });
  await folderMenu.getByRole('menuitem', { name: '合并文件到...' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: '目标文件夹' }).selectOption(targetId);
  await dialog.getByRole('button', { name: '合并', exact: true }).click();
  await expect(sourceRow).toBeHidden();
  await expect(page.getByRole('status')).toContainText(`文件夹“${source}”已合并到“${target}”`);

  const railFolders = page.locator('.folder-nav');
  await expect(railFolders.getByRole('button', { name: new RegExp(target) })).toBeVisible();
  await expect(railFolders.getByRole('button', { name: new RegExp(child) })).toHaveCount(0);
  await railFolders.getByRole('button', { name: new RegExp(target) }).click();
  await expect(page.locator('.explorer-header h1')).toHaveText(target);
  await expect(page.getByRole('button', { name: '全部笔记', exact: true })).not.toHaveClass(/active/);
  await expect(railFolders.getByRole('button', { name: new RegExp(target) })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.folder-tree-row').filter({ hasText: target }).first()).toHaveClass(/active/);
  await expect(page.locator('.folder-tree-row').filter({ hasText: empty })).toHaveCount(0);
  await expect(page.locator('.explorer-note-item').filter({ hasText: rootTitle })).toHaveCount(0);
  const childRow = page.locator('.folder-tree-row').filter({ hasText: child }).first();
  await expect(childRow).toBeVisible();
  await childRow.locator('.folder-tree-select').click();
  await expect(page.locator('.explorer-header h1')).toHaveText(target);
  await expect(page.locator('.folder-tree-row').filter({ hasText: target }).first()).toBeVisible();
  await expect(childRow).toHaveClass(/active/);
  const folderOverview = page.locator('.folder-overview');
  await expect(folderOverview.getByRole('heading', { name: child, exact: true })).toBeVisible();
  await expect(folderOverview).toContainText('创建时间');
  await expect(folderOverview).toContainText('2 个文件');
  await expect(folderOverview.getByText(deep, { exact: true })).toBeVisible();
  const nestedFile = folderOverview.getByRole('button', { name: new RegExp(childTitle) });
  const deepFile = folderOverview.getByRole('button', { name: new RegExp(deepTitle) });
  await expect(nestedFile).toBeVisible();
  await expect(deepFile).toBeVisible();
  await childRow.locator('.folder-tree-select').click();
  await expect(folderOverview.getByRole('heading', { name: child, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(folderOverview).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1447, height: 1087 });
  await deepFile.click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(deepTitle);
  await expect(page.getByRole('button', { name: '预览模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.explorer-header h1')).toHaveText(target);
  const deepRow = page.locator('.folder-tree-row').filter({ hasText: deep }).first();
  await expect(deepRow).toBeVisible();
  await expect(deepRow).toHaveClass(/active/);
  const locatedFile = page.locator('.explorer-note-item').filter({ hasText: deepTitle }).first();
  await expect(locatedFile).toBeVisible();
  await expect(locatedFile.locator('.explorer-note-row')).toHaveClass(/selected/);
  const mergedNote = page.locator('.explorer-note-item').filter({ hasText: title }).first();
  await expect(mergedNote).toBeVisible();
  await expect(mergedNote.locator('.note-row-meta')).toBeVisible();
  await expect(mergedNote.locator('.note-row-meta')).toContainText(/修订 \d+/);
  await page.locator('.navigation-rail').screenshot({ path: 'test-results/navigation-real-folders.png' });

  await expect(page.getByRole('status')).toBeHidden({ timeout: 6_000 });
  const noteActionTrigger = mergedNote.getByLabel('更多笔记操作');
  const triggerBox = await noteActionTrigger.boundingBox();
  await noteActionTrigger.click();
  const noteActions = page.getByRole('menu', { name: '笔记操作' });
  await expect(noteActions).toBeVisible();
  await expect(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '笔记操作' }) })).toHaveCount(0);
  const visibleActions = noteActions.getByRole('menuitem');
  expect(await visibleActions.count()).toBeGreaterThan(1);
  const [noteMenuBox, firstActionBox, secondActionBox] = await Promise.all([noteActions.boundingBox(), visibleActions.nth(0).boundingBox(), visibleActions.nth(1).boundingBox()]);
  expect(triggerBox).not.toBeNull();
  expect(noteMenuBox).not.toBeNull();
  expect(firstActionBox).not.toBeNull();
  expect(secondActionBox).not.toBeNull();
  expect(Math.abs(noteMenuBox!.x - (triggerBox!.x - 8))).toBeLessThanOrEqual(1);
  expect(noteMenuBox!.y).toBeGreaterThan(triggerBox!.y);
  expect(Math.abs(firstActionBox!.x - secondActionBox!.x)).toBeLessThanOrEqual(1);
  expect(secondActionBox!.y).toBeGreaterThan(firstActionBox!.y + firstActionBox!.height - 1);
  await page.screenshot({ path: 'test-results/note-actions-context.png' });
  await noteActions.screenshot({ path: 'test-results/note-actions-vertical.png' });
  await page.locator('.explorer-header h1').click();
  await expect(noteActions).toBeHidden();

  const tagRow = page.locator('.tag-navigation-row').filter({ hasText: tag });
  await tagRow.locator('.tag-navigation-select').click();
  await expect(tagRow.locator('.tag-navigation-select')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '全部笔记', exact: true })).not.toHaveClass(/active/);
  await expect(page.locator('.folder-tree-row')).toHaveCount(0);
  await expect(page.locator('.explorer-note-item').filter({ hasText: title })).toBeVisible();
  await expect(page.locator('.active-tag-heading .view-heading-context')).toHaveText('全部笔记 · 标签');
  await expect(page.locator('.active-tag-heading-name')).toHaveText(tag);
  await tagRow.getByLabel('标签操作').click();
  const tagMenu = tagRow.getByRole('menu');
  await expect(tagMenu.getByRole('menuitem')).toHaveText(['重命名', '合并至', '删除', '设置颜色']);
  await tagMenu.getByRole('menuitem', { name: '重命名' }).click();
  let tagActionDialog = page.getByRole('dialog');
  await expect(tagActionDialog.getByRole('heading', { name: '重命名标签' })).toBeVisible();
  await expect(tagActionDialog.getByRole('heading', { name: '管理标签' })).toHaveCount(0);
  await tagActionDialog.screenshot({ path: 'test-results/tag-rename-dialog.png' });
  await tagActionDialog.getByRole('button', { name: '取消' }).click();
  await tagRow.getByLabel('标签操作').click();
  await tagMenu.getByRole('menuitem', { name: '合并至' }).click();
  tagActionDialog = page.getByRole('dialog');
  await expect(tagActionDialog.getByRole('heading', { name: '合并标签' })).toBeVisible();
  await expect(tagActionDialog.getByRole('combobox', { name: '合并至' })).toHaveValue(otherTag);
  await tagActionDialog.screenshot({ path: 'test-results/tag-merge-dialog.png' });
  await tagActionDialog.getByRole('button', { name: '取消' }).click();
  await tagRow.getByLabel('标签操作').click();
  await tagMenu.getByRole('menuitem', { name: '删除' }).click();
  tagActionDialog = page.getByRole('dialog');
  await expect(tagActionDialog.getByRole('heading', { name: '删除标签' })).toBeVisible();
  await expect(tagActionDialog).toContainText('笔记本身不会被删除');
  await tagActionDialog.screenshot({ path: 'test-results/tag-delete-dialog.png' });
  await tagActionDialog.getByRole('button', { name: '取消' }).click();
  await tagRow.getByLabel('标签操作').click();
  await tagMenu.getByRole('menuitem', { name: '设置颜色' }).click();
  await page.screenshot({ path: 'test-results/tag-action-menu-context.png' });
  await tagMenu.screenshot({ path: 'test-results/tag-action-menu.png' });
  await tagMenu.getByRole('button', { name: '设置颜色 5' }).click();
  await expect(tagRow.locator('.tag-color-dot')).toHaveClass(/tag-color-4/);
  await page.reload();
  await expect(page.locator('.tag-navigation-row').filter({ hasText: tag }).locator('.tag-color-dot')).toHaveClass(/tag-color-4/);
  await page.locator('.tag-navigation-row').filter({ hasText: tag }).locator('.tag-navigation-select').click();
  await page.locator('.notebook-explorer').screenshot({ path: 'test-results/tag-files-only.png' });

  await page.locator('.explorer-note-item').filter({ hasText: title }).click();
  await page.getByLabel('添加标签').click();
  const editorTagPicker = page.getByRole('group', { name: '选择或创建标签' });
  await expect(editorTagPicker).toBeVisible();
  await page.screenshot({ path: 'test-results/editor-tag-picker-context.png' });
  await editorTagPicker.screenshot({ path: 'test-results/editor-tag-picker.png' });
  await page.locator('.note-title').click();
  await expect(editorTagPicker).toBeHidden();

  await page.getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(page.getByRole('button', { name: '全部笔记', exact: true })).toHaveAttribute('aria-current', 'page');
  const targetRow = page.locator('.folder-tree-row').filter({ hasText: target }).first();
  await expect(targetRow.getByRole('button', { name: '折叠文件夹' })).toBeVisible();
  await expect(page.locator('.explorer-note-item').filter({ hasText: title })).toBeVisible();

  const emptyRow = page.locator('.folder-tree-row').filter({ hasText: empty }).first();
  await emptyRow.getByRole('button', { name: '展开文件夹' }).click();
  const emptyLabel = page.locator('.explorer-empty-label').filter({ hasText: '暂无笔记' });
  await expect(emptyLabel).toBeVisible();
  const [emptyBox, fileNameBox] = await Promise.all([
    emptyLabel.boundingBox(),
    page.locator('.explorer-note-item').filter({ hasText: title }).first().locator('.explorer-note-copy').boundingBox(),
  ]);
  expect(emptyBox).not.toBeNull();
  expect(fileNameBox).not.toBeNull();
  expect(Math.abs(emptyBox!.x - fileNameBox!.x)).toBeLessThanOrEqual(1);
  await page.locator('.notebook-explorer').screenshot({ path: 'test-results/folder-tree-alignment.png' });

  await page.setViewportSize({ width: 1900, height: 1080 });
  await page.locator('.notebook-explorer').screenshot({ path: 'test-results/folder-tree-wide.png' });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.screenshot({ path: 'test-results/folder-tree-constrained.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await targetRow.getByLabel('文件夹操作').click();
  await page.locator('.notebook-explorer').screenshot({ path: 'test-results/folder-tree-mobile.png' });
});

test('light background variants persist independently from dark appearance', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  const background = page.getByRole('combobox', { name: '浅色背景' });
  await background.selectOption('white');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'white');
  await background.selectOption('warm');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm');
});

test('switches to English without mobile horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('does not render the login form while the initial session is loading', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let delayed = true;
  await page.route('**/api/session', async (route) => {
    if (!delayed) { await route.continue(); return; }
    delayed = false;
    await gate;
    await route.continue();
  });
  const navigation = page.goto('/');
  await expect(page.getByRole('status')).toContainText('正在连接');
  await expect(page.getByRole('textbox', { name: '用户名' })).toBeHidden();
  release();
  await navigation;
  await expect(page.getByRole('main').getByRole('button', { name: '新建笔记', exact: true })).toBeVisible();
});

test('cached startup remains usable while session verification and text sync are delayed', async ({ page }) => {
  await page.goto('/');
  const title = `启动缓存-${randomUUID()}`;
  await newNote(page, title, '本地正文');
  let releaseSession!: () => void;
  let releaseSync!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  let sessions = 0;
  let syncStarted = false;
  await page.route('**/api/session', async (route) => {
    sessions++;
    await sessionGate;
    await route.continue();
  });
  await page.route('**/api/sync?*', async (route) => {
    syncStarted = true;
    await syncGate;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.locator('[data-note-row]').filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('.document .markdown')).toContainText('本地正文');
    await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
    expect(sessions).toBe(1);
    expect(syncStarted).toBe(false);
    await page.getByRole('button', { name: '编辑模式', exact: true }).click();
    await page.getByRole('textbox', { name: '笔记标题' }).fill(`${title}-修改`);
    releaseSession();
    await expect.poll(() => syncStarted).toBe(true);
    await expect(row).toBeVisible();
    releaseSync();
    await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
    expect(sessions).toBe(1);
  } finally { releaseSession(); releaseSync(); }
});

for (const switched of [false, true]) {
  test(`cached startup clears the old account after ${switched ? 'account switching' : 'session expiration'}`, async ({ page }) => {
    await page.goto('/');
    const title = `旧账号-${randomUUID()}`;
    await newNote(page, title, '旧账号正文');
    const session = await (await page.request.get('/api/session')).json();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/session', async (route) => {
      await gate;
      await route.fulfill({ json: {
        ...session, user: switched ? { ...session.user, id: randomUUID(), username: '切换账号' } : null,
        csrf: switched ? session.csrf : null,
      } });
    });
    // The replacement account must never receive the previous account's notes.
    await page.route('**/api/sync?*', (route) => route.fulfill({ json: { changes: [], cursor: 0, hasMore: false } }));
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const row = page.locator('[data-note-row]').filter({ hasText: title });
      await expect(row).toBeVisible();
      release();
      await expect(row).toBeHidden();
      if (!switched) await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(async (userId) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open('easynote');
          request.onsuccess = () => resolve(request.result);
        });
        try {
          return await new Promise<boolean>((resolve) => {
            const request = db.transaction('meta').objectStore('meta').get(`session:${userId}`);
            request.onsuccess = () => resolve(request.result === undefined);
          });
        } finally { db.close(); }
      }, testUserId)).toBe(true);
    } finally { release(); }
  });
}

for (const cancel of [false, true]) {
  test(`first text sync renders notes while attachment caching ${cancel ? 'is cancelled' : 'is delayed'}`, async ({ page }) => {
    const id = randomUUID();
    const fileId = randomUUID();
    const title = `慢附件-${id}`;
    const uploaded = await page.request.put(`/api/files/${fileId}`, {
      headers: { ...headers, 'Content-Type': 'text/plain', 'X-Filename': 'slow.txt' }, data: '附件正文',
    });
    expect(uploaded.status()).toBe(201);
    expect((await page.request.post(`/api/notes/${id}`, {
      headers, data: { title, content: `[附件](/api/files/${fileId})`, tags: [], pinned: false,
        archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
    })).status()).toBe(201);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let downloading = false;
    await page.route(`**/api/files/${fileId}`, async (route) => {
      downloading = true;
      await gate;
      await route.continue();
    });
    try {
      await page.goto('/');
      await expect.poll(() => downloading).toBe(true);
      const row = page.locator('[data-note-row]').filter({ hasText: title });
      await expect(row).toBeVisible();
      await row.click();
      await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
      if (cancel) {
        await disableOfflineLibrary(page);
        release();
        await expect.poll(() => page.evaluate(async (key) => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open('easynote');
            request.onsuccess = () => resolve(request.result);
          });
          try {
            return await new Promise<boolean>((resolve) => {
              const request = db.transaction('files').objectStore('files').get(key);
              request.onsuccess = () => resolve(request.result === undefined);
            });
          } finally { db.close(); }
        }, `${testUserId}:${fileId}`)).toBe(true);
      } else {
        const downloaded = page.waitForResponse((response) => response.url().endsWith(`/api/files/${fileId}`));
        release();
        await downloaded;
      }
    } finally { release(); }
  });
}

test('PWA metadata, install action, app-shell cache and API exclusion work', async ({ page, context }) => {
  await page.goto('/');
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '180x180');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toContain('manifest+json');
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: 'EasyNote', start_url: '/', scope: '/', display: 'standalone',
    theme_color: '#f9f9f9', background_color: '#f9f9f9',
  });
  expect(manifest).not.toHaveProperty('share_target');
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: '192x192', type: 'image/png', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', type: 'image/png', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
  ]));
  for (const path of ['/pwa-192x192.png', '/pwa-512x512.png', '/pwa-maskable-512x512.png', '/apple-touch-icon.png']) {
    const icon = await page.request.get(path);
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('image/png');
  }
  const worker = await page.request.get('/sw.js');
  expect(worker.status()).toBe(200);
  expect(worker.headers()['content-type']).toContain('javascript');
  expect(await worker.text()).toContain('easynote-pdf-v1');
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration('/')))).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cachedUrls.some((url) => new URL(url).pathname === '/index.html')).toBe(true);
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);

  await page.evaluate(() => {
    const state = window as typeof window & { installPrompted?: boolean };
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt(): Promise<void>;
      userChoice: Promise<{ outcome: 'accepted'; platform: string }>;
    };
    event.prompt = async () => { state.installPrompted = true; };
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);
  });
  await page.locator('.account').click();
  await page.getByRole('button', { name: '安装 EasyNote' }).click();
  expect(await page.evaluate(() => (window as typeof window & { installPrompted?: boolean }).installPrompted)).toBe(true);
  await expect(page.getByRole('button', { name: '安装 EasyNote' })).toBeHidden();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.app-shell')).toBeVisible();
  await context.setOffline(false);
});

test('offline library is enabled by default and an explicit opt-out persists', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  const offline = page.getByRole('switch', { name: '离线笔记库' });
  await expect(offline).toHaveAttribute('aria-checked', 'true');
  await offline.click();
  await expect(offline).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.reload();
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'false');
});

test('task center opens the source note at the unfinished task', async ({ page }) => {
  const title = `任务中心-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '开头\n\n- [x] 已完成\n- [ ] 精准定位\n\n结尾');
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('精准定位', { exact: true })).toBeVisible();
  await dialog.getByRole('button').filter({ hasText: '精准定位' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('定位：');
  await expect.poll(() => editor.locator('.cm-line').allTextContents()).toContain('定位：- [ ] 精准定位');
});

test('mobile note list exposes the task center and opens a task source', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `移动任务-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '开头\n\n- [ ] 移动端待办\n\n结尾');
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  const navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '任务中心', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('移动端待办', { exact: true })).toBeVisible();
  const task = dialog.getByRole('button').filter({ hasText: '移动端待办' });
  const alignment = await task.evaluate((button) => {
    const copy = button.querySelector<HTMLElement>('.task-center-copy')!;
    const arrow = button.querySelector<SVGElement>('svg')!;
    const buttonBox = button.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const arrowBox = arrow.getBoundingClientRect();
    return {
      leftGap: copyBox.left - buttonBox.left,
      rightGap: buttonBox.right - arrowBox.right,
      copyWidth: copyBox.width,
    };
  });
  expect(alignment.leftGap).toBeLessThan(16);
  expect(alignment.rightGap).toBeLessThan(16);
  expect(alignment.copyWidth).toBeGreaterThan(200);
  await dialog.screenshot({ path: 'test-results/mobile-task-center.png' });
  await task.click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a note share can be created, extended and cancelled from share management', async ({ page, browser }) => {
  await page.addInitScript(() => {
    let copiedText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => { copiedText = value; },
        readText: async () => copiedText,
      },
    });
  });
  const title = `安全分享-${randomUUID().slice(0, 6)}`;
  const bottomMarker = `分享页尾-${randomUUID().slice(0, 6)}`;
  const content = ['公开正文', ...Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段内容`), bottomMarker].join('\n\n');
  await page.goto('/');
  await newNote(page, title, content);
  expect(await page.getByRole('navigation', { name: '笔记分类' }).getByRole('button').allTextContents())
    .toEqual(['全部笔记', '小记', '任务中心', '归档', '分享', '回收站']);
  await page.getByRole('button', { name: '只读分享', exact: true }).click();
  await expect(page.getByLabel('有效期').locator('option[value="permanent"]')).toHaveText('永久');
  await page.getByLabel('有效期').selectOption('24');
  await page.getByRole('button', { name: '创建链接' }).click();
  const url = await page.getByLabel('只读分享链接').inputValue();
  expect(url).toMatch(/\/shared\/[a-f0-9]{64}$/);
  const sharingDialog = page.locator('dialog[open]');
  const creationNotice = sharingDialog.locator('.dialog-feedback-anchor > .toast');
  await expect(creationNotice).toHaveText('只读分享链接已创建');
  expect(await creationNotice.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return topmost === element || element.contains(topmost);
  })).toBe(true);
  const copyButton = sharingDialog.locator('.share-url button');
  const inputWidth = await page.getByLabel('只读分享链接').evaluate((element) => element.getBoundingClientRect().width);
  await copyButton.click();
  await expect(copyButton).toHaveText('已复制');
  await expect(copyButton).toHaveClass(/copy-confirmed/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  expect(await page.getByLabel('只读分享链接').evaluate((element) => element.getBoundingClientRect().width)).toBe(inputWidth);
  await expect(page.locator('.toast')).not.toHaveText('分享链接已复制');
  await sharingDialog.screenshot({ path: 'test-results/share-copy-feedback.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await sharingDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await sharingDialog.screenshot({ path: 'test-results/share-copy-feedback-320.png' });

  const anonymous = await browser.newContext({ viewport: { width: 900, height: 500 } });
  const shared = await anonymous.newPage();
  await shared.goto(url);
  await expect(shared.getByRole('heading', { name: title })).toBeVisible();
  await expect(shared.getByText('公开正文', { exact: true })).toBeVisible();
  await expect(shared.getByText('只读分享', { exact: true })).toBeVisible();
  const scroll = shared.locator('.shared-page');
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await scroll.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(shared.getByText(bottomMarker, { exact: true })).toBeVisible();
  await anonymous.close();

  await sharingDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表', exact: true }).click();
  const navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '分享', exact: true }).click();
  const manager = page.getByRole('dialog');
  await expect(manager.getByRole('heading', { name: '分享管理', exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: title, exact: true })).toBeVisible();
  await manager.getByLabel(`${title} 延期时长`).selectOption('24');
  await manager.getByRole('button', { name: `延期 ${title}`, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('分享有效期已延长');
  expect(await manager.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await manager.screenshot({ path: 'test-results/mobile-share-management.png' });
  await manager.getByRole('button', { name: `取消分享 ${title}`, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('分享已取消');
  await expect(manager.getByText('暂无正在分享的笔记', { exact: true })).toBeVisible();
  expect((await page.request.get(url.replace('/shared/', '/api/public/shares/'))).status()).toBe(404);
});

test('dialog errors remain visible above the backdrop on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '管理标签', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const tagName = `错误反馈-${randomUUID().slice(0, 6)}`;
  const input = dialog.getByPlaceholder('输入新标签名称…');
  await input.fill(tagName);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await input.fill(tagName);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  const alert = dialog.locator('.dialog-feedback-anchor > [role="alert"]');
  await expect(alert).toContainText('该标签已存在');
  expect(await alert.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return topmost === element || element.contains(topmost);
  })).toBe(true);

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(alert).toBeVisible();
  await dialog.screenshot({ path: 'test-results/mobile-dialog-error-feedback.png' });
});

test('an external PWA launch restores the session through the same-origin bootstrap request', async ({ page }) => {
  await page.route('https://launcher.example.test/', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<a href="${origin}/">Open EasyNote</a>`,
  }));
  await page.goto('https://launcher.example.test/');
  await page.getByRole('link', { name: 'Open EasyNote' }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator('.account')).toContainText('tester');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeHidden();
});

test('AI integration tokens can be created once, listed and revoked', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByLabel('名称').fill('桌面 AI');
  await page.getByLabel('有效期').selectOption('permanent');
  await page.getByRole('button', { name: '创建令牌' }).click();
  await expect(page.getByText('令牌仅显示一次')).toBeVisible();
  await expect(page.locator('.token-secret code').first()).toHaveText(/^enai_[a-f0-9]{64}$/);
  await expect(page.getByText('桌面 AI', { exact: true })).toBeVisible();
  await expect(page.getByText('读取和写入 · 永久有效', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-ai-access.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-ai-access.png', fullPage: true });
  await page.getByRole('button', { name: '撤销令牌 桌面 AI' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByText('桌面 AI', { exact: true })).toBeHidden();
});

test('administrator user management creates and removes an isolated tenant', async ({ page }) => {
  const username = `ui-user-${randomUUID().slice(0, 7)}`;
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByRole('button', { name: '管理用户', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('tester（当前）', { exact: true })).toBeVisible();
  await dialog.getByLabel('新用户用户名').fill(username);
  await dialog.getByLabel('新用户密码').fill('UI-Managed-Password-482!');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog.getByText(username, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: `删除用户 ${username}` }).click();
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(dialog.getByText(username, { exact: true })).toBeHidden();
});

test('create, autosave, reload, edit Markdown and preview safely', async ({ page }) => {
  const title = `读书记录-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/easynote-icon.svg');
  const icon = await page.request.get('/easynote-icon.svg');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/svg+xml');
  expect(await icon.text()).toContain('fill="#0071e3"');
  await newNote(page, title, '# 本周阅读\n\n记录一些值得留下的想法。\n\n- 保持简单\n- 定期整理\n\n<script>alert(1)</script>');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const automaticHistory = await (await page.request.get(`/api/notes/${listed.notes[0].id}/versions`)).json();
  expect(automaticHistory.versions).toHaveLength(0);
  await page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
  const history = await (await page.request.get(`/api/notes/${listed.notes[0].id}/versions`)).json();
  expect(history.versions).toHaveLength(1);
  await page.reload();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '预览模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '编辑模式', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('本周阅读');
  await page.getByRole('button', { name: '预览模式' }).click();
  await expect(page.getByRole('heading', { name: '本周阅读' })).toBeVisible();
  await expect(page.locator('.markdown script')).toHaveCount(0);
  const documentLayout = () => page.locator('.document').evaluate((element) => {
    const container = element.parentElement!;
    const style = getComputedStyle(container);
    const availableWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const documentBox = element.getBoundingClientRect();
    const containerBox = container.getBoundingClientRect();
    return {
      availableWidth,
      leftGap: documentBox.left - containerBox.left - parseFloat(style.paddingLeft),
      width: documentBox.width,
      widthRatio: documentBox.width / availableWidth,
    };
  });
  const mediumLayout = await documentLayout();
  expect(Math.abs(mediumLayout.leftGap)).toBeLessThanOrEqual(1);
  expect(mediumLayout.widthRatio).toBeCloseTo(1, 2);
  await page.setViewportSize({ width: 2000, height: 960 });
  const readableLayout = await documentLayout();
  expect(Math.abs(readableLayout.leftGap)).toBeLessThanOrEqual(1);
  expect(readableLayout.width).toBeCloseTo(900, 0);
  const normalWorkspace = (await page.locator('#document-workspace').boundingBox())!;
  await page.getByRole('button', { name: '进入全屏' }).click();
  const exitFullscreen = page.getByRole('button', { name: '退出全屏' });
  await expect(exitFullscreen).toHaveAttribute('aria-pressed', 'true');
  await expect(exitFullscreen).toHaveAttribute('aria-controls', 'document-workspace');
  await expect(page.locator('.app-shell')).toHaveClass(/document-focus-mode/);
  await expect(page.locator('#navigation-rail')).toBeHidden();
  await expect(page.locator('#notebook-explorer')).toBeHidden();
  await expect.poll(async () => (await page.locator('#document-workspace').boundingBox())!.width).toBeCloseTo(2000, 0);
  const fullscreenWorkspace = (await page.locator('#document-workspace').boundingBox())!;
  expect(fullscreenWorkspace.width).toBeGreaterThan(normalWorkspace.width + 500);
  const fullscreenLayout = await documentLayout();
  expect(fullscreenLayout.width).toBeCloseTo(1080, 0);
  await page.getByRole('button', { name: '编辑模式', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toBeVisible();
  await page.getByRole('button', { name: '预览模式', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本周阅读' })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-document-fullscreen.png', fullPage: true });
  await exitFullscreen.click();
  await expect(page.getByRole('button', { name: '进入全屏' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.app-shell')).not.toHaveClass(/document-focus-mode/);
  await expect(page.locator('#navigation-rail')).toBeVisible();
  await expect(page.locator('#notebook-explorer')).toBeVisible();
  await expect.poll(async () => (await page.locator('#document-workspace').boundingBox())!.width).toBeCloseTo(normalWorkspace.width, 0);
  const restoredWorkspace = (await page.locator('#document-workspace').boundingBox())!;
  expect(restoredWorkspace.width).toBeCloseTo(normalWorkspace.width, 0);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('notes open in preview and expose live or Markdown editing modes only while editing', async ({ page }) => {
  const title = `编辑模式-${randomUUID().slice(0, 8)}`;
  const id = randomUUID();
  expect((await page.request.post(`/api/notes/${id}`, {
    headers,
    data: {
      title, content: '# 初始内容', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  })).status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '预览模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: '编辑模式选择' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveCount(0);
  await expect(page.locator('.document .markdown').getByRole('heading', { name: '初始内容' })).toBeVisible();

  await page.getByRole('button', { name: '编辑模式', exact: true }).click();
  const modes = page.getByRole('group', { name: '编辑模式选择' });
  await expect(modes).toBeVisible();
  await expect(modes.getByRole('button', { name: '实时渲染' })).toHaveAttribute('aria-pressed', 'true');
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.fill('# 实时更新\n\n这里有 **粗体内容**\n\n正在编辑 *当前段落*\n\n>你好呀');
  await expect(page.locator('.live-markdown-editor')).toBeVisible();
  await expect(page.locator('.live-render-preview')).toHaveCount(0);
  await expect(page.locator('.cm-live-h1')).toHaveText('实时更新');
  await expect(page.locator('.cm-live-strong')).toHaveText('粗体内容');
  await expect(page.locator('.cm-live-h1')).not.toContainText('#');
  await expect(page.locator('.cm-line').filter({ hasText: '正在编辑' })).not.toContainText('*');
  await expect(page.locator('.cm-line').filter({ hasText: '正在编辑' }).locator('.cm-live-emphasis')).toHaveText('当前段落');
  await expect(page.locator('.cm-line').filter({ hasText: '你好呀' })).toHaveText('你好呀');
  const earlierHeading = page.locator('.cm-line').filter({ hasText: '实时更新' });
  await earlierHeading.click();
  await page.keyboard.press('End');
  await page.keyboard.type('补充');
  await expect(earlierHeading).toHaveText('实时更新补充');
  await expect(earlierHeading).not.toContainText('#');
  await page.locator('.cm-line').filter({ hasText: '正在编辑' }).click();
  await expect(earlierHeading).toHaveText('实时更新补充');
  const renderedParagraph = page.locator('.cm-line').filter({ hasText: '正在编辑' });
  const renderedEmphasis = renderedParagraph.locator('.cm-live-emphasis');
  await renderedEmphasis.click();
  await expect(editor).toBeFocused();
  await page.keyboard.type('CLICKED');
  await expect(renderedEmphasis).toContainText('CLICKED');
  await expect(renderedEmphasis).toContainText('当前');
  await expect(renderedEmphasis).toContainText('段落');
  await expect(renderedParagraph).not.toContainText('*');
  await page.screenshot({ path: 'test-results/edit-mode-live-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.live-markdown-editor')).toBeVisible();
  await page.screenshot({ path: 'test-results/edit-mode-live-mobile.png' });

  await modes.getByRole('button', { name: 'MD 语法' }).click();
  await expect(modes.getByRole('button', { name: 'MD 语法' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-live-h1')).toHaveCount(0);
  await expect(editor).toContainText('# 实时更新');
});

test('quick notes publish Markdown, edit rendered text, filter, sort and switch layouts', async ({ page }) => {
  const taggedId = randomUUID();
  const folderId = randomUUID();
  const folderName = `小记归档-${folderId.slice(0, 6)}`;
  expect((await page.request.post('/api/folders', { headers, data: { id: folderId, name: folderName, parentId: null } })).status()).toBe(201);
  expect((await page.request.post(`/api/notes/${taggedId}`, {
    headers,
    data: {
      title: '已有小记', content: `## 已有内容\n\n用于筛选。\n\n${'较长的小记内容。\n\n'.repeat(100)}详情内容末尾`, tags: ['灵感', '操作标签'], pinned: false, quick: true, archived: false,
      folderId: null, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  })).status()).toBe(201);
  expect((await page.request.post(`/api/notes/${randomUUID()}`, {
    headers,
    data: {
      title: '文件夹中的笔记', content: '不应作为小记显示', tags: ['操作标签'], pinned: false, archived: false,
      folderId, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  })).status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button', { name: '小记', exact: true }).click();
  await expect(page.getByRole('main', { name: '小记' })).toBeVisible();
  await page.setViewportSize({ width: 1439, height: 899 });
  await page.screenshot({ path: 'test-results/quick-notes-desktop.png', fullPage: true });
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const newTag = `随手记-${taggedId.slice(0, 6)}`;
  await page.locator('.quick-tag-picker > summary').click();
  await page.getByRole('textbox', { name: '搜索或回车新建标签…' }).fill(newTag);
  await page.getByRole('textbox', { name: '搜索或回车新建标签…' }).press('Enter');
  await expect(page.locator('.quick-tag-picker').getByRole('checkbox', { name: newTag })).toBeChecked();
  await page.locator('.quick-tag-picker > summary').click();
  await editor.fill('# 新的小记\n\n第一段 **实时渲染**\n\n第二段');
  await expect(page.locator('.quick-compose-editor .cm-live-strong')).toHaveText('实时渲染');
  await editor.fill(`# 新的小记\n\n第一段 **实时渲染**\n\n第二段\n\n${'扩展内容\n\n'.repeat(100)}详情内容末尾`);
  await page.locator('.quick-compose-card').screenshot({ path: 'test-results/quick-notes-composer.png' });
  await page.getByRole('button', { name: '插入待办' }).click();
  await page.keyboard.type('稍后整理');
  await expect(page.locator('.quick-compose-editor .cm-line').filter({ hasText: '稍后整理' })).toContainText('☐稍后整理');
  await page.getByRole('button', { name: '小记一下' }).click();
  await expect(page.locator('.quick-note-card').filter({ hasText: '新的小记' })).toBeVisible();
  await expect(page.locator('.quick-note-card').filter({ hasText: '文件夹中的笔记' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '小记一下' })).toBeDisabled();

  await page.locator('.tag-navigation-row').filter({ hasText: newTag }).locator('.tag-navigation-select').click();
  await expect(page.locator('.note-row-title')).toHaveText(/小记-\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}:\d{2}/);
  await page.getByRole('button', { name: '小记', exact: true }).click();

  const createdCard = page.locator('.quick-note-card').filter({ hasText: '新的小记' });
  await expect(createdCard.getByLabel('编辑小记')).toBeHidden();
  await createdCard.hover();
  const editQuickNote = createdCard.getByLabel('编辑小记');
  await expect(editQuickNote).toBeVisible();
  const [createdCardBox, editQuickNoteBox] = await Promise.all([createdCard.boundingBox(), editQuickNote.boundingBox()]);
  expect(createdCardBox).not.toBeNull();
  expect(editQuickNoteBox).not.toBeNull();
  await page.mouse.move(createdCardBox!.x + createdCardBox!.width - 2, editQuickNoteBox!.y + editQuickNoteBox!.height / 2);
  await page.mouse.move(editQuickNoteBox!.x + editQuickNoteBox!.width / 2, editQuickNoteBox!.y + editQuickNoteBox!.height / 2, { steps: 12 });
  await expect(editQuickNote).toBeVisible();
  await createdCard.getByLabel('更多小记操作').click();
  const cardMenu = page.getByRole('menu', { name: '小记操作' });
  await expect(cardMenu.getByRole('menuitem')).toHaveText([
    '置顶', '查看详情', '复制链接', '分享', '移动到文件夹', '添加标签', '归档', '查看历史', '删除',
  ]);
  const menuBox = await cardMenu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y).toBeGreaterThanOrEqual(0);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(899);
  await page.screenshot({ path: 'test-results/quick-notes-card-menu.png', fullPage: true });
  const cardPreview = createdCard.locator('.quick-card-preview');
  expect(await cardPreview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await cardMenu.getByRole('menuitem', { name: '查看详情', exact: true }).click();
  await expect(createdCard).toHaveClass(/expanded/);
  await expect(createdCard).toContainText('详情内容末尾');
  expect(await cardPreview.evaluate((element) => element.scrollHeight === element.clientHeight)).toBe(true);
  await createdCard.getByLabel('更多小记操作').click();
  await cardMenu.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect(createdCard.getByLabel('已置顶')).toBeVisible();
  await createdCard.getByLabel('更多小记操作').click();
  await cardMenu.getByRole('menuitem', { name: '添加标签', exact: true }).click();
  await page.getByRole('group', { name: '选择标签' }).getByRole('menuitem', { name: '操作标签' }).click();
  await expect(createdCard).toContainText('操作标签');
  await createdCard.getByLabel('更多小记操作').click();
  await cardMenu.getByRole('menuitem', { name: '收起详情', exact: true }).click();
  await expect(createdCard).not.toHaveClass(/expanded/);
  await createdCard.click();
  await expect(editor).toContainText('第一段');
  const firstParagraph = page.locator('.quick-compose-editor .cm-line').filter({ hasText: '第一段' });
  await firstParagraph.click({ position: { x: 2, y: 10 } });
  await page.keyboard.type('可点击修改：');
  await page.locator('.quick-compose-editor .cm-line').filter({ hasText: '第二段' }).click();
  await expect(editor).toContainText('可点击修改');
  await page.getByRole('button', { name: '更新小记' }).click();
  await expect(createdCard).toContainText('可点击修改');

  await page.getByLabel('筛选标签').selectOption('灵感');
  await expect(page.locator('.quick-note-card')).toHaveCount(1);
  await expect(page.locator('.quick-note-card')).toContainText('已有内容');
  await page.getByLabel('筛选标签').selectOption('');
  await page.getByLabel('搜索小记').fill('新的小记');
  await expect(page.locator('.quick-note-card')).toHaveCount(1);
  await page.getByLabel('搜索小记').fill('');
  await page.getByRole('button', { name: '卡片视图' }).click();
  await expect(page.locator('.quick-feed')).toHaveClass(/grid/);
  await page.getByLabel('小记排序').selectOption('oldest');
  await page.getByRole('button', { name: '展开编辑器' }).click();
  await expect(page.getByRole('main', { name: '小记' })).toHaveClass(/fullscreen/);
  await expect(page.locator('.quick-notes-header')).toBeHidden();
  await expect(page.locator('.quick-feed-pane')).toBeHidden();
  await expect(page.locator('.quick-compose-editor')).toBeVisible();
  await page.screenshot({ path: 'test-results/quick-notes-fullscreen.png', fullPage: true });
  await page.getByRole('button', { name: '退出全屏' }).click();
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.screenshot({ path: 'test-results/quick-notes-constrained.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenu = page.getByRole('button', { name: '打开导航菜单' });
  await expect(mobileMenu).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/quick-notes-mobile.png', fullPage: true });
  await mobileMenu.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: 'test-results/quick-notes-mobile-menu.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  await page.locator('.quick-notes-body').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: 'test-results/quick-notes-mobile-feed.png', fullPage: true });
  await createdCard.getByLabel('更多小记操作').click();
  await page.getByRole('menuitem', { name: '移动到文件夹', exact: true }).click();
  await page.getByRole('group', { name: '选择文件夹' }).getByRole('menuitem', { name: folderName }).click();
  await expect(createdCard).toHaveCount(0);
});

test('footnotes, lazy code highlighting and precise source switching work', async ({ page }) => {
  const content = [
    '## 起点',
    '',
    '开头段落。',
    '',
    '```javascript',
    'const answer = 42;',
    '```',
    '',
    '## 目标',
    '',
    '精准目标段落[^detail]',
    '',
    '[^detail]: 脚注正文。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, `阅读增强-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '预览模式' }).click();

  const preview = page.locator('.document .markdown');
  await expect(preview.locator('a[data-footnote-ref="1"]')).toHaveText('[1]');
  await expect(preview.locator('[data-footnote-id="1"]')).toContainText('脚注正文。');
  await expect(preview.locator('code[data-code-language="javascript"] .hljs-keyword')).toHaveText('const');
  await expect(preview.locator('code[data-code-language="javascript"] .hljs-number')).toHaveText('42');

  await preview.locator('p[data-source-line]').filter({ hasText: '精准目标段落' }).dblclick();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('定位：');
  await expect.poll(() => editor.locator('.cm-line').allTextContents())
    .toContain('定位：精准目标段落[^detail]');

  await page.keyboard.press('Control+e');
  await expect(page.getByRole('button', { name: '预览模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+e');
  await expect(editor).toBeFocused();
  await page.keyboard.type('继续');
  await expect.poll(() => editor.locator('.cm-line').allTextContents())
    .toContain('定位：继续精准目标段落[^detail]');
});

test('restoring a content version preserves the current pin state', async ({ page }) => {
  const id = randomUUID();
  const title = `版本置顶-${id.slice(0, 6)}`;
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '旧正文', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(), createVersion: true,
    },
  });
  expect(created.status()).toBe(201);
  const updated = await page.request.put(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '新正文', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 1, operationId: randomUUID(), createVersion: false,
    },
  });
  expect(updated.status()).toBe(200);
  const pinned = await page.request.put(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '新正文', tags: [], pinned: true, archived: false,
      deletedAt: null, revision: 2, operationId: randomUUID(), createVersion: false,
    },
  });
  expect(pinned.status()).toBe(200);

  await page.goto('/');
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '取消置顶' })).toBeVisible();
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  const history = page.getByRole('dialog');
  await expect(history.getByText('修订 3', { exact: false })).toBeHidden();
  await history.getByRole('button').filter({ hasText: '修订 1' }).click();
  await history.getByRole('button', { name: '恢复此版本' }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${origin}/api/notes/${id}`);
    return (await response.json()).note;
  }).toMatchObject({ content: '旧正文', pinned: true, revision: 4 });
  const versions = await (await page.request.get(`${origin}/api/notes/${id}/versions`)).json();
  expect(versions.versions.map((version: { revision: number }) => version.revision)).toEqual([3, 1]);
  expect(versions.versions[0].content).toBe('新正文');
});

test('Mermaid flowcharts, mindmaps and sanitized HTML blocks render safely', async ({ page }) => {
  let externalRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'example.com') externalRequests++;
  });
  const example = await readFile(new URL('../examples/mermaid-html-demo.md', import.meta.url), 'utf8');
  const unsafeHtml = [
    '<section style="position:fixed" onclick="window.htmlBlockExecuted=true">',
    '  <h2>安全清洗测试</h2>',
    '  <a href="javascript:alert(1)">危险链接</a>',
    '  <img src="https://example.com/tracker.png" onerror="window.htmlBlockExecuted=true">',
    '  <script>window.htmlBlockExecuted=true</script>',
    '</section>',
  ].join('\n');
  const styledDiagram = [
    '```mermaid',
    'graph TD',
    '  subgraph people[个人及出资方]',
    '    founder([Founder])',
    '  end',
    '  subgraph company[企业架构]',
    '    operator[有限责任公司]',
    '    pool{有限合伙企业}',
    '  end',
    '  founder ==>|出资| pool',
    '  operator -.->|管理| pool',
    '  classDef company fill:#e1f5fe,stroke:#01579b,stroke-width:2px',
    '  classDef pool fill:#ffecb3,stroke:#ff8f00,stroke-width:2px',
    '  class operator company',
    '  class pool pool',
    '```',
  ].join('\n');
  const shapedMindmap = [
    '```mermaid',
    'mindmap',
    '  root((Root))',
    '    square[Square]',
    '    rounded(Rounded)',
    '    circle((Circle))',
    '    bang))Bang((',
    '    cloud)Cloud(',
    '    hexagon{{Hexagon}}',
    '```',
  ].join('\n');
  const content = `${example}\n\n${styledDiagram}\n\n${shapedMindmap}\n\n${unsafeHtml}`;
  await page.goto('/');
  await newNote(page, `图表与HTML-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '预览模式' }).click();

  const diagrams = page.locator('.mermaid-diagram svg');
  await expect(diagrams).toHaveCount(4, { timeout: 15000 });
  const sizes = await diagrams.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height, nodes: element.querySelectorAll('path, rect, circle, text').length };
  }));
  expect(sizes.every((size) => size.width > 80 && size.height > 40 && size.nodes > 2)).toBe(true);
  const scrollMetrics = await page.locator('.mermaid-diagram').evaluateAll((elements) =>
    elements.map((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      svgWidth: element.querySelector('svg')!.getBoundingClientRect().width,
      viewBoxWidth: element.querySelector('svg')!.viewBox.baseVal.width,
    }))
  );
  expect(scrollMetrics.every(({ clientWidth, scrollWidth, svgWidth, viewBoxWidth }) =>
    scrollWidth <= clientWidth + 1
    && Math.abs(svgWidth - Math.min(clientWidth, Math.ceil(viewBoxWidth))) <= 1
  )).toBe(true);
  const mindmapRootAlignment = await diagrams.nth(1).evaluate((svg) => {
    const rootNode = svg.querySelector<SVGGElement>('.mindmap-node.section-root');
    const label = rootNode?.querySelector<SVGGraphicsElement>('text');
    const root = rootNode?.querySelector<SVGGraphicsElement>('.label-container');
    if (!label || !root) return null;
    const labelBox = label.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    return {
      x: Math.abs(labelBox.x + labelBox.width / 2 - (rootBox.x + rootBox.width / 2)),
      y: Math.abs(labelBox.y + labelBox.height / 2 - (rootBox.y + rootBox.height / 2)),
    };
  });
  expect(mindmapRootAlignment).not.toBeNull();
  expect(mindmapRootAlignment!.x).toBeLessThanOrEqual(2);
  expect(mindmapRootAlignment!.y).toBeLessThanOrEqual(2);
  const mindmapLeafAlignments = await diagrams.nth(1).evaluate((svg) =>
    ['Markdown', 'HTML Block'].map((text) => {
      const label = [...svg.querySelectorAll<SVGGraphicsElement>('.mindmap-node text')]
        .find((element) => element.textContent?.trim() === text);
      const node = label?.closest<SVGGElement>('.mindmap-node');
      const shape = node?.querySelector<SVGGraphicsElement>('.node-bkg, .label-container');
      if (!label || !shape) return null;
      const labelBox = label.getBoundingClientRect();
      const shapeBox = shape.getBoundingClientRect();
      return Math.abs(labelBox.x + labelBox.width / 2 - (shapeBox.x + shapeBox.width / 2));
    })
  );
  expect(mindmapLeafAlignments.every((offset) => offset !== null && offset <= 2)).toBe(true);
  const shapedMindmapAnchors = await diagrams.nth(3).evaluate((svg) =>
    [...svg.querySelectorAll<SVGGElement>('.mindmap-node')].map((node) => ({
      label: node.querySelector('text')?.textContent?.trim() ?? '',
      anchor: getComputedStyle(node.querySelector('text')!).textAnchor,
    }))
  );
  expect(shapedMindmapAnchors).toHaveLength(7);
  expect(shapedMindmapAnchors.every(({ label, anchor }) => label && anchor === 'middle')).toBe(true);
  const styled = diagrams.nth(2);
  await expect(styled.locator('.node').first()).toHaveAttribute('data-look', 'classic');
  expect(await styled.locator('.node.company .label-container').evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(225, 245, 254)');
  expect(await styled.locator('.node.pool .label-container').evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(255, 236, 179)');
  expect(await styled.locator('.cluster rect').first().evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(255, 255, 222)');
  expect(await styled.locator('.node').first().evaluate((element) => getComputedStyle(element).filter))
    .toBe('none');
  await expect(page.getByRole('heading', { name: 'HTML Block' })).toBeVisible();
  await expect(page.getByText('这是一段由 HTML 渲染的内容', { exact: false })).toBeVisible();
  const section = page.locator('.markdown section').filter({ hasText: '安全清洗测试' });
  await expect(section).not.toHaveAttribute('style');
  await expect(section).not.toHaveAttribute('onclick');
  await expect(page.locator('.markdown script, .markdown iframe, .markdown form')).toHaveCount(0);
  await expect(page.locator('.markdown img')).toHaveCount(0);
  await expect(page.locator('.blocked-image')).toHaveText('[外部图片未加载]');
  await expect(page.locator('.markdown a').filter({ hasText: '危险链接' })).not.toHaveAttribute('href');
  expect(await page.evaluate(() => Boolean((window as typeof window & { htmlBlockExecuted?: boolean }).htmlBlockExecuted))).toBe(false);
  expect(externalRequests).toBe(0);
  await page.screenshot({ path: 'test-results/desktop-diagrams-html.png', fullPage: true });
  await page.locator('.account').click();
  await page.getByRole('switch', { name: '深色外观' }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.mermaid-diagram svg')).toHaveCount(4, { timeout: 15000 });
  await page.screenshot({ path: 'test-results/desktop-diagrams-dark.png', fullPage: true });
});

test('new note reopens the existing completely blank note', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const first = await (await page.request.get('/api/notes/blank')).json();
  expect(first.note?.id).toBeTruthy();

  await page.reload();
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill('复用空白笔记');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const reused = await (await page.request.get(`/api/notes/${first.note.id}`)).json();
  expect(reused.note.title).toBe('复用空白笔记');
  expect((await (await page.request.get('/api/notes/blank')).json()).note).toBeNull();
});

test('a recovered empty local draft merges into the existing cloud blank note', async ({ page }) => {
  await page.goto('/');
  await disableOfflineLibrary(page);
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() === 'POST') await route.abort();
    else await route.continue();
  });
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await page.unroute('**/api/notes/*');

  const cloudId = randomUUID();
  const created = await page.request.post(`${origin}/api/notes/${cloudId}`, {
    headers,
    data: {
      title: '', content: '', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes/blank')).json()).note.id).toBe(cloudId);
  const draftKeys = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('easynote', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return keys;
  });
  expect(draftKeys).toEqual([]);
});

test('unsaved local draft survives refresh and syncs only after explicit retry', async ({ page }) => {
  await page.goto('/');
  await disableOfflineLibrary(page);
  const title = `草稿恢复-${randomUUID().slice(0, 6)}`;
  await newNote(page, title, '云端版本');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fetch();
      await route.abort('failed');
    }
    else await route.continue();
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('网络失败之后的本地草稿');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/notes/*');
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.locator('.document .markdown')).toContainText('网络失败之后的本地草稿');
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const history = await (await page.request.get(`/api/notes/${listed.notes[0].id}/versions`)).json();
  expect(history.versions).toHaveLength(1);
});

test('non-overlapping edits from two devices merge automatically', async ({ page }) => {
  const title = `自动合并-${randomUUID().slice(0, 6)}`;
  const baseContent = '# 记录\n\n云端段落\n\n保持不变\n\n本机段落\n';
  await page.goto('/');
  await newNote(page, title, baseContent);
  const list = await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`);
  const note = (await list.json()).notes[0];
  await page.getByRole('textbox', { name: '笔记正文' })
    .fill('# 记录\n\n云端段落\n\n保持不变\n\n本机更新的段落\n');
  const remote = await page.request.put(`/api/notes/${note.id}`, {
    headers,
    data: {
      title,
      content: '# 记录\n\n云端更新的段落\n\n保持不变\n\n本机段落\n',
      tags: [],
      pinned: false,
      archived: false,
      deletedAt: null,
      revision: note.revision,
      operationId: randomUUID(),
    },
  });
  expect(remote.status()).toBe(200);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '检测到版本冲突' })).toBeHidden();
  await expect.poll(async () =>
    (await (await page.request.get(`/api/notes/${note.id}`)).json()).note.content,
  ).toBe('# 记录\n\n云端更新的段落\n\n保持不变\n\n本机更新的段落\n');
});

test('overlapping remote edits remain visible and can be preserved as a copy', async ({ page }) => {
  const title = `双端编辑-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '初始内容');
  const list = await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`);
  const note = (await list.json()).notes[0];
  await page.getByRole('textbox', { name: '笔记正文' }).fill('当前设备的内容');
  const remote = await page.request.put(`/api/notes/${note.id}`, {
    headers, data: { title, content: '另一台设备的内容', tags: [], pinned: false, archived: false, deletedAt: null, revision: note.revision, operationId: randomUUID() },
  });
  expect(remote.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '检测到版本冲突' })).toBeVisible();
  const conflict = page.getByRole('dialog');
  await expect(conflict.getByText('当前设备的内容', { exact: true })).toBeVisible();
  await expect(conflict.getByText('另一台设备的内容', { exact: true })).toBeVisible();
  await conflict.screenshot({ path: 'test-results/desktop-conflict-resolution.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-conflict-resolution.png', fullPage: true });
  await conflict.getByRole('button', { name: '另存副本' }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(`${title} (冲突副本)`);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const original = await (await page.request.get(`/api/notes/${note.id}`)).json();
  expect(original.note.content).toBe('另一台设备的内容');
});

test('two clients receive create, trash and purge changes without waiting for polling', async ({ page, browser }) => {
  const otherContext = await browser.newContext();
  await otherContext.addCookies([{
    name: 'easynote_dev',
    value: testToken,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  const other = await otherContext.newPage();
  try {
    const firstSocket = page.waitForEvent('websocket');
    const secondSocket = other.waitForEvent('websocket');
    await Promise.all([page.goto('/'), other.goto('/')]);
    await Promise.all([firstSocket, secondSocket]);

    const title = `实时同步-${randomUUID().slice(0, 6)}`;
    await newNote(page, title, '由第一台设备创建');
    await expect(other.getByRole('button').filter({ hasText: title })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '移入回收站' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '移入回收站' }).click();
    await expect(other.getByRole('button').filter({ hasText: title })).toBeHidden({ timeout: 5000 });

    await other.getByRole('button', { name: '回收站', exact: true }).click();
    await expect(other.getByRole('button').filter({ hasText: title })).toBeVisible();
    const trash = await (await page.request.get(`/api/notes?view=trash&q=${encodeURIComponent(title)}`)).json();
    const purged = await page.request.delete(`${origin}/api/notes/${trash.notes[0].id}`, {
      headers,
      data: { revision: trash.notes[0].revision },
    });
    expect(purged.status()).toBe(200);
    await expect(other.getByRole('button').filter({ hasText: title })).toBeHidden({ timeout: 5000 });
  } finally {
    await otherContext.close();
  }
});

test('images render, export includes bytes, and import creates a readable copy', async ({ page }) => {
  const title = `图片备份-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  const untitledId = randomUUID();
  const untitled = await page.request.post(`${origin}/api/notes/${untitledId}`, {
    headers,
    data: {
      title: '', content: '没有标题的导出笔记', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(untitled.status()).toBe(201);
  await newNote(page, title, '## 工作记录\n\n一张保存在私有空间的图片。');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: '笔记截图.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览模式' }).click();
  await expect(page.locator('.markdown img')).toBeVisible();
  await expect.poll(() => page.locator('.markdown img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: 'test-results/desktop-image.png', fullPage: true });
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}&view=archive`)).json();
    return result.notes.some((note: { title: string }) => note.title === title);
  }).toBe(true);
  await page.locator('.account').click();
  await page.getByText('查看导入格式示例', { exact: true }).click();
  await expect(page.getByText('请选择 EasyNote 导出的完整 ZIP，不要解压后逐个选择笔记文件。', { exact: true })).toBeVisible();
  await expect(page.locator('.import-guide pre').first()).toContainText('示例笔记.md');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"format": "easynote"');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"path": "notes/示例笔记.md"');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"archived": false');
  await page.screenshot({ path: 'test-results/import-guide.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 ZIP' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const archive = unzipSync(new Uint8Array(await readFile(path!)));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']));
  expect(manifest.version).toBe(2);
  expect(manifest.notes.find((entry: { title: string }) => entry.title === title)).toMatchObject({
    path: `notes/${title}.md`,
    pinned: false, archived: true, deletedAt: null,
  });
  expect(manifest.notes.find((entry: { id: string }) => entry.id === untitledId).path)
    .toBe('notes/未命名.md');
  expect(new Set(manifest.notes.map((entry: { path: string }) => entry.path.toLocaleLowerCase('en-US'))).size)
    .toBe(manifest.notes.length);
  await expect(page.getByText('备份已下载', { exact: true })).toBeVisible();
  await page.locator('input[accept=".zip,.md,.markdown,.txt"]').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: await readFile(path!) });
  await expect(page.locator('.toast')).toContainText('未导入：', { timeout: 30000 });
  await expect(page.locator('.toast')).toContainText('笔记已存在');
  const result = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}&view=archive`)).json();
  expect(result.notes.length).toBe(1);

  const standaloneTitle = `正文标题-${randomUUID().slice(0, 6)}`;
  const standaloneContent = `# ${standaloneTitle}\n\n标题来自正文，而不是文件名。`;
  const importInput = page.locator('input[accept=".zip,.md,.markdown,.txt"]');
  const standaloneFile = {
    name: `${randomUUID()}.md`, mimeType: 'text/markdown', buffer: Buffer.from(standaloneContent),
  };
  let duplicateLookups = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/notes/duplicates') duplicateLookups++;
  });
  await importInput.setInputFiles(standaloneFile);
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇笔记');
  expect(duplicateLookups).toBe(1);
  await expect.poll(async () => {
    const notes = await (await page.request.get(`/api/notes?q=${encodeURIComponent(standaloneTitle)}&view=all`)).json();
    return notes.notes.some((note: { title: string }) => note.title === standaloneTitle);
  }).toBe(true);

  await importInput.setInputFiles(standaloneFile);
  await expect(page.locator('.toast')).toHaveText('未导入：1 篇笔记已存在');
  expect(duplicateLookups).toBe(1);
  const duplicates = await (await page.request.get(`/api/notes?q=${encodeURIComponent(standaloneTitle)}&view=all`)).json();
  expect(duplicates.notes.filter((note: { title: string }) => note.title === standaloneTitle)).toHaveLength(1);

  const emptyFile = { name: 'empty.md', mimeType: 'text/markdown', buffer: Buffer.from('') };
  await importInput.setInputFiles(emptyFile);
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇笔记');
  expect(duplicateLookups).toBe(2);
  const blank = await (await page.request.get('/api/notes/blank')).json();
  expect(blank.note?.id).toBeTruthy();
  await importInput.setInputFiles(emptyFile);
  await expect(page.locator('.toast')).toHaveText('未导入：1 篇笔记已存在');
  expect(duplicateLookups).toBe(2);
  expect((await (await page.request.get('/api/notes/blank')).json()).note.id).toBe(blank.note.id);
});

test('generic Obsidian ZIP imports frontmatter and rewrites wiki links', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const linkedTitle = `关联笔记-${marker}`;
  const mainTitle = `入口笔记-${marker}`;
  const archive = zipSync({
    [`Vault/${linkedTitle}.md`]: strToU8(`# ${linkedTitle}\n\n被链接内容`),
    [`Vault/${mainTitle}.md`]: strToU8(`---\ntags: [迁移, Obsidian]\n---\n# ${mainTitle}\n\n参见 [[${linkedTitle}]]`),
  });
  const existingId = randomUUID();
  expect((await page.request.post(`${origin}/api/notes/${existingId}`, {
    headers,
    data: {
      title: linkedTitle, content: `# ${linkedTitle}\n\n被链接内容`, tags: [], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  })).status()).toBe(201);
  await page.goto('/');
  await page.locator('.account').click();
  await page.locator('input[accept=".zip,.md,.markdown,.txt"]').setInputFiles({
    name: 'obsidian.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(archive),
  });
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇，跳过 1 篇重复笔记');
  const linked = (await (await page.request.get(`/api/notes?q=${encodeURIComponent(linkedTitle)}`)).json()).notes
    .find((item: { title: string }) => item.title === linkedTitle);
  const main = (await (await page.request.get(`/api/notes?q=${encodeURIComponent(mainTitle)}`)).json()).notes
    .find((item: { title: string }) => item.title === mainTitle);
  expect(linked.id).toBe(existingId);
  expect(main.tags).toEqual(['迁移', 'Obsidian']);
  const imported = (await (await page.request.get(`/api/notes/${main.id}`)).json()).note;
  expect(imported.content).toContain(`[[${linked.id}|${linkedTitle}]]`);
});

test('mobile navigation, pin, archive, trash and restore remain usable without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const title = `手机笔记-${randomUUID().slice(0, 6)}`;
  await newNote(page, title, '手机上的简短记录');
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.locator('.note-row-meta time').first()).toBeVisible();
  await page.getByRole('button').filter({ hasText: title }).click();
  let actions = await openMobileNoteActions(page);
  const syncVersion = actions.getByRole('button', { name: '同步并更新历史版本', exact: true });
  await expect(syncVersion).toBeVisible();
  expect(await syncVersion.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
  await actions.screenshot({ path: 'test-results/mobile-note-actions.png' });
  await actions.getByRole('button', { name: '置顶', exact: true }).click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '归档', exact: true }).click();
  actions = await openMobileNoteActions(page);
  await expect(actions.getByRole('button', { name: '取消归档', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeHidden();
  let navigation = await openMobileNavigation(page);
  expect(await navigation.getByRole('navigation', { name: '移动端笔记分类' }).getByRole('button').allTextContents())
    .toEqual(['全部笔记', '小记', '任务中心', '归档', '分享', '回收站']);
  await expect(navigation.getByRole('button', { name: '同步全部', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: '同步并保存版本', exact: true })).toHaveCount(0);
  await navigation.screenshot({ path: 'test-results/mobile-navigation.png' });
  await navigation.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('button').filter({ hasText: title }).click();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '取消归档', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeHidden();
  navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '全部笔记', exact: true }).click();
  await page.getByRole('button').filter({ hasText: title }).click();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已移入回收站');
  await expect(page.locator('.trash-banner')).toBeHidden();
  const back = page.getByRole('button', { name: '返回笔记列表' });
  if (await back.isVisible()) await back.click();
  navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '回收站', exact: true }).click();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.locator('.trash-banner').getByText('已移入回收站', { exact: true })).toBeVisible();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '恢复笔记', exact: true }).click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button', { name: '打开导航菜单', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建笔记', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '搜索笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-list.png', fullPage: true });
});

test('pinning reorders the mobile list immediately and search toggles closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const marker = `即时排序-${randomUUID().slice(0, 6)}`;
  const titles = [`${marker}-一`, `${marker}-二`];
  for (const title of titles) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title, content: '用于验证置顶即时重排', tags: [], pinned: false,
        archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button', { name: '搜索笔记', exact: true }).click();
  const search = page.locator('.search-field input[aria-label="搜索笔记"]');
  await search.fill(marker);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(2);
  const originalSecond = await rows.nth(1).locator('.note-row-title span').innerText();

  await rows.nth(1).click();
  let actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '置顶', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(rows.nth(0).locator('.note-row-title span')).toHaveText(originalSecond);

  await rows.nth(0).click();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '取消置顶', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(rows.filter({ hasText: originalSecond }).locator('.note-row-title svg')).toHaveCount(0);

  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await search.blur();
  await expect(search).toBeHidden();
  await expect(search).toHaveValue('');
});

test('mobile list syncs all notes without creating history while note sync creates a version', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `移动同步-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '区分列表同步和单篇笔记同步');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const noteId = listed.notes[0].id;

  await page.getByRole('button', { name: '返回笔记列表' }).click();
  let navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '同步全部', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已同步，内容为最新');
  expect((await (await page.request.get(`/api/notes/${noteId}/versions`)).json()).versions).toHaveLength(0);

  await page.getByRole('button').filter({ hasText: title }).click();
  const actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
  expect((await (await page.request.get(`/api/notes/${noteId}/versions`)).json()).versions).toHaveLength(1);
});

test('mobile bulk selection supports select all and exit while settings owns the version', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const marker = `移动批量-${randomUUID().slice(0, 6)}`;
  for (let index = 0; index < 2; index++) {
    expect((await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title: `${marker}-${index}`,
        content: `测试正文 ${index}`,
        tags: [],
        pinned: false,
        archived: false,
        deletedAt: null,
        revision: 0,
        operationId: randomUUID(),
      },
    })).status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button', { name: '搜索笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(2);
  let navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '批量选择', exact: true }).click();

  const toolbar = page.locator('.bulk-toolbar');
  await toolbar.getByRole('button', { name: '全选', exact: true }).click();
  await expect(toolbar).toContainText('已选 2 篇');
  await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/mobile-bulk-selection.png', fullPage: true });
  await toolbar.getByRole('button', { name: '取消全选', exact: true }).click();
  await expect(toolbar).toContainText('已选 0 篇');
  await toolbar.getByRole('button', { name: '退出批量选择', exact: true }).click();
  await expect(toolbar).toBeHidden();

  navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  const version = page.getByText(/^EasyNote \d+\.\d+\.\d+$/);
  await version.scrollIntoViewIfNeeded();
  await expect(version).toBeVisible();
  await expect(page.locator('.list-footer')).not.toContainText('EasyNote');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-settings-version.png', fullPage: true });
});

test('search highlights title and a matching excerpt from deep in the note', async ({ page }) => {
  const marker = `高亮词-${randomUUID().slice(0, 6)}`;
  const title = `${marker} 标题`;
  const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
    headers,
    data: {
      title,
      content: `${'前置内容'.repeat(60)}![${marker} 图表](https://example.com/chart.png)\n\n正文再次出现 ${marker}`,
      tags: [],
      pinned: false,
      archived: false,
      deletedAt: null,
      revision: 0,
      operationId: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  const row = page.locator('[data-note-row]').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.locator('.note-row-title mark.search-highlight')).toHaveText(marker);
  await expect(row.locator('.note-excerpt mark.search-highlight')).toHaveCount(2);
  await row.click();
  await expect(page.locator('.markdown mark.search-highlight')).toHaveText(marker);
  await page.getByRole('button', { name: '编辑模式', exact: true }).click();
  await expect(page.locator('.cm-search-highlight')).toHaveCount(2);
  await page.getByRole('button', { name: '预览模式' }).click();
  await expect(page.locator('.markdown mark.search-highlight')).toHaveText(marker);
});

test('deleting a note opens its next visible note or returns to all notes', async ({ page }) => {
  const marker = `删除跳转-${randomUUID().slice(0, 6)}`;
  for (let index = 0; index < 3; index++) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title: `${marker}-${index}`,
        content: `正文 ${index}`,
        tags: [],
        pinned: false,
        archived: false,
        deletedAt: null,
        revision: 0,
        operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(3);
  const nextTitle = await rows.nth(2).locator('.note-row-title span').innerText();
  await rows.nth(1).click();
  await page.getByRole('main').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(nextTitle);

  await page.getByRole('main').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部笔记', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('heading', { name: '你的笔记', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toHaveValue('');

  const trashed = (await (await page.request.get(`/api/notes?view=trash&q=${encodeURIComponent(marker)}`)).json()).notes;
  for (const item of trashed as Array<{ id: string; revision: number }>) {
    expect((await page.request.delete(`${origin}/api/notes/${item.id}`, {
      headers,
      data: { revision: item.revision },
    })).status()).toBe(200);
  }
});

test('single and batch deletion persist and appear in trash', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const titles = [`单篇删除-${marker}`, `批量删除一-${marker}`, `批量删除二-${marker}`];
  for (const title of titles) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title, content: `${title}正文`, tags: [], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button').filter({ hasText: titles[0] }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已移入回收站');

  await page.getByRole('button', { name: '全部笔记', exact: true }).click();
  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: titles[1] }).click();
  await page.getByRole('button').filter({ hasText: titles[2] }).click();
  await page.locator('.bulk-toolbar').getByRole('button', { name: '删除', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation.getByRole('heading', { name: '将 2 篇笔记移入回收站？' })).toBeVisible();
  await confirmation.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已将 2 篇笔记移入回收站');

  await page.getByRole('button', { name: '回收站', exact: true }).click();
  for (const title of titles) await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  for (const title of titles) await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  const trash = await (await page.request.get(`/api/notes?view=trash&q=${encodeURIComponent(marker)}`)).json();
  expect(trash.notes.map((item: { title: string }) => item.title).sort()).toEqual([...titles].sort());
  for (const item of trash.notes as Array<{ id: string; revision: number }>) {
    const purged = await page.request.delete(`${origin}/api/notes/${item.id}`, {
      headers,
      data: { revision: item.revision },
    });
    expect(purged.status()).toBe(200);
  }
});

test('all notes in trash can be permanently deleted after confirmation', async ({ page }) => {
  await page.goto('/');
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    const created = await page.request.post(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: `待清空-${index + 1}`, content: '', tags: [], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const trashed = await page.request.put(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: `待清空-${index + 1}`, content: '', tags: [], pinned: false, archived: false,
        deletedAt: Date.now(), revision: 1, operationId: randomUUID(),
      },
    });
    expect(trashed.status()).toBe(200);
  }

  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('button', { name: '全部永久删除', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全部永久删除', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '永久删除全部笔记？' })).toBeVisible();
  await expect(dialog).toContainText('此操作无法撤销');
  await dialog.getByRole('button', { name: '全部永久删除', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已永久删除 2 篇笔记');
  await expect(page.getByText('暂无笔记', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes?view=trash')).json()).notes).toHaveLength(0);
  await page.screenshot({ path: 'test-results/desktop-empty-trash.png', fullPage: true });
});

test('tags are scoped to the current note category and preserve it when selected', async ({ page }) => {
  await page.goto('/');
  const marker = randomUUID().slice(0, 6);
  const title = `归档标签-${marker}`;
  const archiveTag = `归档-${marker}`;
  await newNote(page, title, '用于验证归档标签筛选');
  await addNoteTags(page, [archiveTag, `公共-${marker}`]);
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/notes?view=archive&tag=${encodeURIComponent(archiveTag)}`)).json();
    return result.notes.some((note: { title: string }) => note.title === title);
  }).toBe(true);

  await page.getByRole('button', { name: '归档笔记', exact: true }).click();
  const tagNav = page.getByRole('navigation', { name: '标签' });
  const tagButton = tagNav.locator('.tag-navigation-row').filter({ hasText: archiveTag }).locator('.tag-navigation-select');
  await expect(tagButton).toBeVisible();
  await expect(tagButton.locator('.tag-color-dot')).toHaveAttribute('aria-hidden', 'true');
  await tagButton.click();
  await expect(page.locator('.active-tag-heading .view-heading-context')).toHaveText('归档笔记 · 标签');
  await expect(page.locator('.active-tag-heading-name')).toHaveText(archiveTag);
  const taggedFile = page.locator('.explorer-file-results .explorer-note-item').filter({ hasText: title });
  await expect(taggedFile).toBeVisible();
  await expect(taggedFile.locator('.note-excerpt')).toBeHidden();
  await expect(taggedFile.locator('.note-row-meta')).toBeVisible();
  await expect(taggedFile.locator('.note-row-meta')).toContainText(/修订 \d+/);
  await page.screenshot({ path: 'test-results/desktop-archive-tags.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(taggedFile.locator('.note-excerpt')).toBeHidden();
  await expect(taggedFile.locator('.note-row-meta')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(tagNav.locator('.tag-navigation-row').filter({ hasText: archiveTag })).toBeHidden();
});

test('desktop pane edge controls collapse, persist and restore both side panes', async ({ page }) => {
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.goto('/');
  await newNote(page, '测试', '>你好呀');
  await page.getByRole('button', { name: '预览模式', exact: true }).click();
  const shell = page.locator('.app-shell');
  const workspace = page.locator('.workspace');
  const initialWidth = (await workspace.boundingBox())!.width;
  await page.screenshot({ path: 'test-results/panes-expanded-desktop.png' });
  await page.locator('#navigation-rail').screenshot({ path: 'test-results/panes-expanded-navigation.png' });
  await page.locator('#notebook-explorer').screenshot({ path: 'test-results/panes-expanded-explorer.png' });
  const topLevelNote = page.locator('.explorer-tree:not(.explorer-search-results) > .explorer-note-item').first();
  const noteCardBox = (await topLevelNote.locator('.explorer-note-row').boundingBox())!;
  const noteTitleBox = (await topLevelNote.locator('.note-row-title').boundingBox())!;
  const noteMenuBox = (await topLevelNote.locator('.explorer-row-more').boundingBox())!;
  expect(noteCardBox.height).toBeLessThanOrEqual(68);
  await expect(topLevelNote.locator('.note-excerpt')).toBeHidden();
  expect(noteTitleBox.y).toBeLessThan(noteMenuBox.y + noteMenuBox.height / 2);
  expect(Math.abs(noteCardBox.y + noteCardBox.height / 2 - (noteMenuBox.y + noteMenuBox.height / 2))).toBeLessThanOrEqual(3);

  const collapseNavigation = page.getByRole('button', { name: '收起导航栏', exact: true });
  await expect(collapseNavigation).toHaveAttribute('aria-controls', 'navigation-rail');
  await expect(collapseNavigation).toHaveAttribute('aria-expanded', 'true');
  await collapseNavigation.click();
  const expandNavigation = page.getByRole('button', { name: '展开导航栏', exact: true });
  await expect(expandNavigation).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#navigation-rail')).toBeVisible();
  await expect(page.locator('#navigation-rail')).toHaveClass(/compact-navigation-rail/);
  await expect(page.locator('#navigation-rail').getByRole('button', { name: '搜索笔记' })).toBeVisible();
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBeGreaterThan(initialWidth + 130);
  expect(await page.evaluate(() => localStorage.getItem('easynote-navigation-visible'))).toBe('false');
  await expandNavigation.click();
  await expect(page.locator('#navigation-rail')).not.toHaveClass(/compact-navigation-rail/);
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBeLessThan(initialWidth + 20);

  const expandedWorkspaceWidth = (await workspace.boundingBox())!.width;
  const collapseExplorer = page.getByRole('button', { name: '收起笔记列表', exact: true });
  await expect(collapseExplorer).toHaveAttribute('aria-controls', 'notebook-explorer');
  await expect(collapseExplorer).toHaveAttribute('aria-expanded', 'true');
  await collapseExplorer.click();
  const expandExplorer = page.getByRole('button', { name: '展开笔记列表', exact: true });
  await expect(expandExplorer).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#notebook-explorer')).toBeHidden();
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBeGreaterThan(expandedWorkspaceWidth + 300);
  expect(await page.evaluate(() => localStorage.getItem('easynote-note-list-visible'))).toBe('false');
  await page.getByRole('button', { name: '收起导航栏', exact: true }).click();
  await expect(page.locator('#navigation-rail')).toHaveClass(/compact-navigation-rail/);
  await expect.poll(async () => (await page.locator('#navigation-rail').boundingBox())!.width).toBeCloseTo(88, 0);
  await expect(page.locator('.explorer-divider')).toBeHidden();
  expect((await page.locator('.explorer-divider').boundingBox())!.width).toBe(0);
  expect(await page.locator('.pane-toggle:visible').count()).toBe(1);
  await page.screenshot({ path: 'test-results/panes-collapsed-desktop.png' });
  await page.locator('#navigation-rail').screenshot({ path: 'test-results/panes-collapsed-navigation.png' });
  await page.screenshot({ path: 'test-results/panes-collapsed-boundary.png', clip: { x: 48, y: 0, width: 96, height: 900 } });
  await page.locator('#navigation-rail').getByRole('button', { name: '搜索笔记' }).click();
  await expect(page.locator('#notebook-explorer')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toBeFocused();
  await page.getByRole('button', { name: '收起笔记列表', exact: true }).click();
  await expect(page.locator('#notebook-explorer')).toBeHidden();

  await page.reload();
  await page.getByRole('button', { name: '展开导航栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开笔记列表', exact: true })).toBeVisible();
  await expect(page.locator('#notebook-explorer')).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(shell).toHaveCSS('transition-duration', '0s');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#notebook-explorer')).toBeVisible();
  expect(await page.locator('.pane-toggle:visible').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/panes-collapsed-mobile.png' });
});

test('note list width is adjustable, persistent, and both footers align', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `布局测试-${randomUUID().slice(0, 6)}`, '检查可调整的笔记列表。');
  const list = page.locator('.note-list');
  const separator = page.getByRole('separator', { name: '调整笔记列表宽度' });
  const initial = await list.boundingBox();
  const handle = await separator.boundingBox();
  expect(initial).not.toBeNull();
  expect(handle).not.toBeNull();
  expect(initial!.width).toBeCloseTo(340, 0);
  await expect(separator).toHaveAttribute('aria-valuemin', '220');
  await expect(separator).toHaveAttribute('aria-valuemax', '440');
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 140);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 84, handle!.y + 140, { steps: 5 });
  await page.mouse.up();
  const resized = await list.boundingBox();
  expect(resized!.width).toBeGreaterThan(initial!.width + 70);
  expect(await separator.getAttribute('aria-valuenow')).toBe(String(Math.round(resized!.width)));
  const footers = await page.evaluate(() => {
    const sidebarFooter = document.querySelector('.sidebar-bottom')!.getBoundingClientRect();
    const listFooter = document.querySelector('.list-footer')!.getBoundingClientRect();
    const documentFooter = document.querySelector('.document-footer')!.getBoundingClientRect();
    return {
      sidebarTop: sidebarFooter.top, sidebarHeight: sidebarFooter.height,
      listTop: listFooter.top, documentTop: documentFooter.top,
      listHeight: listFooter.height, documentHeight: documentFooter.height,
    };
  });
  expect(Math.abs(footers.sidebarTop - footers.listTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.listTop - footers.documentTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.sidebarHeight - footers.listHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.listHeight - footers.documentHeight)).toBeLessThanOrEqual(1);
  expect(footers.sidebarHeight).toBeCloseTo(32, 0);
  expect(footers.listHeight).toBeCloseTo(32, 0);
  expect(footers.documentHeight).toBeCloseTo(32, 0);
  await page.screenshot({ path: 'test-results/desktop-resized.png', fullPage: true });
  await page.getByRole('button', { name: '收起导航栏', exact: true }).click();
  expect((await list.boundingBox())!.width).toBeCloseTo(resized!.width, 0);
  await page.reload();
  expect((await list.boundingBox())!.width).toBeCloseTo(resized!.width, 0);
  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '340');
});

test('typing while a save response is delayed preserves the newer draft', async ({ page }) => {
  const title = `连续输入-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '初始正文');
  let release: (() => void) | undefined;
  let reportStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { reportStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() === 'PUT' && first) {
      first = false;
      const result = await route.fetch();
      reportStarted!();
      await delayed;
      await route.fulfill({ response: result });
    } else await route.continue();
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('第一段修改');
  await started;
  await page.getByRole('textbox', { name: '笔记正文' }).fill('请求期间继续输入，完整保留第二段修改');
  release!();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.locator('.document .markdown')).toContainText('完整保留第二段修改');
});

test('a stalled save times out and remains retryable without reloading', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `超时恢复-${randomUUID().slice(0, 6)}`, '已保存内容');
  await page.clock.install();
  await page.evaluate(() => {
    const state = window as typeof window & { stalledPuts: number };
    state.stalledPuts = 0;
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return original(input, init);
      state.stalledPuts++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('等待超时的本地草稿');
  await page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { stalledPuts: number }).stalledPuts)).toBe(1);
  await page.clock.runFor(31_000);
  await expect(page.getByRole('alert')).toContainText('Request timed out after 30 seconds.');
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true })).toBeEnabled();
});

test('incremental polling preserves pagination while refreshing a selected note', async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const targetId = randomUUID();
  const targetTitle = `分页同步-${marker}`;
  for (let index = 0; index < 55; index++) {
    const id = index === 54 ? targetId : randomUUID();
    const response = await page.request.post(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: index === 54 ? targetTitle : `分页填充-${marker}-${index}`,
        content: '初始内容', tags: [], pinned: false, archived: false, deletedAt: null,
        revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto('/');
  await disableOfflineLibrary(page);
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  await expect(page.locator('.note-row')).toHaveCount(50);
  await expect(page.locator('.note-row').first()).toHaveAttribute('aria-label', /.+，.+/);
  await expect(page.locator('.note-row').first().locator('.note-excerpt')).toHaveAttribute('aria-hidden', 'true');
  let loadMore = page.getByRole('button', { name: '加载更多' });
  await loadMore.click();
  await expect(page.locator('.note-row')).toHaveCount(55);
  await expect(loadMore).toBeHidden();
  const loadedRows = await page.locator('.note-row').count();
  await page.getByRole('button').filter({ hasText: targetTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(targetTitle);
  await page.route('**/api/sync?**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Temporary failure.' } }),
  }));
  const failedPoll = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/sync' && response.status() === 503);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await failedPoll;
  await expect(page.getByRole('alert')).toContainText('后台同步失败，将自动重试。');
  await page.unroute('**/api/sync?**');
  const remote = await page.request.put(`${origin}/api/notes/${targetId}`, {
    headers,
    data: {
      title: targetTitle, content: '另一台设备更新后的内容', tags: [], pinned: false, archived: false, deletedAt: null,
      revision: 1, operationId: randomUUID(),
    },
  });
  expect(remote.status()).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.document .markdown')).toContainText('另一台设备更新后的内容');
  expect(await page.locator('.note-row').count()).toBe(loadedRows);
  await expect(page.getByRole('alert')).toBeHidden();
});

test('an expired session returns to login without a page reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await page.route('**/api/sync?**', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Please sign in.' } }),
  }));
  const sync = page.locator('.note-list').getByRole('button', { name: '同步全部', exact: true });
  await sync.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByText('登录已过期，请重新登录。', { exact: true })).toBeVisible();
});

test('a second tab cannot overwrite this browser profile local drafts', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await page.close();
  await other.getByRole('button', { name: '重新打开' }).click();
  await expect(other.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await other.close();
});

test('a second tab can take over the editor lock when clicking reopen', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: '重新打开' }).click();
  await expect(other.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await expect(page.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新打开' }).click();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await expect(other.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await other.close();
});

test('dark theme persists and the narrow mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  const navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: '深色外观' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await newNote(page, '窄屏排版', '深色主题下的笔记');
  await page.screenshot({ path: 'test-results/mobile-dark.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('command palette, cursor-position image insertion and private attachments work', async ({ page }) => {
  const title = `快捷插入-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '开头\n结尾');
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.press('ArrowLeft');
  await editor.press('ArrowLeft');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '光标图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toMatch(/开头\n!\[光标图片\.png\]\(\/api\/images\/[0-9a-f-]{36}\)\n\n结尾/);

  await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles({
    name: '资料.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'),
  });
  await expect(page.getByText('附件已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览模式' }).click();
  await expect(page.getByRole('link', { name: '资料.pdf' })).toHaveAttribute('href', /\/api\/files\/[0-9a-f-]{36}$/);

  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog');
  await expect(palette.getByRole('heading', { name: '快速跳转' })).toBeVisible();
  await palette.getByLabel('快速跳转搜索').fill(title);
  await expect(palette.getByRole('button', { name: title, exact: true })).toBeVisible();
  await palette.getByRole('button', { name: title, exact: true }).click();
  await expect(palette).toBeHidden();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
  await page.keyboard.press('Meta+s');
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
});

test('editing shortcuts and keyboard navigation work without pointer input', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `键盘操作-${randomUUID().slice(0, 6)}`, '格式文本');
  const editor = page.getByRole('textbox', { name: '笔记正文' });

  await editor.press('Meta+a');
  await editor.press('Meta+b');
  await expect(page.locator('.cm-live-strong')).toHaveText('格式文本');
  await expect(editor).not.toContainText('**');
  await editor.press('Meta+b');
  await expect(editor).toContainText('格式文本');
  await expect(page.locator('.cm-live-strong')).toHaveCount(0);
  await expect(editor).not.toContainText('**');
  await editor.press('Meta+a');
  await editor.press('Meta+i');
  await expect(page.locator('.cm-live-emphasis')).toHaveText('格式文本');
  await expect(editor).not.toContainText('*');

  await editor.press('Meta+Enter');
  await expect(page.getByRole('button', { name: '预览模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByRole('button', { name: '编辑模式', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '笔记正文' }).press('Meta+/');
  const shortcuts = page.getByRole('dialog');
  await expect(shortcuts.getByRole('heading', { name: '快捷键' })).toBeVisible();
  await expect(shortcuts).toContainText('Cmd/Ctrl+P');
  await shortcuts.getByRole('button', { name: '关闭' }).click();

  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog');
  const commandSearch = palette.getByLabel('快速跳转搜索');
  await commandSearch.fill('设置');
  await commandSearch.press('ArrowDown');
  await expect(palette.getByRole('button', { name: '打开设置' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(`第二篇-${randomUUID().slice(0, 6)}`);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const rows = page.locator('.note-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await rows.first().focus();
  await rows.first().press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await rows.nth(1).press('Home');
  await expect(rows.first()).toBeFocused();
});

test('Markdown todo items render and persist interactive checkbox changes', async ({ page }) => {
  const title = `待办事项-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '- [] 兼容简写\n- [x] 已完成\n- [ ] 标准待办');
  await page.getByRole('button', { name: '预览模式' }).click();

  const compact = page.getByRole('checkbox', { name: '待办事项：兼容简写' });
  const completed = page.getByRole('checkbox', { name: '待办事项：已完成' });
  const standard = page.getByRole('checkbox', { name: '待办事项：标准待办' });
  await expect(compact).toBeEnabled();
  await expect(compact).not.toBeChecked();
  await expect(completed).toBeChecked();
  await expect(standard).not.toBeChecked();

  await compact.click();
  await completed.click();
  await expect(compact).toBeChecked();
  await expect(completed).not.toBeChecked();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-todo.png', fullPage: true });

  await page.getByRole('button', { name: '编辑模式', exact: true }).click();
  await page.getByRole('group', { name: '编辑模式选择' }).getByRole('button', { name: 'MD 语法' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toContainText('- [x] 兼容简写');
  await expect(editor).toContainText('- [ ] 已完成');
  await expect(editor).toContainText('- [ ] 标准待办');
});

test('desktop export configures and downloads a structured PDF', async ({ page }) => {
  const title = `PDF/导出:${randomUUID().slice(0, 6)}`;
  const content = [
    '## 打印正文',
    '',
    '包含图表和私有图片。',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[准备] --> B[导出]',
    '```',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  await addNoteTags(page, ['打印', '测试']);
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '打印图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出当前笔记为 PDF' })).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & { desktopShareCalled?: boolean };
    state.desktopShareCalled = false;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => { state.desktopShareCalled = true; },
    });
  });
  await page.getByRole('textbox', { name: '笔记标题' }).press('Meta+p');
  const exportDialog = page.getByRole('dialog');
  await expect(exportDialog.getByRole('heading', { name: '导出为 PDF' })).toBeVisible();
  await expect(exportDialog.getByLabel('PDF 文件名')).toHaveValue(title);
  await expect(exportDialog.getByLabel('PDF 纸张')).toHaveValue('A4');
  await expect(exportDialog.getByLabel('PDF 缩放')).toHaveValue('100');
  const preview = exportDialog.getByRole('region', { name: 'PDF 分页预览' });
  await expect(preview.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  const portraitPreview = await preview.getByRole('img', { name: 'PDF 第 1 页' }).getAttribute('src');
  await exportDialog.getByRole('button', { name: '横向' }).click();
  await expect(preview).toHaveAttribute('aria-busy', 'true');
  await expect(preview).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
  await expect(preview.getByRole('img', { name: 'PDF 第 1 页' })).not.toHaveAttribute('src', portraitPreview!);
  await exportDialog.getByLabel('PDF 文件名').fill('重命名后的导出文件');
  const template = page.locator('.print-document');
  await expect(template).toContainText('包含图表和私有图片。');
  await expect(template).not.toContainText(title);
  await expect(template).not.toContainText('更新于');
  await expect(template).not.toContainText('#打印');
  await expect(template).not.toContainText(origin);
  await expect(template.locator('.mermaid-diagram svg')).toHaveCount(1);
  expect(await template.locator('img').evaluateAll((images: HTMLImageElement[]) =>
    images.length === 1 && images.every((item) => item.complete && item.naturalWidth > 0))).toBe(true);
  expect(await page.title()).toBe('EasyNote');
  await page.screenshot({ path: 'test-results/desktop-pdf-export.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '导出 PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('重命名后的导出文件.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const pdfBytes = await readFile(path!);
  expect(pdfBytes.subarray(0, 4).toString()).toBe('%PDF');
  expect(new TextDecoder('latin1').decode(pdfBytes)).toContain('/FontFile');
  expect(await page.evaluate(() =>
    (window as typeof window & { desktopShareCalled?: boolean }).desktopShareCalled)).toBe(false);
  await expect(exportDialog).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('PDF 已下载');
});

test('mobile browsers receive a real PDF through share or download', async ({ page }) => {
  const title = `移动/PDF:${randomUUID().slice(0, 6)}`;
  const content = [
    '## 移动端导出',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[iOS] --> C[PDF]',
    '  B[Android] --> C',
    '```',
    '',
    ...Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 段内容用于验证移动端 PDF 分页不会截断长笔记。`),
  ].join('\n\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await newNote(page, title, content);
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '移动端图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & {
      mobileShare?: { name: string; type: string; size: number; header: string };
      printCalls?: number;
    };
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    });
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { mobile: true },
    });
    state.printCalls = 0;
    window.print = () => { state.printCalls = (state.printCalls ?? 0) + 1; };
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: ({ files }: ShareData) => files?.[0]?.type === 'application/pdf',
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }: ShareData) => {
        const file = files![0];
        state.mobileShare = {
          name: file.name,
          type: file.type,
          size: file.size,
          header: await file.slice(0, 4).text(),
        };
      },
    });
  });

  const actions = await openMobileNoteActions(page);
  const exportButton = actions.locator('.mobile-pdf-action');
  await expect(exportButton).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await exportButton.click();
  const exportDialog = page.getByRole('dialog');
  await expect(exportDialog.getByRole('heading', { name: '导出为 PDF' })).toBeVisible();
  const preview = exportDialog.getByRole('region', { name: 'PDF 分页预览' });
  await expect(preview.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  expect(await preview.getByRole('img').count()).toBeGreaterThan(1);
  await page.screenshot({ path: 'test-results/mobile-pdf-export.png', fullPage: true });
  await exportDialog.getByRole('button', { name: '导出 PDF' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { mobileShare?: unknown }).mobileShare)).toBeTruthy();
  const shared = await page.evaluate(() =>
    (window as typeof window & { mobileShare?: { name: string; type: string; size: number; header: string } }).mobileShare);
  expect(shared).toMatchObject({
    name: expect.stringMatching(/^移动-PDF-.+\.pdf$/),
    type: 'application/pdf',
    header: '%PDF',
  });
  expect(shared!.size).toBeGreaterThan(1_000);
  expect(await page.evaluate(() => (window as typeof window & { printCalls?: number }).printCalls)).toBe(0);
  await expect(page.getByRole('status')).toHaveText('PDF 已交给系统保存');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  const fallbackActions = await openMobileNoteActions(page);
  await fallbackActions.locator('.mobile-pdf-action').click();
  await expect(page.getByRole('heading', { name: '导出为 PDF' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'PDF 分页预览' })
    .getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^移动-PDF-.+\.pdf$/);
  await download.saveAs('test-results/mobile-note.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const pdfBytes = await readFile(path!);
  expect(pdfBytes.subarray(0, 4).toString()).toBe('%PDF');
  const pdfSource = new TextDecoder('latin1').decode(pdfBytes);
  const pageCount = pdfSource.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  const imageCount = pdfSource.match(/\/Subtype\s*\/Image\b/g)?.length ?? 0;
  expect(pageCount).toBeGreaterThan(1);
  expect(pdfSource).toContain('/FontFile');
  expect(imageCount).toBeLessThanOrEqual(3);
});

test('outline, stable internal links and backlinks navigate between notes', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const targetTitle = `知识目标-${marker}`;
  const sourceTitle = `知识来源-${marker}`;
  const targetId = randomUUID();
  await page.goto('/');
  const created = await page.request.post(`${origin}/api/notes/${targetId}`, {
    headers,
    data: {
      title: targetTitle, content: '## 目标章节\n\n目标内容', tags: [], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await newNote(page, sourceTitle, '## 来源章节\n\n引用目标');
  await page.getByRole('button', { name: '大纲与反向链接' }).click();
  const panel = page.getByRole('complementary', { name: '笔记导航' });
  await expect(panel.getByRole('button', { name: '来源章节' })).toBeVisible();

  await page.getByRole('button', { name: '插入内部链接' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByLabel('搜索链接目标').fill(targetTitle);
  await picker.getByRole('button', { name: targetTitle, exact: true }).click();
  await expect(page.locator('.cm-live-link')).toHaveText(targetTitle);
  await expect(page.getByRole('textbox', { name: '笔记正文' })).not.toContainText('[[');
  await page.getByRole('group', { name: '编辑模式选择' }).getByRole('button', { name: 'MD 语法' }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText(/\[\[[0-9a-f-]{36}\|知识目标-/);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览模式' }).click();
  await page.getByRole('link', { name: targetTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(targetTitle);
  await expect(panel.getByRole('button', { name: sourceTitle, exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-knowledge-navigation.png', fullPage: true });
});

test('offline library opens a cached note before remote revalidation finishes', async ({ page }) => {
  const marker = randomUUID().slice(0, 7);
  const id = randomUUID();
  const title = `本地优先-${marker}`;
  const content = `无需等待网络-${marker}`;
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content, tags: [], pinned: false, archived: false, deletedAt: null,
      revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  let release!: () => void;
  const remoteResponse = new Promise<void>((resolve) => { release = resolve; });
  let revalidating = false;
  await page.route(`**/api/notes/${id}`, async (route) => {
    revalidating = true;
    await remoteResponse;
    await route.continue();
  });

  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title, { timeout: 1000 });
  await expect(page.locator('.document .markdown')).toContainText(content);
  expect(revalidating).toBe(true);
  const revalidated = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${id}`));
  release();
  await revalidated;
  await page.unroute(`**/api/notes/${id}`);
});

test('full offline library supports cold start, full-text search and note reading', async ({ page, context }) => {
  const marker = randomUUID().slice(0, 7);
  const title = `离线笔记-${marker}`;
  await page.goto('/');
  await newNote(page, title, `只有离线镜像中存在的检索词-${marker}`);
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '离线图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    const paths = urls.map((url) => new URL(url).pathname);
    return {
      pdfmake: paths.some((path) => path.includes('/assets/pdfmake')),
      pdfjs: paths.some((path) => path.includes('/assets/pdfjs')),
      worker: paths.some((path) => path.includes('/assets/pdf.worker')),
      regularFont: paths.includes('/fonts/NotoSansSC-Regular.otf'),
      boldFont: paths.includes('/fonts/NotoSansSC-Bold.otf'),
    };
  }), { timeout: 20_000 }).toEqual({
    pdfmake: true,
    pdfjs: true,
    worker: true,
    regularFont: true,
    boldFont: true,
  });
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(`检索词-${marker}`);
  await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.locator('.document .markdown')).toContainText(`检索词-${marker}`);
  const cachedImage = page.locator('.markdown img');
  await expect(cachedImage).toBeVisible();
  await expect.poll(() => cachedImage.evaluate((element: HTMLImageElement) =>
    element.src.startsWith('blob:') && element.complete && element.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: '编辑模式', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.pressSequentially(`离线修改-${marker}`);
  await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-offline-library.png', fullPage: true });
  await context.setOffline(false);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toContain(`离线修改-${marker}`);
});

test('batch note actions and tag management preserve revisions', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const firstTitle = `批量一-${marker}`;
  const secondTitle = `批量二-${marker}`;
  const sourceTag = `来源-${marker}`;
  const addedTag = `批量-${marker}`;
  const renamedTag = `归并-${marker}`;
  await page.goto('/');
  for (const [title, content] of [[firstTitle, '第一篇'], [secondTitle, '第二篇']]) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title, content, tags: [sourceTag], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByRole('button').filter({ hasText: firstTitle })).toBeVisible();

  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: firstTitle }).click();
  await page.getByRole('button').filter({ hasText: secondTitle }).click();
  await page.getByRole('button', { name: '加标签' }).click();
  await page.getByRole('dialog').getByLabel('标签', { exact: true }).fill(addedTag);
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已为 2 篇笔记添加标签');

  await page.getByRole('button', { name: '管理标签' }).click();
  const manager = page.getByRole('dialog');
  await manager.screenshot({ path: 'test-results/tag-manager-default.png' });
  const sourceRow = manager.locator('.tag-manager-row').filter({ hasText: sourceTag });
  await sourceRow.getByRole('button', { name: '编辑', exact: true }).click();
  const editingRow = manager.locator('.tag-manager-row.editing');
  await expect(editingRow.getByLabel('重命名')).toBeFocused();
  await manager.screenshot({ path: 'test-results/tag-manager-editing.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await manager.screenshot({ path: 'test-results/tag-manager-editing-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await editingRow.locator('input').fill(renamedTag);
  await editingRow.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('更新了 2 篇笔记');
  await manager.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: firstTitle }).click();
  await page.getByRole('button').filter({ hasText: secondTitle }).click();
  await page.locator('.bulk-toolbar').getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已归档 2 篇笔记');
  const archived = await (await page.request.get(`/api/notes?view=archive&q=${encodeURIComponent(marker)}`)).json();
  expect(archived.notes).toHaveLength(2);
  for (const summary of archived.notes) {
    const full = await (await page.request.get(`/api/notes/${summary.id}`)).json();
    expect(full.note.tags).toEqual(expect.arrayContaining([addedTag, renamedTag]));
    expect(full.note.tags).not.toContain(sourceTag);
    expect(full.note.revision).toBeGreaterThan(2);
  }
});

test('a revoked offline session is removed as soon as the device reconnects', async ({ page, context }) => {
  await page.goto('/');
  const login = await page.request.post(`${origin}/api/login`, {
    headers: { Origin: origin },
    data: { username: 'tester', password: testPassword },
  });
  expect(login.status()).toBe(200);
  const liveSession = await login.json();
  await page.reload();
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();

  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'easynote_dev');
  expect(sessionCookie).toBeTruthy();
  const revoked = await fetch(`${origin}/api/logout`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: `${sessionCookie!.name}=${sessionCookie!.value}`,
      'X-CSRF-Token': liveSession.csrf,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(revoked.status).toBe(200);

  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible({ timeout: 10_000 });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await context.setOffline(false);
});

test('account security changes the password and logs out every device', async ({ page }) => {
  const newPassword = 'Changed-EasyNote-Password-842!';
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('当前密码').nth(0).fill(testPassword);
  await dialog.getByLabel('新密码', { exact: true }).fill(newPassword);
  await dialog.getByLabel('确认新密码').fill(newPassword);
  await dialog.getByRole('button', { name: '确认修改' }).click();
  await expect(page.getByRole('status')).toHaveText('密码已修改，其他设备已退出');
  await dialog.getByLabel('当前密码').nth(1).fill(newPassword);
  await dialog.getByRole('button', { name: '登出所有设备' }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await page.getByLabel('用户名').fill('tester');
  await page.getByLabel('密码').fill(newPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
});
