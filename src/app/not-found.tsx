import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg space-y-4 p-10">
      <p className="text-xs text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">ページが見つかりません</h1>
      <Button asChild>
        <Link href="/dashboard">ダッシュボードへ</Link>
      </Button>
    </main>
  );
}
