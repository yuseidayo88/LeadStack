import { expect, test } from "vitest";
import { directorySearch, phoneHref } from "@/lib/crm/search";
test("numeric queries search normalized phone and company number without extracting digits from names", () => {
  expect(directorySearch("companies", "０３（１２３４）−５６７８")).toContain(
    'search_phone.ilike."%0312345678%"',
  );
  expect(directorySearch("companies", "1234567890123")).toContain(
    'corporate_number.ilike."%1234567890123%"',
  );
  expect(directorySearch("companies", "第2営業所")).not.toContain(
    "search_phone",
  );
  expect(directorySearch("companies", "---")).not.toContain("search_phone");
  expect(directorySearch("contacts", "test@example.test")).toContain(
    'email.ilike."%test@example.test%"',
  );
});
test("search quotes PostgREST syntax and escapes LIKE metacharacters separately", () => {
  expect(directorySearch("companies", 'A,()"B')).toBe(
    'name.ilike."%A,()\\"B%"',
  );
  expect(directorySearch("companies", "%_\\")).toBe(
    'name.ilike."%\\\\%\\\\_\\\\\\\\%"',
  );
});
test("telephone links handle fullwidth digits and reject nonnumeric values", () => {
  expect(phoneHref("０３（１２３４）５６７８")).toBe("tel:0312345678");
  expect(phoneHref("+81-3-1234-5678")).toBe("tel:+81312345678");
  expect(phoneHref("未登録")).toBeUndefined();
});
