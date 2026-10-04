"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert" className="mx-auto max-w-lg space-y-4 p-10">
      <h1 className="text-xl font-semibold">画面を表示できませんでした</h1>
      <p className="text-muted-foreground">
        通信状態を確認して、もう一度お試しください。
      </p>
      <Button onClick={reset}>再試行</Button>
    </div>
  );
}
