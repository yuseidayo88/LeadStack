import { z } from "zod";
const common = new Set([
  "password1234",
  "password12345",
  "password123456",
  "123456789012",
  "qwertyuiop12",
  "abcdefghijkl",
]);
export const newPassword = z
  .string()
  .min(12, "12文字以上で入力してください")
  .max(128)
  .refine(
    (v) => !/^(.{1,4})\1+$/u.test(v) && !common.has(v.toLowerCase()),
    "繰り返しやよくあるパスワードを避け、長いパスフレーズを設定してください",
  );
