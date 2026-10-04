export const csvColumns = {
  会社名: "name",
  電話番号: "phone",
  法人番号: "corporate_number",
  業種: "industry",
  都道府県: "prefecture",
  市区町村: "city",
  住所: "address",
  Webサイト: "website_url",
  事業内容: "business_description",
  情報元: "source",
} as const;
export type CsvRecord = {
  row: number;
  data: Record<string, string | null>;
  errors: string[];
};
