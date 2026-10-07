// Open the same native disclosure controls a user uses before editing advanced fields.
export async function expandSearchOptions(page) {
  const advanced = page.locator("#discovery-advanced");
  await advanced.waitFor();
  if (!(await advanced.evaluate((element) => element.open)))
    await advanced.locator(":scope > summary").click();
  const saved = page
    .getByRole("region", { name: "保存した検索条件", exact: true })
    .locator("details");
  if (!(await saved.evaluate((element) => element.open)))
    await saved.locator(":scope > summary").click();
}
