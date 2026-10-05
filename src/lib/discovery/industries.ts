// Official Gbiz search classifications: https://info.gbiz.go.jp/ (gyoshu).
// These are JSIC divisions, not GEPS business_items procurement codes.
export const industryOptions = [
  ["A", "農業、林業"],
  ["B", "漁業"],
  ["C", "鉱業、採石業、砂利採取業"],
  ["D", "建設業"],
  ["E", "製造業"],
  ["F", "電気・ガス・熱供給・水道業"],
  ["G", "情報通信業"],
  ["H", "運輸業、郵便業"],
  ["I", "卸売業、小売業"],
  ["J", "金融業、保険業"],
  ["K", "不動産業、物品賃貸業"],
  ["L", "学術研究、専門・技術サービス業"],
  ["M", "宿泊業、飲食サービス業"],
  ["N", "生活関連サービス業、娯楽業"],
  ["O", "教育、学習支援業"],
  ["P", "医療、福祉"],
  ["Q", "複合サービス事業"],
  ["R", "サービス業（他に分類されないもの）"],
  ["S", "公務（他に分類されるものを除く）"],
  ["T", "分類不能の産業"],
].map(([value, label]) => ({ value, label }));

export function normalizeIndustries(values: string[] | null) {
  const codes = new Set<string>();
  const normalized = (s: string) =>
    s.normalize("NFKC").replace(/[、，,\s]/g, "");
  for (const raw of values ?? []) {
    const v = raw.trim();
    const match = /^([A-T])(?:\d+|[.．\s].*)?$/.exec(v);
    const option = match
      ? industryOptions.find((x) => x.value === match[1])
      : industryOptions.find((x) => normalized(x.label) === normalized(v));
    if (option) codes.add(option.value);
  }
  const matched = industryOptions.filter((x) => codes.has(x.value));
  return {
    codes: matched.map((x) => x.value),
    labels: matched.map((x) => x.label),
  };
}
