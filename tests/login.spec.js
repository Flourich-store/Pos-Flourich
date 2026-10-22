const { test, expect } = require('@playwright/test');
// Password asli TIDAK disimpan di repo. Set di mesin lokal sebelum run:
//   Windows (Git Bash/ PowerShell): set POS_KASIR_PASSWORD=xxx / $env:POS_KASIR_PASSWORD='xxx'
//   npx playwright test tests/login.spec.js
const LOGIN_PASSWORD = process.env.POS_KASIR_PASSWORD || 'ISI_PASSWORD_DI_ENV_LOKAL';

// ==========================================
// 1. TC-AUTH-01: Login Kasir Berhasil
// ==========================================
test('TC-AUTH-01: Login Kasir Berhasil', async ({ page }) => {
  await page.goto('https://flourich-store.github.io/Pos-Flourich/');

  await page.getByPlaceholder('Username').fill('kasir@gmail.com');
  await page.getByPlaceholder('Password').fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'MASUK' }).click();

  // Validasi: Tombol Logout muncul di dashboard
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 10000 });
});

// ==========================================
// 2. TC-AUTH-02: Login Gagal (Password Salah)
// ==========================================
test('TC-AUTH-02: Login Gagal dengan Password Salah', async ({ page }) => {
  await page.goto('https://flourich-store.github.io/Pos-Flourich/');

  const dialogPromise = page.waitForEvent('dialog').catch(() => null);

  await page.getByPlaceholder('Username').fill('kasir@gmail.com');
  await page.getByPlaceholder('Password').fill('passwordsalah123');
  await page.getByRole('button', { name: 'MASUK' }).click();

  const dialog = await dialogPromise;
  if (dialog) {
    expect(dialog.message()).toMatch(/gagal|salah/i);
    await dialog.accept();
  } else {
    await expect(page.getByText(/gagal|salah/i)).toBeVisible({ timeout: 10000 });
  }

  await expect(page.getByPlaceholder('Username')).toBeVisible();
});

// ==========================================
// 3. TC-AUTH-03: Logout Sistem Berhasil
// ==========================================
test('TC-AUTH-03: Logout Sistem Berhasil', async ({ page }) => {
  await page.goto('https://flourich-store.github.io/Pos-Flourich/');
  await page.getByPlaceholder('Username').fill('kasir@gmail.com');
  await page.getByPlaceholder('Password').fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'MASUK' }).click();

  const logoutButton = page.getByRole('button', { name: 'Keluar' });
  await expect(logoutButton).toBeVisible({ timeout: 10000 });

  await logoutButton.click();

  // Validasi: Form login muncul kembali
  await expect(page.getByPlaceholder('Username')).toBeVisible();
});