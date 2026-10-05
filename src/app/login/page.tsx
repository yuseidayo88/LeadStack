import { authEmailReady } from "@/lib/auth-email";
export const dynamic = "force-dynamic";
import { Suspense } from "react";
import { LoginForm } from "./login-form";
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm emailReady={authEmailReady()} />
    </Suspense>
  );
}
