import { z } from "zod";
export function tokyoDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function dayRange(date: string) {
  z.iso.date().parse(date);
  const start = new Date(`${date}T00:00:00+09:00`);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 86400000).toISOString(),
  };
}
