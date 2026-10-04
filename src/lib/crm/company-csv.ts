import { csvColumns, type CsvRecord } from "./company-csv-columns";
import { schemas } from "./schemas";
// RFC4180-style quoted fields, embedded newlines and escaped quotes; never coerce phone numbers.
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  function pushField() {
    row.push(field);
    field = "";
    closed = false;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw new Error("引用符の位置が正しくありません");
      quoted = true;
    } else if (c === ",") pushField();
    else if (c === "\n" || c === "\r") {
      pushField();
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      if (closed)
        throw new Error("閉じた引用符の後は区切りまたは改行にしてください");
      field += c;
    }
    if (rows.length > 501) throw new Error("1回の取込は500件までです");
  }
  if (quoted) throw new Error("閉じていない引用符があります");
  pushField();
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}
export function previewCsv(text: string): CsvRecord[] {
  const [headers, ...rows] = parseCsv(text);
  if (!headers || rows.length === 0)
    throw new Error("ヘッダーと企業データが必要です");
  if (rows.length > 500) throw new Error("1回の取込は500件までです");
  const keys = headers.map(
    (h) =>
      csvColumns[h.trim() as keyof typeof csvColumns] ||
      (Object.values(csvColumns).includes(h.trim() as never) ? h.trim() : null),
  );
  if (keys.some((k) => !k))
    throw new Error("対応していない列があります。見本の列名を使用してください");
  if (new Set(keys).size !== keys.length)
    throw new Error("同じ列が複数あります");
  if (!keys.includes("name")) throw new Error("会社名の列が必要です");
  return rows.map((cells, i) => {
    const data = Object.fromEntries(
      keys.map((key, j) => [key!, cells[j]?.trim() || null]),
    );
    const result = schemas.companies.safeParse(data);
    return {
      row: i + 2,
      data,
      errors: [
        ...(cells.length !== keys.length ? ["列数が一致しません"] : []),
        ...(!result.success
          ? result.error.issues.map(
              (e) =>
                `${Object.keys(csvColumns).find((k) => csvColumns[k as keyof typeof csvColumns] === e.path[0]) || String(e.path[0])}：入力形式を確認してください`,
            )
          : []),
      ],
    };
  });
}
